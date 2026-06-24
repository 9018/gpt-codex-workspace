# GOAL-07：Integration Queue、Merge Lock 与最终完成

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-01, GOAL-05, GOAL-06

## 背景

Git worktree 解决执行隔离，不解决最终 merge/push 冲突。三人并发任务都通过本地验证后，仍需要同一 repo/target_branch 串行集成。

## 目标

实现 accepted task -> waiting_for_integration -> acquire integration lock(repo_id+target_branch) -> rebase/merge -> release checks -> push/open PR -> completed。

## 需要修改/新增的文件

- `backend/src/repo-lock-lifecycle.mjs`
- `backend/src/repo-lock-paths.mjs`
- `backend/src/repo-lock-diagnostics.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/goal-queue.mjs`
- `backend/src/integration-queue.mjs`
- `backend/src/git-integration-runner.mjs`
- `backend/test/integration-queue.test.mjs`
- `backend/test/repo-lock.test.mjs`

## 具体实现步骤

1. 新增 integration lock，key=integration:<repo_id>:<target_branch>，不要复用 task worktree execution lock。
2. acceptance passed 且有代码改动时，task.status=waiting_for_integration；docs/noop 可按 profile 直接 completed 或同样 integration。
3. 新增 runIntegrationQueue({ limit, concurrency: 1 })，同一 target branch 每次只处理一个任务。
4. 支持 GPTWORK_INTEGRATION_MODE=local_merge|push_branch|open_pr|none，建议默认 push_branch/open_pr，不直接写 main。
5. merge/rebase conflict 时生成 integration repair task，附 conflict files、git status、merge output，不标 completed。
6. 支持 GPTWORK_INTEGRATION_CHECK_COMMANDS，integration check 失败自动 repair。
7. 只有 integration 成功后才 mark task/goal completed、sync GitHub/Bark/ChatGPT、cleanup worktree。

## 验收条件

- 同一 repo/target_branch 同时只有一个 integration running。
- accepted code task 进入 waiting_for_integration。
- integration 成功后才 completed。
- merge conflict 自动进入 repair。
- integration check 失败自动 repair。
- integration lock stale 可 reconcile。

## 建议测试命令

```bash
npm --prefix backend test -- integration-queue
npm --prefix backend test -- repo-lock
npm --prefix backend run check:syntax
```

## 完成定义

多任务可并发开发，但最终合并/推送/验收集成阶段严格串行且可恢复。
