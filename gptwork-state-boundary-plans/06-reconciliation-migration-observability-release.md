# Reconciliation Migration Observability and Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为新状态边界提供遗留数据迁移、运行时修复、可观测性、发布门和安全回滚，确保改造不会把已有任务与 worktree 状态进一步打乱。

**Architecture:** 先只读 census，再引入 shadow comparison，之后逐步启用 canonical transitions。Reconciler 只修投影漂移与明显结构冲突，不重新做验收。所有修复写审计日志和 checkpoint。

**Tech Stack:** Node.js ESM、现有 recovery plane、runtime reconciler、release gate、JSON reports。

## Global Constraints

- 默认 dry-run。
- 不删除 active worktree。
- 不自动重写无把握的历史 acceptance。
- 所有迁移可重复运行。
- 所有 apply 操作先备份。
- 发布采用 feature flags 和分阶段启用。
- 回滚不丢新 execution/evidence 文件。

---

## 文件结构

### 新建

- `backend/src/migrations/task-state-boundary-census.mjs`
- `backend/src/migrations/task-state-boundary-migration.mjs`
- `backend/src/migrations/execution-record-backfill.mjs`
- `backend/src/reconciliation/canonical-state-reconciler.mjs`
- `backend/src/reconciliation/projection-retry-store.mjs`
- `backend/src/diagnostics/state-boundary-health.mjs`
- `backend/scripts/state-boundary-census.mjs`
- `backend/scripts/state-boundary-migrate.mjs`
- `backend/scripts/state-boundary-release-gate.mjs`
- `backend/test/state-boundary-census.test.mjs`
- `backend/test/canonical-state-reconciler.test.mjs`
- `backend/test/state-boundary-release-gate.test.mjs`

### 修改

- `backend/src/runtime-reconciler.mjs`
- `backend/src/runtime-reconciler-stale-tasks.mjs`
- `backend/src/runtime/task-runtime-reconciler.mjs`
- `backend/src/runtime-watch-diagnostics.mjs`
- `backend/src/runtime-reconciler-repo-locks.mjs`
- `backend/src/stale-state-sweeper.mjs`
- `backend/src/product-status-view.mjs`
- `backend/src/tool-groups/recovery-tools-group.mjs`
- `backend/src/self-test.mjs` 或实际 self-test composition
- `backend/package.json`
- `docs/operations.md`
- `docs/current-status.md`

---

## Task 1：只读 census

**Files:**
- Create: `backend/src/migrations/task-state-boundary-census.mjs`
- Create: `backend/scripts/state-boundary-census.mjs`
- Test: `backend/test/state-boundary-census.test.mjs`

分类每个 Task：

```js
{
  task_id,
  task_status,
  execution_records,
  active_sessions,
  canonical_outcome,
  queue_status,
  goal_status,
  workflow_projection,
  worktree,
  repo_lock,
  classification,
  safe_action,
}
```

分类：

- `consistent`
- `task_status_stale`
- `queue_projection_stale`
- `goal_projection_stale`
- `workflow_projection_stale`
- `execution_missing`
- `execution_orphaned`
- `session_orphaned`
- `terminal_with_active_lock`
- `completed_without_unified_decision`
- `unified_decision_conflicts_task`
- `ambiguous_legacy_state`

规则示例：

```js
if (
  task.result?.unified_decision?.status === "completed" &&
  task.status !== "completed"
) classification.push("unified_decision_conflicts_task");

if (
  isTerminalStatus(task.status) &&
  activeRepoLockForTask(task.id)
) classification.push("terminal_with_active_lock");
```

输出 JSON：

```text
.gptwork/reports/state-boundary-census-<timestamp>.json
```

摘要：

```js
{
  total_tasks,
  consistent,
  safe_auto_repairs,
  ambiguous,
  by_classification,
  execution_coverage,
  unified_decision_coverage,
  projection_drift,
}
```

---

## Task 2：execution backfill

**Files:**
- Create: `backend/src/migrations/execution-record-backfill.mjs`
- Test: `backend/test/state-boundary-census.test.mjs`

只对可确定的历史 TUI session 创建 compatibility execution：

条件：

- session 有 task_id、goal_id、cwd。
- 没有 execution_id。
- task 存在。
- 同 session 未有 backfill record。

record：

```js
{
  id: `exec_legacy_${sha256(session.id).slice(0, 20)}`,
  schema_version: 1,
  provider: "codex_tui",
  interaction_mode: "interactive",
  provider_run_id: session.id,
  status: mapLegacySessionStatus(session.status),
  metadata: {
    migrated: true,
    migration_source: "legacy_tui_session",
  },
}
```

不推导 evidence；只关联已有 evidence path。

---

## Task 3：canonical reconciler

**Files:**
- Create: `backend/src/reconciliation/canonical-state-reconciler.mjs`
- Test: `backend/test/canonical-state-reconciler.test.mjs`

只允许以下确定性修复：

### R1：Canonical decision 与 Task status 冲突

```js
if (task.result.unified_decision?.status && task.status !== canonical) {
  transitionTask({
    event: "reconciliation_correction",
    expected_statuses: [task.status],
    payload: {
      canonical_status: canonical,
      unified_decision: task.result.unified_decision,
      admin_reconciliation: true,
    },
    idempotency_key: `reconcile:${task.id}:${decisionDigest}`,
  });
}
```

要求：

- 只信已有 unified decision。
- 不从 raw evidence 新建 unified decision。

### R2：Projection 缺失或漂移

重新调用 projector，不改 Task。

### R3：Terminal Task 有 active repo lock

调用现有安全 `releaseLockForTask()`。

### R4：Execution active 但进程/session 不存在

Execution → lost。Task 不直接 failed；生成 runtime-lost transition，由 repair policy 决定。

### R5：Session stopped + evidence 未收集

生成 projection/recovery action：

```js
{
  action: "collect_execution_evidence",
  execution_id,
  safe: true,
}
```

不要直接设 waiting_for_review。

Ambiguous：

- 无 unified decision 且多个 finalizer/closure 结果冲突。
- task completed 但 code change 无 commit。
- task running 但多个 active executions。
- 只报告，进入 human review。

---

## Task 4：替换现有直接 reconciler 写入

**Files:**
- Modify: `backend/src/runtime-reconciler-stale-tasks.mjs`
- Modify: `backend/src/runtime/task-runtime-reconciler.mjs`
- Modify: `backend/src/runtime-watch-diagnostics.mjs`
- Modify: `backend/src/stale-state-sweeper.mjs`
- Test: existing reconciliation tests

当前类似：

```js
task.status = recoveredStatus;
item.status = "waiting";
```

改为：

```js
await canonicalReconciler.plan(state)
await canonicalReconciler.applySafeActions(plan, {
  dryRun,
})
```

Queue 修复交给 queue projector。

修复 `store.mutate` / `store.updateTask` 不一致：

- 所有 reconciler 依赖注入：
  - `taskTransitionService`
  - `projectionDispatcher`
  - `storeMutationAdapter`
- 禁止自己判断 store API。

---

## Task 5：Projection retry store

**Files:**
- Create: `backend/src/reconciliation/projection-retry-store.mjs`
- Modify: `backend/src/runtime-reconciler.mjs`
- Test: `backend/test/canonical-state-reconciler.test.mjs`

记录：

```js
{
  retry_id,
  task_id,
  transition_id,
  projection: "queue" | "goal" | "workflow" | "workstream",
  decision_digest,
  attempts,
  next_attempt_at,
  last_error,
  status,
}
```

策略：

- 指数退避，最大次数。
- decision digest 变化时旧 retry superseded。
- 成功后 completed。
- 不阻塞 Task canonical transition。

---

## Task 6：Feature flags 与 shadow mode

**Files:**
- Modify: runtime config
- Modify: `backend/.env.example`
- Test: config tests

Flags：

```text
GPTWORK_TASK_TRANSITION_KERNEL_ENABLED=false
GPTWORK_EXECUTION_RUNTIME_V2_ENABLED=false
GPTWORK_TUI_PROVIDER_V2_ENABLED=false
GPTWORK_CODEX_EXEC_PROVIDER_ENABLED=false
GPTWORK_CANONICAL_PROJECTIONS_ENABLED=false
GPTWORK_STATE_BOUNDARY_SHADOW_MODE=true
```

Shadow mode：

- 旧逻辑继续写。
- 新逻辑只计算 expected transition/projection。
- 输出差异 report：
  ```js
  {
    task_id,
    old_status,
    proposed_status,
    old_queue_effect,
    proposed_queue_effect,
    mismatch_reason,
  }
  ```
- 不执行两套写入。

启用顺序：

1. transition kernel shadow
2. execution runtime v2 for test tasks
3. TUI provider v2
4. Exec provider
5. projections
6. canonical reconciler apply

---

## Task 7：可观测性

**Files:**
- Create: `backend/src/diagnostics/state-boundary-health.mjs`
- Modify: `backend/src/product-status-view.mjs`
- Modify: `backend/src/tool-groups/recovery-tools-group.mjs`
- Modify: self-test
- Test: product status tests

指标：

```js
{
  task_transition: {
    total_events,
    invalid_transition_attempts,
    idempotent_replays,
    legacy_direct_writes,
  },
  execution: {
    active,
    lost,
    evidence_ready,
    evidence_missing,
    by_provider,
  },
  canonical_outcome: {
    with_unified_decision,
    without_unified_decision,
    conflicts_with_task_status,
  },
  projections: {
    drift_count,
    pending_retries,
    failed_retries,
  },
  locks: {
    terminal_task_active_locks,
  },
}
```

新增 recovery read-only 工具或扩展 doctor：

```text
state_boundary_health
```

若不希望增加公开工具，则挂入：

- `gptwork_doctor(deep=true)`
- `runtime_status`
- `product_status_view`

告警阈值：

- invalid transition > 0 → FAIL
- terminal active lock > 0 → FAIL
- projection drift > 0 持续两轮 → WARN
- lost execution > 0 → WARN
- legacy direct writes 增长 → WARN

---

## Task 8：Release gate

**Files:**
- Create: `backend/scripts/state-boundary-release-gate.mjs`
- Create: `backend/test/state-boundary-release-gate.test.mjs`
- Modify: `backend/package.json`

Scripts：

```json
{
  "test:state-boundary": "node --test --test-reporter=dot 'test/*state-boundary*.test.mjs' test/task-transition-service.test.mjs test/execution-runtime-service.test.mjs test/projection-idempotency.test.mjs",
  "release:state-boundary:gate": "node scripts/state-boundary-release-gate.mjs",
  "release:state-boundary:gate:report": "node scripts/state-boundary-release-gate.mjs --json-report .gptwork/releases/state-boundary-gate.json"
}
```

Gate checks：

1. syntax/imports pass。
2. targeted tests pass。
3. no direct status writes in protected modules。
4. census ambiguous count 不增长。
5. shadow mismatch rate 小于阈值。
6. no active task has >1 active execution，除非显式允许。
7. no terminal task owns active lock。
8. repeated collect idempotency canary pass。
9. Exec/TUI evidence parity fixture pass。
10. Workflow/Queue projection convergence pass。

Static protected modules：

```js
[
  "src/tool-groups/codex-tui-tools-group.mjs",
  "src/tool-groups/codex-exec-tools-group.mjs",
  "src/providers/codex-tui-execution-provider.mjs",
  "src/providers/codex-exec-execution-provider.mjs",
  "src/executions/execution-runtime-service.mjs",
]
```

禁止：

```regex
\b(task|item)\.status\s*=
```

允许状态写入仅在：

- task transition service
- migration/reconciler with explicit audited adapter
- tests/fixtures

---

## Task 9：Canary

### Canary A：Exec no-change

- 创建 diagnostic task。
- Exec 完成。
- evidence 有明确 no_change_reason。
- Task completed。
- Queue downstream ready。

### Canary B：TUI code change

- 启动 TUI。
- 产生 commit + tests。
- stop 不改变 Task terminal。
- collect 生成 evidence。
- finalizer 决定 waiting_for_integration/completed。
- 重复 collect 幂等。

### Canary C：缺 evidence

- TUI stop。
- result.json 缺失。
- collect 返回 blocker。
- repair policy 生效。
- 不误 completed。

### Canary D：服务重启

- active Exec/TUI 中途重启。
- session/process 标记 lost 或恢复。
- durable evidence 可继续 collect。
- repo lock 最终释放。

### Canary E：Projection 故障

- 故意让 workflow projector 失败。
- Task canonical status 正确。
- Queue/Goal 其他 projection 成功。
- retry 后 workflow 收敛。

---

## Task 10：回滚方案

回滚只切 flag，不删除数据：

```text
GPTWORK_CANONICAL_PROJECTIONS_ENABLED=false
GPTWORK_TUI_PROVIDER_V2_ENABLED=false
GPTWORK_EXECUTION_RUNTIME_V2_ENABLED=false
GPTWORK_TASK_TRANSITION_KERNEL_ENABLED=false
```

保留：

- execution records
- evidence files
- transition events
- projection checkpoints

Legacy reader 必须忽略未知字段。

禁止回滚方式：

- 删除 `.gptwork/executions`
- 恢复旧 state backup 覆盖新任务
- 批量把 Task 改回 running
- 清空 transition history

---

## Task 11：最终发布命令

```bash
cd backend
npm run check:syntax
npm run check:imports
npm run test:state-boundary
npm run release:state-boundary:gate:report
npm test
npm run release:check
```

最终检查：

- 当前 blocker census。
- active executions。
- active repo locks。
- projection retry backlog。
- legacy direct write count。
- state backup 可恢复。
- 文档与 flags 一致。
