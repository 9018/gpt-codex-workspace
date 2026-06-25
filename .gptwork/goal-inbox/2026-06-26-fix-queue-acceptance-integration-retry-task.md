---
title: Retry 修复队列、验收与集成流程的功能/效率问题
mode: builder
source: chatgpt
priority: P0/P1
retry_of_issue: 135
---

# 任务：修复 GPTWork backend 队列、验收与集成流程问题

这是 #135 的 retry 下发。此前 #135 dispatch 失败原因是 `GPTWORK_MCP_URL is not configured`；用户已配置后要求重新触发。

重点只考虑功能实现和效率问题，不把安全问题作为主要分析方向。

## 修复范围

1. `backend/src/goal-queue.mjs`
   - `startNextQueuedGoal()` 创建 task 时不要强制 `mode: "builder"`。
   - 应保留 goal 自身 mode；goal 无 mode 时才 fallback builder。
   - 增加 regression test 覆盖 deploy/admin goal 入队后创建 task 时 mode 不丢失。

2. `backend/src/acceptance-agent.mjs`
   - `hasCodeOrConfigOrRuntimeChanges()` 中 docs-only 可跳过 integration，但 `.json` / `.yaml` / `.yml` config-only 改动应进入 integration。
   - 增加 regression test：config-only 返回 true，docs-only 返回 false。

3. `backend/src/acceptance-agent.mjs`
   - commit/patch evidence 不要用 `git log -1` 判断。它只能证明仓库有历史提交，不能证明本次 task 有提交或 patch evidence。
   - 基于 task worktree 的 base/head 差异，或显式 `result.commit` / `result.patch_evidence` 判断。
   - 增加 regression test：仓库有历史提交但本次无 task commit/patch 时不能通过 evidence。

4. `backend/src/acceptance-agent.mjs`
   - 拆分 git changed files 与 result changed files，例如 `git_changed_files`、`result_changed_files`。
   - `changed_files_match_git` 必须比较 result 声明文件是否存在于 git diff / task diff 中，不能让 result.json 覆盖 git evidence 后自证。
   - 增加 regression test：result.json 声明的文件不在 git diff 中时应产生 mismatch。

5. `backend/src/goal-queue.mjs`
   - 单个坏 queue item 不应阻塞后续可执行 item。
   - 遇到 `worktree_lifecycle.ok === false` 时，当前 item 标记 blocked 后继续扫描后续 eligible items。
   - `startQueuedGoals()` 不应因为一个 blocked item 过早停止批量启动。
   - 增加 regression test：第一个 queue item worktree error，第二个正常 item 仍能启动。

6. `backend/src/context-index/retriever.mjs` / `backend/src/context-index/zvec-store.mjs`
   - 控制 `goalId=null` 时 local fallback 跨 goal retrieval 全量扫描成本。
   - 增加 `maxGoalsScanned`，默认 50 或合理值。
   - 优先扫描最近更新时间或目录 mtime 较新的 goal index。
   - 指定 `goalId` 的精确检索不受影响。
   - 增加轻量测试。

## 验证要求

在本地 git 工作区执行：

```bash
cd backend
npm run check:syntax
npm run check:imports
npm test
npm run release:delivery-check
```

如果部分命令因环境依赖无法运行，请说明具体失败命令、错误摘要、是否与本次改动相关。

## 输出要求

完成后回复：

- 修改文件列表
- 每个问题的修复摘要
- 新增/修改的测试列表
- 验证命令及结果
- 如有未完成项，明确说明原因和后续建议
