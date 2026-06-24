# GOAL-02：无副作用队列调度与多任务并发策略

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-01

## 背景

当前 goal-queue 的 startNextQueuedGoal 可能间接触发真实 worktree 创建，队列 eligibility check 有副作用。同时 execution lock 与 integration lock 未分层，影响多任务并发。

## 目标

让三人同时提交任务时，queue 只做 plan/check，多个无依赖任务可公平 assigned/running，真实副作用只发生在 worker materialization 阶段。

## 需要修改/新增的文件

- `backend/src/goal-queue.mjs`
- `backend/src/codex-worker-runner.mjs`
- `backend/src/worker-queue-counts.mjs`
- `backend/src/task-repo-resolution.mjs`
- `backend/src/repo-lock-diagnostics.mjs`
- `backend/test/goal-queue.test.mjs`
- `backend/test/workspace-task-tools.test.mjs`

## 具体实现步骤

1. startNextQueuedGoal 改为只调用 resolveTaskRepositoryPlan，不调用 ensureTaskWorktree/materializeTaskWorktree。
2. 新增 checkQueueCandidate({ item, state, repoPlan, locks })，返回 eligible 与 checks，不写文件、不改 git、不改 lock。
3. 队列只限制重复启动、dependency、worker capacity。不要因为同一 repo 有其他 task 执行就阻断；worktree 隔离允许并发执行。
4. 保留现有 round-robin bucket，并增加 user/workspace/repo fairness，避免单一用户任务饿死其他用户。
5. recheckTransientBlockedItems 只恢复 lock released、dependency completed、capacity available、stale lock reconciled 等瞬时原因，并设置 retry budget。

## 验收条件

- startNextQueuedGoal({dry_run:true}) 不写文件、不创建 worktree、不改 git。
- 多个无依赖任务可同时 assigned。
- waiting_for_lock 能在 lock release 后恢复。
- dependency 未完成时仍 blocked。
- queue 返回 checks 可解释启动/不启动原因。

## 建议测试命令

```bash
npm --prefix backend test -- goal-queue
npm --prefix backend test -- worker-queue-counts
npm --prefix backend run check:syntax
```

## 完成定义

队列调度成为无副作用 planner，worker 才负责真实执行副作用。
