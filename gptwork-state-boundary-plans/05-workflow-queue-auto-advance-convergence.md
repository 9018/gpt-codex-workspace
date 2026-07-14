# Workflow Queue Auto-Advance Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Goal、Queue、Workflow、Workstream 只根据 Task canonical outcome 和标准领域事件推进，消除各层重复推导验收结果。

**Architecture:** 新增 projection service 消费 Task transition event。Queue、Goal、Workflow、Workstream 各自维护投影，但不再从 changed_files/tests/raw findings 重新决定 Task 是否完成。历史任务无 unified decision 时走显式 legacy adapter。

**Tech Stack:** Node.js ESM、现有 goal queue/workflow/workstream state、Task transition events。

## Global Constraints

- `task.result.unified_decision` 优先级最高。
- Projection 不覆盖 Task。
- Queue 只决定是否可调度，不决定验收。
- Workflow proposal 不重新运行 acceptance。
- 所有 auto advance 幂等。
- 兼容无 unified decision 的历史任务，但必须标记 legacy source。

---

## 文件结构

### 新建

- `backend/src/projections/task-outcome-projector.mjs`
- `backend/src/projections/goal-status-projector.mjs`
- `backend/src/projections/queue-status-projector.mjs`
- `backend/src/projections/workflow-status-projector.mjs`
- `backend/src/projections/workstream-status-projector.mjs`
- `backend/src/projections/legacy-outcome-adapter.mjs`
- `backend/test/task-outcome-projector.test.mjs`
- `backend/test/projection-idempotency.test.mjs`

### 修改

- `backend/src/goal-queue.mjs`
- `backend/src/workflow-state-service.mjs`
- `backend/src/tool-groups/workflow-tools-group.mjs`
- `backend/src/goal-convergence.mjs`
- `backend/src/closure/continuation-flow.mjs`
- `backend/src/workstream/task-outcome-summary.mjs`
- `backend/src/orchestration/workstream-tick.mjs`
- `backend/src/pipeline-orchestration.mjs`
- `backend/src/task-final-writeback.mjs`

---

## Task 1：定义 canonical outcome view

**Files:**
- Create: `backend/src/projections/task-outcome-projector.mjs`
- Create: `backend/src/projections/legacy-outcome-adapter.mjs`
- Test: `backend/test/task-outcome-projector.test.mjs`

API：

```js
deriveCanonicalTaskOutcome(task)
```

输出：

```js
{
  source: "unified_decision" | "legacy_adapter" | "none",
  status:
    "completed" |
    "waiting_for_repair" |
    "waiting_for_integration" |
    "waiting_for_human_review" |
    "failed" |
    "blocked" |
    "unknown",
  accepted: boolean,
  terminal: boolean,
  safe_to_auto_advance: boolean,
  unblock_dependents: boolean,
  hold_queue: boolean,
  requires_repair: boolean,
  requires_integration: boolean,
  requires_human: boolean,
  decision_digest: string | null,
}
```

Canonical path：

```js
const ud = task.result?.unified_decision;
if (ud?.status) {
  return {
    source: "unified_decision",
    status: ud.status,
    accepted: ud.status === "completed" && ud.blocking_passed !== false,
    terminal: isCanonicalTerminal(ud.status),
    safe_to_auto_advance: ud.safe_to_auto_advance === true,
    unblock_dependents: ud.queue_effect?.unblock_dependents === true,
    hold_queue: ud.queue_effect?.hold_queue === true,
    ...
  };
}
```

Legacy path必须集中在一个文件，不能散落：

```js
deriveLegacyOutcome(task) {
  // only for records without unified_decision
  // uses finalizer_decision, closure_decision, task status
  // never interprets raw findings as completed if explicit blocker exists
}
```

所有消费者只调用 `deriveCanonicalTaskOutcome()`。

---

## Task 2：Goal projector

**Files:**
- Create: `backend/src/projections/goal-status-projector.mjs`
- Modify: `backend/src/goal-convergence.mjs`
- Test: `backend/test/continuation-flow.test.mjs`
- Test: `backend/test/p0-afc4-finalizer-apply-decision.test.mjs`

API：

```js
projectGoalFromTaskOutcome({
  state,
  task,
  outcome,
  transitionEvent,
})
```

规则：

- completed → goal completed
- waiting_for_repair → goal assigned/open，不 terminal
- waiting_for_integration → goal running
- human required → goal waiting_for_review 或专用 goal status
- failed terminal → goal failed
- unknown → no mutation

幂等键：

```js
goal.metadata.last_projected_task_decision_digest
```

若 digest 相同，返回 `applied:false`。

`goal-convergence.mjs` 改为只包装 projector，不再解释 verification/blockers。

---

## Task 3：Queue projector

**Files:**
- Create: `backend/src/projections/queue-status-projector.mjs`
- Modify: `backend/src/goal-queue.mjs`
- Test: `backend/test/queue-auto-advance.test.mjs`
- Test: `backend/test/goal-queue.test.mjs`

规则：

```js
switch (outcome.status) {
  case "completed":
    currentQueueItem.status = "completed";
    if (outcome.unblock_dependents) markDependentsReady();
    break;
  case "waiting_for_repair":
    currentQueueItem.status = "blocked";
    currentQueueItem.blocked_reason = "task_requires_repair";
    break;
  case "waiting_for_integration":
    currentQueueItem.status = "running";
    currentQueueItem.blocked_reason = "awaiting_integration";
    break;
  case "waiting_for_human_review":
    currentQueueItem.status = "blocked";
    currentQueueItem.blocked_reason = "human_review_required";
    break;
  case "failed":
    currentQueueItem.status = "failed";
    break;
}
```

删除/替换以下重复判断：

- 根据 changed_files 判断完成。
- 根据 verification passed 自行放行。
- 根据 task.status completed 且没有 unified decision 之外的直接主路径。
- 多处读取 `queue_effect` 的重复代码。

依赖 gate：

```js
resolveQueueDependencyState(prerequisiteTask) {
  const outcome = deriveCanonicalTaskOutcome(prerequisiteTask);
  return {
    satisfied: outcome.unblock_dependents,
    source: outcome.source,
    detail: ...
  };
}
```

---

## Task 4：Workflow projector 与 proposal 简化

**Files:**
- Create: `backend/src/projections/workflow-status-projector.mjs`
- Modify: `backend/src/workflow-state-service.mjs`
- Modify: `backend/src/tool-groups/workflow-tools-group.mjs`
- Test: `backend/test/workflow-tools-group.test.mjs`
- Test: `backend/test/projection-idempotency.test.mjs`

Workflow state 新增：

```js
{
  last_projected_task_id,
  last_projected_decision_digest,
  last_projected_outcome,
  projection_history: [],
}
```

`workflow_status`：

- 只读 Task canonical outcome。
- 不保存状态，除非调用 projector。
- 返回：
  ```js
  {
    canonical_outcome,
    projection_status,
    next_safe_action,
  }
  ```

`workflow_advance`：

```js
const outcome = deriveCanonicalTaskOutcome(task);

if (!outcome.safe_to_auto_advance) {
  return proposal("needs_decision", ...);
}

if (outcome.requires_repair) {
  return proposal("create_repair_task", ...);
}

if (outcome.requires_integration) {
  return proposal("run_integration", ...);
}

if (outcome.accepted) {
  return proposal("advance_to_next_goal", ...);
}
```

删除：

- `normalizeFromUnifiedDecision()` 的重复映射，改为调用 canonical view。
- raw acceptance findings 的主流程判断。
- `task.status !== completed && task.status === failed` 这类可疑条件，改成 outcome switch。
- workflow 自动 accept 直接写 task 的逻辑。

Manual verdict：

- 作为新的“人工决定事件”，必须先生成或覆盖 canonical decision，而不是 Workflow 私有结果与 Task 结果并存。
- 新增：
  ```js
  applyManualCanonicalDecision(taskId, verdict, note)
  ```
  内部调用 finalizer/manual decision adapter + task transition service。

---

## Task 5：Workstream projector

**Files:**
- Create: `backend/src/projections/workstream-status-projector.mjs`
- Modify: `backend/src/workstream/task-outcome-summary.mjs`
- Modify: `backend/src/orchestration/workstream-tick.mjs`
- Modify: `backend/src/pipeline-orchestration.mjs`
- Test: `backend/test/workstream-acceptance-controller.test.mjs`
- Test: `backend/test/pipeline-orchestration.test.mjs`

每个 DAG node 增加：

```js
{
  task_id,
  projected_outcome_status,
  projected_decision_digest,
  acceptance_passed,
  dependency_released,
}
```

Join 只看 node projection：

- all_completed → 所有 outcome terminal
- all_passed → 所有 outcome accepted
- any_passed → 任一 accepted
- manual_release → flag

不直接读取 Task raw result。

---

## Task 6：瘦身 task-final-writeback

**Files:**
- Modify: `backend/src/task-final-writeback.mjs`
- Test: `backend/test/task-final-writeback.test.mjs`

目标：

- Final writeback 只负责构造 finalizer input、生成 unified decision、调用 transition service。
- Goal、Queue、Workflow 更新移到 projector。
- 将约 1200+ 行文件拆为：
  - `task-finalization/task-finalizer-input-builder.mjs`
  - `task-finalization/task-result-builder.mjs`
  - `task-finalization/task-finalization-service.mjs`
  - `task-finalization/task-finalization-effects.mjs`

伪代码：

```js
const finalization = await taskFinalizationService.finalize({
  task,
  executionEvidence,
  acceptanceContract,
});

const transition = await taskTransitionService.transitionTask({
  ...canonicalDecisionCommand(finalization),
});

await taskOutcomeProjector.project({
  task: transition.task,
  transitionEvent: transition.event_record,
});
```

不要在同一个 `store.mutate()` 中同时改 Task、Queue、Goal、Workflow。

投影失败：

- Task canonical transition 保持成功。
- 记录 projection retry item。
- reconciler 后续补齐。

---

## Task 7：Projection dispatcher

**Files:**
- Create: `backend/src/projections/task-outcome-projection-dispatcher.mjs`
- Modify: lifecycle event composition root
- Test: `backend/test/projection-idempotency.test.mjs`

```js
async function onTaskTransition(event, task) {
  if (!eventProducesCanonicalOutcome(event)) return;

  const outcome = deriveCanonicalTaskOutcome(task);

  const results = await Promise.allSettled([
    goalProjector.project(...),
    queueProjector.project(...),
    workflowProjector.project(...),
    workstreamProjector.project(...),
  ]);

  await projectionCheckpointStore.record({
    task_id: task.id,
    transition_id: event.id,
    decision_digest: outcome.decision_digest,
    results,
  });
}
```

不要因为一个 projector 失败回滚 Task transition。

---

## Task 8：验收矩阵

场景：

1. TUI/Exec completed → Goal completed → Queue dependents ready → Workflow advance proposal。
2. waiting_for_repair → 不启动 downstream。
3. waiting_for_integration → Queue 不误 completed。
4. human review → 不自动推进。
5. unified decision completed + stale raw blocker → 仍按 completed。
6. unified decision failed + task.status completed（脏历史）→ projector 以 unified decision 为准并交 reconciler 修 Task。
7. 重复 transition event → 所有 projection 幂等。
8. 一个 projector 失败 → 其他成功，后续可补偿。

运行：

```bash
cd backend
node --test \
  test/task-outcome-projector.test.mjs \
  test/projection-idempotency.test.mjs \
  test/queue-auto-advance.test.mjs \
  test/goal-queue.test.mjs \
  test/workflow-tools-group.test.mjs \
  test/continuation-flow.test.mjs \
  test/workstream-acceptance-controller.test.mjs \
  test/pipeline-orchestration.test.mjs \
  test/task-final-writeback.test.mjs
npm run check:syntax
npm run check:imports
```
