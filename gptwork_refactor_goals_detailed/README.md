# GPTWork/Codex 用户交付版返工 Goal 拆解包

目标仓库：`9018/gpt-codex-workspace`
日期：`2026-06-25`

## 当前验收结论

上一次 agent 声称完成，但按代码检查结果，核心交付目标没有完成。当前 main 分支仍然存在以下问题：

1. 没有 `backend/src/worktree-service.mjs`。
2. 没有 `backend/src/task-acceptance.mjs` / `task-verifier.mjs`。
3. 没有 `backend/src/task-retry.mjs` / `failure-classifier.mjs`。
4. `goal-queue.mjs` 仍使用 `config.defaultRepoPath` + repo lock + dirty check 串行阻塞普通任务。
5. `task-general-processor.mjs` 仍在普通 builder task 执行期间持有 canonical repo lock。
6. `task-run-setup.mjs` 仍把 `config.defaultRepoPath` 传给 prompt/run metadata，没有接入 `task.worktree.path`。
7. `task-final-writeback.mjs` 只写 fallback `result.json`，没有独立 verifier、没有 `verification.json`、没有 queue 同步完成。
8. context-index 有 MVP，但 zvec adapter 仍可能丢 text/tokens，检索仍强绑定当前 goal_id。
9. subagent 目前主要是结果结构校验，不是真实多 agent pipeline。

## 总目标

把项目改造成可以交付给真实用户的 GPTWork/Codex MVP：

```text
ChatGPT/MCP 下发 goal
  -> queue 创建 task
  -> 普通代码 task 创建独立 git worktree + branch
  -> Codex worker 在 worktree 内执行
  -> result.json/result.md 写回 goal workspace
  -> 独立 verifier 验收
  -> 自动 repair 一次
  -> finalizer 同步 task/goal/queue/agent 状态
  -> 生成可演示的三任务并发 demo
```

## 本包使用方式

优先执行顺序：

1. `01_SHORT_PROMPT_WITH_ACCEPTANCE.md`：给弱模型的简略总提示词。
2. `goals/P0_*.md`：必须全部完成，否则不算交付。
3. `goals/P1_*.md`：做完 P0 后再做。
4. `goals/P2_*.md`：用户侧 demo 和文档。
5. `acceptance/ACCEPTANCE_MATRIX.md`：最终验收表。

如果执行 agent 容易跑偏，建议每次只下发一个 P0 goal，完成并验收后再下一个。
