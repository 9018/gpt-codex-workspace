---
title: 修复队列、验收与集成流程的功能/效率问题
mode: builder
source: chatgpt
priority: P0/P1
---

# 任务：修复 GPTWork backend 队列、验收与集成流程问题

## 背景

ChatGPT 对 `9018/gpt-codex-workspace` 当前 `main` 分支做了静态代码检查。当前 ChatGPT 执行环境无法解析 `github.com`，不能本地 clone 和运行测试；请 Codex 在本地 git 工作区完成修复、补测试和验证。

重点只考虑功能实现和效率问题，不把安全问题作为主要分析方向。

## 目标

修复 GPTWork backend 中队列启动、任务 mode 传播、验收证据、changed files 校验、config-only 集成以及队列吞吐相关问题。

## 需要修复的问题

### 1. 队列启动 task 时不要强制 `mode=builder`

位置：`backend/src/goal-queue.mjs`

当前 `startNextQueuedGoal()` 创建 task 时写死：

```js
mode: "builder"
```

这会导致 queued goal 原本的 `deploy` / `admin` / 其他 mode 被降级为 builder。

要求：

- 保留 goal 自身的 `mode`。
- 如果 goal 没有 mode，才 fallback 到 `builder`。
- 补充 regression test，覆盖 deploy/admin goal 入队后创建 task 时 mode 不丢失。

### 2. config-only 变更应进入 integration

位置：`backend/src/acceptance-agent.mjs`

当前 `hasCodeOrConfigOrRuntimeChanges()` 把 allConfig 当作无需 integration：

```js
if (allDocs || allConfig) return false;
```

要求：

- docs-only 可跳过 integration。
- `.json` / `.yaml` / `.yml` 等 config-only 改动应视为需要 integration。
- 补充 regression test：config-only changed_files 返回 true，docs-only 返回 false。

### 3. commit/patch evidence 不要用 `git log -1` 误判

位置：`backend/src/acceptance-agent.mjs`

当前 `buildEvidence()` 用 `git log --oneline -1` 判断 `commit_exists`。这只证明仓库有提交，不证明本次 task 有提交或 patch evidence。

要求：

- 基于 task worktree 的 base/head 差异或显式 `result.commit` / `result.patch_evidence` 判断。
- 如果已有 `worktree_lifecycle.base_sha` 或 task/result 中可取得 base_sha，应使用 `<base_sha>..HEAD` 检查本次任务变更。
- 不要让普通仓库的历史提交自动满足 `commit_or_patch_evidence`。
- 补充 regression test，覆盖“仓库有历史提交但本次无 task commit/patch”不能通过 evidence。

### 4. 拆分 git changed files 与 result changed files

位置：`backend/src/acceptance-agent.mjs`

当前 `buildEvidence()` 先从 git diff 得到 `evidence.changed_files`，随后如果 `result.json` 存在 `changed_files`，又覆盖同一字段，导致 `changed_files_match_git` 可能变成 result 自证。

要求：

- 拆分字段，例如：
  - `evidence.git_changed_files`
  - `evidence.result_changed_files`
  - `evidence.changed_files` 可保留为兼容字段，但不能破坏 git 校验。
- `changed_files_match_git` 必须比较 result 文件是否存在于 git diff / task diff 中。
- 补充 regression test：result.json 声明的文件不在 git diff 中时应产生 `changed_files_mismatch`。

### 5. 单个坏 queue item 不应阻塞后续可执行 item

位置：`backend/src/goal-queue.mjs`

当前 `startNextQueuedGoal()` 在遇到 `worktree_lifecycle.ok === false` 时直接 return，导致后续 queue item 即使可执行也不会被扫描。

要求：

- 当前 item 标记 blocked 后继续扫描后续 eligible items。
- `startQueuedGoals()` 不应因为一个 blocked item 过早停止批量启动。
- 返回结果中保留 blocked summary，便于诊断。
- 补充 regression test：第一个 queue item worktree error，第二个正常 item 仍能启动。

### 6. 控制跨 goal context retrieval 的全量扫描成本

位置：`backend/src/context-index/retriever.mjs` / `backend/src/context-index/zvec-store.mjs`

当前 `retrieveContext()` 允许 `goalId=null`，local fallback 会扫描所有 goal index。goal 数量增长后可能拖慢 open context / retrieval。

要求：

- 为 local fallback 增加扫描上限，例如 `maxGoalsScanned`，默认 50 或合理值。
- 优先扫描最近更新时间或目录 mtime 较新的 goal index。
- 保持指定 `goalId` 的精确检索不受影响。
- 补充轻量测试或单元测试。

## 验证要求

在本地 git 工作区执行：

```bash
cd backend
npm run check:syntax
npm run check:imports
npm test
npm run release:delivery-check
```

如果部分测试因环境依赖无法运行，请在结果中说明具体失败命令、错误摘要、是否与本次改动相关。

## 输出要求

完成后请在 GitHub 同步结果或任务结果中回复：

- 修改文件列表
- 每个问题的修复摘要
- 新增/修改的测试列表
- 验证命令及结果
- 如有未完成项，明确说明原因和后续建议
