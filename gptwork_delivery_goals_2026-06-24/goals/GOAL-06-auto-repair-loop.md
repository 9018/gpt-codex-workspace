# GOAL-06：自动 Repair Loop 与失败自愈

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-05

## 背景

系统能产生 repair_proposals/next_tasks，但未形成自动 repair 下发闭环。要实现任务最终自动验收完成，验收失败必须自动修复、再验收、再集成。

## 目标

实现 codex execution -> acceptance failed -> create repair goal/task -> execute repair -> re-run verification -> pass integration；超过预算再 waiting_for_review。

## 需要修改/新增的文件

- `backend/src/acceptance-policy.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/goal-task-creation.mjs`
- `backend/src/goal-task-task-factory.mjs`
- `backend/src/repair-loop.mjs`
- `backend/src/worker-queue-counts.mjs`
- `backend/test/repair-loop.test.mjs`
- `backend/test/goal-queue.test.mjs`

## 具体实现步骤

1. 为 task 增加 repair metadata：attempt、max_attempts、parent_task_id、root_task_id、repair_reason、acceptance_findings。
2. 新增 createRepairGoalFromFindings({ task, goal, findings, repairProposals })，repair prompt 必须包含原目标、已改摘要、失败 findings、必须修复项、禁止扩大范围、必须重跑验证。
3. repair worktree 优先复用原 task worktree；不存在时创建 gptwork/<root_task_id>-repair-<attempt>。
4. 新增 GPTWORK_MAX_REPAIR_ATTEMPTS 默认 2，超过后 waiting_for_review，并附 final findings、attempt summary、diff evidence、logs。
5. 对 ENOSPC、tmp 写失败、stale lock、no first output、codex timeout 做专门自愈：cleanup/reconcile/compact retry/partial result repair。
6. 新增 waiting_for_repair、repairing、repair_failed 状态，并让 worker 能拾取 repair queue item。

## 验收条件

- acceptance blocker/major 自动创建 repair task。
- repair task 与 parent/root task 链接清晰。
- repair attempt 不超过配置。
- repair 成功后原 goal 最终 completed 或进入 integration。
- repair 失败超过预算后 waiting_for_review 且证据完整。
- 至少覆盖 ENOSPC/stale lock/no first output 一个自愈测试。

## 建议测试命令

```bash
npm --prefix backend test -- repair-loop
npm --prefix backend test -- goal-queue
npm --prefix backend test -- codex-worker-runner-smoke
npm --prefix backend run check:syntax
```

## 完成定义

系统从发现验收失败升级为自动创建修复任务并尽力修到通过。
