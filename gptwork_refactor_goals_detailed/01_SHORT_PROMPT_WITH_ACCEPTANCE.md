# 简略提示词：GPTWork/Codex 用户交付版返工

你正在修改仓库 `9018/gpt-codex-workspace`。上一个 agent 没有完成核心 goal。不要继续做 restart marker、README 修补或空泛重构。现在必须按代码实现用户交付版 MVP。

## 必须完成的 P0

1. 新增 `backend/src/worktree-service.mjs`：实现每个普通代码 task 创建独立 git worktree + branch。
2. 修改 task 创建/持久化：task 必须有 `execution_mode/worktree/attempt/max_attempts` 字段。
3. 修改 `goal-queue.mjs`：普通 builder task 不再因 canonical repo lock 全部串行阻塞；依赖满足后创建 worktree 并启动。
4. 修改 `task-general-processor.mjs`、`task-run-setup.mjs`、Codex 执行链：worker cwd 必须使用 `task.worktree.path`。
5. 新增 `backend/src/task-acceptance.mjs`：completed 前必须独立验收 `result.json`、`verification.passed`、`git diff --check`、项目测试/构建命令。
6. 新增 `backend/src/failure-classifier.mjs` 和 `backend/src/task-retry.mjs`：result JSON 错误、测试失败、timeout 至少自动 repair 一次；仍失败进入 `waiting_for_review`。
7. 修改 `task-final-writeback.mjs`：写 `verification.json`，同步 task/goal/queue 状态，并触发 `autoStartNextOnTaskCompleted`。
8. 新增测试：`worktree-service.test.mjs`、`task-acceptance.test.mjs`、`multi-task-flow.test.mjs` 或等价测试，证明 3 个普通任务创建 3 个 worktree。

## 硬性验收标准

没有以下文件，不算完成：

```text
backend/src/worktree-service.mjs
backend/src/task-acceptance.mjs
backend/src/failure-classifier.mjs
backend/src/task-retry.mjs
```

普通 builder task 仍在整个执行期持有 canonical repo lock，不算完成。
Codex worker cwd 仍是 `config.defaultRepoPath`，不算完成。
只写 `result.json` 但不运行独立 verifier，不算完成。
`verification.passed !== true` 还能 completed，不算完成。
没有三任务 worktree demo/test，不算完成。
只改文档或 README，不算完成。

## 最终输出

完成后输出：修改文件列表、新增文件列表、关键实现说明、测试命令和结果、未完成项。不要声称完成未做的内容。
