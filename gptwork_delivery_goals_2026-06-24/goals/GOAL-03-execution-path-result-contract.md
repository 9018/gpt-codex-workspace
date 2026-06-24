# GOAL-03：执行路径、结果路径与 result contract 修正

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-01

## 背景

executeCodexTaskRun 支持 executionCwd，但 result.json 仍基于 workspace.root 拼接。启用 task worktree 后必须明确区分代码执行目录、goal 状态目录和 result JSON 绝对路径。

## 目标

让 Codex 在 task worktree 改代码，在 canonical goal dir 写 result.json/result.md，验收始终检查正确 worktree。

## 需要修改/新增的文件

- `backend/src/codex-prompt-builder.mjs`
- `backend/src/task-run-setup.mjs`
- `backend/src/task-codex-execution.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/task-result-status.mjs`
- `backend/test/task-final-writeback.test.mjs`
- `backend/test/codex-worker-runner-smoke.test.mjs`

## 具体实现步骤

1. buildCodexPrompt 增加 executionRepoPath、goalStateDir、resultJsonPath、resultMdPath、canonicalRepoPath、taskWorktreePath。
2. Prompt 明确写：Edit code only under executionRepoPath；Read goal files from goalStateDir；Write result.json exactly to resultJsonPath。
3. executeCodexTaskRun 解析 result 时使用传入的 resultJsonPath，不再自行通过 workspaceRoot 拼接。
4. validateResultContract 优先检查 resolvedRepo.task_worktree_path，其次 canonical_repo_path，避免 canonical dirty 误判。
5. changed_files 必须规范为 repo root 相对路径；禁止绝对路径、..；并与 git diff/commit 对账。
6. finalizer 保存 implementation-diff.patch 和 verification.log，失败任务尤其要保留证据。

## 验收条件

- Codex prompt 明确包含 execution repo path 和 result path。
- result parser 不再依赖 workspaceRoot 自行推断。
- completed task 检查 task worktree clean。
- changed_files 与真实 git 状态一致。
- failed task 保留 diff evidence。

## 建议测试命令

```bash
npm --prefix backend test -- task-final-writeback
npm --prefix backend test -- codex-worker-runner-smoke
npm --prefix backend run check:syntax
```

## 完成定义

路径契约明确，Codex 不会把代码改到 canonical repo，也不会把结果写错位置。
