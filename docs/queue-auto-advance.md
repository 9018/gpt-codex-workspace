# Queue auto advance

This document describes how the GPTWork execution queue decides which queued
goal to start next and when.  The policy is implemented in
[backend/src/queue-policy.mjs](../backend/src/queue-policy.mjs) and wired into
[backend/src/goal-queue.mjs](../backend/src/goal-queue.mjs).

## Overview

The execution queue (`state.goal_queue`) holds ordered items representing goals
that are waiting to run.  Each item has a status:

```
waiting -> ready -> running -> completed|failed
waiting -> blocked              (dependency not met or repo locked)
blocked -> waiting              (when dependency resolves)
running -> completed|failed
```

The queue is driven forward by:

1. **`startNextQueuedGoal`** — scans eligible items (waiting/ready) in position
   order and starts the first one whose preconditions pass.
2. **`autoStartNextOnTaskCompleted`** — when a task finishes, this hook checks
   for dependent queue items and tries to start them if the completed task
   passed acceptance.

Final task writeback is the durable handoff from acceptance to the queue. When
a linked task reaches accepted auto-completion after verified integration,
writeback marks the task, goal, and running queue item completed in one state
mutation, reconciles blocked queue items that depend on the completed goal, and
then calls the auto-start hook. This avoids requiring manual reconciliation for
the normal accepted/integrated path.

## Queue policy rules

### 1. Dependency terminal-only

A `depends_on_goal` or `depends_on_task` must reach a terminal *completed*
state before the dependent can start.

Goal dependencies use the durable goal status. A completed task for a still-open
goal is not enough; final writeback must close the linked goal before queue
policy treats `depends_on_goal` as satisfied.

| Policy | Description |
|--------|-------------|
| `completed_only` (default) | Only status `"completed"` satisfies the dependency. |
| `terminal_any` | Any terminal state (completed, failed, timed_out, blocked, cancelled) satisfies the dependency. |

### 2. Acceptance gating

If the prerequisite task finished with a status other than `"completed"`
(e.g. failed, timed_out), queue items that depend on that task are blocked.

- A task that did not pass acceptance **must not advance** the queue.
- Items depending on the failing task are marked `blocked` with a clear reason.
- The `start_next_queued_goal` MCP tool reports the acceptance gate result
  in its `checks` array.

### 3. Repo serialisation

Two items for the same repository may not run concurrently.

- When `startNextQueuedGoal` evaluates an item with a `repo_id`, it checks
  whether any other running queue item already claims the same repo.
- If a conflict is found, the candidate is marked `blocked` until the earlier
  item finishes.

### 4. Auto-start preconditions

A queue item is eligible for auto-start **only** when all of the following
pass:

- Dependency satisfied (terminal completed for `completed_only`).
- Acceptance gate passed (prerequisite task is `completed`).
- No repo concurrency conflict (same repo is not already running).

## The `start_next_queued_goal` tool

The MCP tool reports **individual check results** in its return value.
Each check object has the shape:

```json
{
  "check": "dependency|acceptance_gate|repo_concurrency|repo_resolution|execution_guards_deferred",
  "passed": true|false,
  "detail": "human-readable explanation",
  "repo_id": "...",
  "blocking_item_queue_id": "...",
  "blocking_item_goal_id": "..."
}
```

The checks are evaluated in order:

1. `dependency` — is the prerequisite goal/task in the right state?
2. `acceptance_gate` — did the prerequisite task pass acceptance?
3. `repo_concurrency` — is another item already running on the same repo?
4. `repo_resolution` — can the repository path be resolved?
5. `execution_guards_deferred` — repo lock and worktree checks are deferred
   to the execution phase.

## Architecture

```
queue-policy.mjs          (pure policy logic)
    |
    v
goal-queue.mjs            (queue operations, calls policy checks)
    |
    v
goal-queue-tools-group.mjs (MCP tool wrappers)
```

Auto-integration verification is part of the accepted/integrated handoff. Its
JSON reports are generated outside the canonical repository by default whenever
the default workspace root points at that repository. This keeps the canonical
repo clean for the dirty-repo guard that protects queue auto-advance from
integrating on top of untracked runtime artifacts. Deployments that need a
specific report location can set `autoIntegrationReportDir` explicitly.

## Testing

```bash
# Run policy-specific tests
node --test test/queue-policy.test.mjs

# Run queue integration tests
node --test test/goal-queue.test.mjs
```

## Runtime Conditions for Full Auto-Advance

The queue auto-advance system requires the following runtime conditions to operate without manual intervention:

### 1. Worker Must Be Running

The Codex worker loop (`startCodexWorker` in `codex-worker-loop.mjs`) drives the auto-advance cycle. Without it, the queue never advances.

**Required environment variable:**
- `GPTWORK_CODEX_WORKER=true` — enables the worker loop

**Health verification:**
- `product_status` output shows `worker: running` in the summary
- Worker health phase is `running` or `enabled_but_not_running` (between ticks)
- Worker health phase `stalled`, `overdue`, or `disabled` indicates the queue is not advancing

### 2. Queue items must have `auto_start=true`

Each queue item has an `auto_start` field. Items with `auto_start=false` are skipped
by the auto-advance mechanism and must be started manually.

### 3. Fresh Heartbeat and Tick Cycle

The worker heartbeat is measured by the tick interval:
- Default: 5000ms (`GPTWORK_CODEX_WORKER_INTERVAL_MS`)
- A tick is **stalled** when the last tick finished more than 6 intervals ago
- A tick is **overdue** when the next tick due time is more than 3 intervals in the past
- A healthy worker shows `enabled_but_not_running` or `running` health phases

### 4. Dependency Resolution is Automated

The queue reconciler handles these auto-advance paths:

| Scenario | Auto-Advance Mechanism |
|---|---|
| **queued -> assigned** | `startNextQueuedGoal` picks the first waiting item with satisfied preconditions |
| **completed → dependent auto-start** | `autoStartNextOnTaskCompleted` is called when a task reaches a terminal completed state, and it starts dependents with satisfied dependencies |
| **waiting_for_integration retry** | The reconciler checks `integration_required_and_missing` — when integration completes or is not required, the queue advances |
| **accepted+verified review recovery** | Tasks in `waiting_for_review` with passing verification and acceptance are auto-resolved by the blocker manifest convergence |
| **running queue reconciliation** | The runtime reconciler (`reconcileStaleTasks`) runs at worker startup and periodically, detecting stale blockers and advancing resolved dependencies |
| **repair success propagation** | When a repair task completes, `propagateRepairSuccess` unblocks dependents of the repaired task automatically |

### 5. Integration Requirements

- Tasks requiring integration (`needs_integration: true`) must either be integrated or marked
  `integration: { status: "not_required" }` before dependents can advance
- The reconciler distinguishes `completed` tasks with satisfied vs unsatisfied
  integration requirements (see `integration_required_and_missing`)

### 6. No Manual Reconciliation Required

When all runtime conditions are met:
- No manual `complete_task` or `reconcile` calls are needed for the normal
  accepted/integrated path
- The worker's startup reconciliation runs `reconcileStaleTasks` once, then the
  tick loop processes queued tasks automatically
- Blocker manifest (MA11-R6) and historical convergence sweep stale states
  without manual intervention

## How to Verify

### Quick Health Check

```bash
# Check worker status and queue metrics
cd backend && node -e "
const { createWorkerState, workerStatusExtendedSnapshot } = await import('./src/codex-worker-state.mjs');
const state = createWorkerState();
// Simulate started worker
state.enabled = true;
state.running = true;
state.started_at = new Date().toISOString();
state.last_tick_started_at = new Date(Date.now() - 2000).toISOString();
const health = workerStatusExtendedSnapshot(state);
console.log('Worker health phase:', health.health.phase);
console.log('Worker enabled:', health.enabled);
console.log('Worker running:', health.running);
"
```

### Diagnostically Distinguish All Worker States

The `computeWorkerHealth` function returns these phases:

| State | Condition | Phase |
|---|---|---|
| Worker disabled | `enabled=false` | `disabled` |
| Enabled, never started | `enabled=true, running=false, started_at=null` | `enabled_but_not_running` |
| Enabled, between ticks | `enabled=true, running=false, tick age fresh` | `enabled_but_not_running` |
| Running healthy | `enabled=true, running=true` | `running` |
| Tick stalled | `last_tick_age > 6 * interval_ms` | `stalled` |
| Tick overdue | `next_tick_due < interval_ms * 3` | `overdue` |

### Run the Tests

```bash
cd backend

# Worker state and health diagnostics
node --test test/codex-worker-state.test.mjs

# Queue auto-advance reconciler
node --test test/queue-auto-advance.test.mjs

# Full queue integration
node --test test/goal-queue.test.mjs

# Syntax and imports
npm run check:syntax
npm run check:imports
```
