# 02 持久化 Progression Command 与唯一执行器方案

## 目标

将 auto-complete、auto-repair、auto-integrate、queue-next、restart、successor 创建等动作统一为持久化、幂等、可认领、可恢复的命令，消除多个 reconciler 各自修改状态的问题。

## 主要文件

### 新增

- `backend/src/progression/progression-command-schema.mjs`
- `backend/src/progression/progression-command-store.mjs`
- `backend/src/progression/progression-command-builder.mjs`
- `backend/src/progression/progression-command-actuator.mjs`
- `backend/src/progression/progression-command-handlers.mjs`
- `backend/src/progression/progression-command-reconciler.mjs`
- `backend/src/progression/progression-idempotency.mjs`
- `backend/src/progression/progression-errors.mjs`

### 修改

- `backend/src/pipeline-orchestration.mjs`
- `backend/src/task-convergence.mjs`
- `backend/src/queue-reconciler.mjs`
- `backend/src/runtime-patrol-loop.mjs`
- `backend/src/repair-loop.mjs`
- `backend/src/auto-integration-completion.mjs`
- `backend/src/integration-backlog-reconciler.mjs`
- `backend/src/codex-worker-runner.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/state-store.mjs`
- `backend/src/runtime-config.mjs`

### 测试

- 新增 `backend/test/progression-command-store.test.mjs`
- 新增 `backend/test/progression-command-actuator.test.mjs`
- 新增 `backend/test/progression-command-idempotency.test.mjs`
- 新增 `backend/test/progression-command-recovery.test.mjs`
- 新增 `backend/test/progression-command-e2e.test.mjs`

## 命令模型

```js
{
  schema_version: 1,
  id: "pcmd_<uuid>",
  task_id,
  goal_id,
  decision_revision,
  action,
  payload,
  preconditions,
  idempotency_key,
  status: "pending|claimed|applied|failed|superseded",
  lease: {
    owner,
    claimed_at,
    expires_at
  },
  attempt,
  max_attempts,
  result,
  last_error,
  created_at,
  updated_at
}
```

支持动作：

```text
complete_task
propagate_goal
advance_queue
create_repair_task
queue_repair_task
inherit_repair_result
integrate_change
restart_runtime
create_successor_task
reconcile_workstream
cleanup_worktree
```

## 实施任务

### Task 1：命令 schema 与校验

每个 action 使用明确 payload schema。禁止自由 JSON。

例如：

```js
const ACTION_SCHEMAS = {
  create_repair_task: {
    required: ["parent_task_id", "blockers", "repair_budget_revision"]
  },
  integrate_change: {
    required: ["task_id", "source_commit", "target_branch"]
  }
};
```

### Task 2：命令持久化

在 state store 中新增：

```js
state.progression_commands = {};
```

提供接口：

```js
createCommand(command)
claimNextCommand({ owner, now, leaseMs })
markApplied({ id, owner, result })
markFailed({ id, owner, error, retryAt })
supersedeStaleCommands({ taskId, decisionRevision })
```

所有写操作使用已有原子 state update 机制。

### Task 3：幂等键

格式：

```text
<task_id>:<decision_revision>:<action>:<payload_digest>
```

`createCommand` 遇到相同键时返回现有命令，不新建。

### Task 4：构建器

`pipeline-orchestration.convergeBacklog()` 保持纯决策，新增：

```js
buildProgressionCommands(validatedDecision)
```

示例：

```js
if (decision.requires_repair) {
  commands.push(createRepairCommand(decision));
}
if (decision.status === "completed") {
  commands.push(completeTaskCommand(decision));
  commands.push(advanceQueueCommand(decision));
}
```

### Task 5：唯一 actuator

循环：

```js
while (capacityAvailable()) {
  const command = await store.claimNextCommand(...);
  if (!command) break;
  try {
    assertPreconditions(command);
    const result = await handlers[command.action](command);
    await store.markApplied(...);
  } catch (error) {
    await classifyAndPersistFailure(command, error);
  }
}
```

actuator 是唯一允许执行 progression effect 的模块。

### Task 6：handler 分层

每个 handler 只执行一个 effect：

```js
handlers.complete_task
handlers.advance_queue
handlers.create_repair_task
handlers.integrate_change
```

handler 不再自行推导“下一步是什么”。

### Task 7：迁移 reconciler

- patrol 只发现事实并补建缺失 command。
- queue reconciler 只对账 command 与 projection。
- repair loop 只消费 repair command。
- integration reconciler 只消费 integrate command。
- final writeback 只写 canonical decision 和创建 commands。

禁止这些模块直接完成邻域状态写入。

### Task 8：租约和崩溃恢复

命令 claimed 后服务崩溃，租约过期自动回到 pending。

对于可能已经执行成功但未 markApplied 的动作，handler 必须先检查外部事实：

```js
if (alreadyIntegrated(sourceCommit, targetBranch)) {
  return { already_applied: true };
}
```

### Task 9：过期决策保护

执行前校验：

```js
currentDecision.revision === command.decision_revision
```

不一致则标记 `superseded`，不得执行。

### Task 10：对账器

周期检查：

- completed decision 但没有 complete command。
- applied integrate command 但 projection 未更新。
- repair command applied 但 repair task 缺失。
- command 长时间 claimed。
- 同一 idempotency key 出现重复。

对账器只补命令或重置租约，不直接执行 effect。

## 验收命令

```bash
cd backend
node --test test/progression-command-store.test.mjs
node --test test/progression-command-actuator.test.mjs
node --test test/progression-command-idempotency.test.mjs
node --test test/progression-command-recovery.test.mjs
node --test test/progression-command-e2e.test.mjs
npm run test:state-boundary
npm run check:syntax
npm run check:imports
```

## 完成标准

- 任一自动动作都有 command 记录。
- 重复事件不会重复创建 repair、重复合并或重复推进 queue。
- actuator 崩溃后可自动恢复。
- reconciler 不再直接修改跨域状态。
