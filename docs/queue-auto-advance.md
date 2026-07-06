# Queue Auto-Advance

This document describes how the GPTWork execution queue decides which queued
goal to start next and when, covering the full automatic path from queued goal
to assigned task, Codex exec execution, acceptance gate, integration, finalizer,
queue unblock, and start-next behavior.

The policy is implemented across three modules:

- [queue-policy.mjs](../backend/src/queue-policy.mjs) — pure policy logic
  (dependency, acceptance, repo concurrency)
- [queue-reconciler.mjs](../backend/src/queue-reconciler.mjs) — reconciler with
  stale detection, integration awareness, repair propagation
- [goal-queue.mjs](../backend/src/goal-queue.mjs) — queue operations, typed
  eligibility gates, auto-advance tick orchestration

These are wired into the MCP tools via
[goal-queue-tools-group.mjs](../backend/src/goal-queue-tools-group.mjs) and
driven by the worker loop in
[codex-worker-loop.mjs](../backend/src/codex-worker-loop.mjs).

## Overview

The execution queue (`state.goal_queue`) holds ordered items representing goals
that are waiting to run. Each item has a status:

```
waiting -> ready -> running -> completed|failed
waiting -> blocked              (typed reason stored in blocked_reason)
blocked -> ready                (reconciler detects resolved dependency)
running -> completed|failed
```

The queue is driven forward by multiple mechanisms:

1. **`queueAutoAdvanceTick`** — the primary auto-advance tick (P0-MA8). Runs on
   every worker tick cycle. Executes reconciler first (fix stale blockers), then
   scans eligible items with typed eligibility gates, sets typed `blocked_reason`
   on ineligible items, and advances the first fully-eligible item.
2. **`startNextQueuedGoal`** — scans eligible items (waiting/ready) in position
   order and starts the first one whose preconditions pass. Called by the tick.
3. **`autoStartNextOnTaskCompleted`** — when a task finishes, routes through
   `queueAutoAdvanceTick` to check for dependent queue items and advance the next
   eligible one, respecting acceptance gate and repo concurrency.

Final task writeback is the durable handoff from acceptance to the queue. When
a linked task reaches accepted auto-completion after verified integration,
writeback marks the task, goal, and running queue item completed in one state
mutation, reconciles blocked queue items that depend on the completed goal, and
then calls the auto-start hook. This avoids requiring manual reconciliation for
the normal accepted/integrated path.

## Architecture

```
codex-worker-loop.mjs         (tick cycle)
    |
    v
goal-queue.mjs                (queueAutoAdvanceTick + checkTypedEligibility)
    |       |
    |       v
    |   queue-reconciler.mjs  (stale detection, repair propagation)
    |
    v
queue-policy.mjs              (dependency, acceptance, repo concurrency)
    |
    v
goal-queue-tools-group.mjs    (MCP tool wrappers)
```

Auto-integration verification reports are generated outside the canonical
repository by default whenever the default workspace root points at that
repository. This keeps the canonical repo clean for the dirty-repo guard that
protects queue auto-advance from integrating on top of untracked runtime
artifacts. Deployments that need a specific report location can set
`autoIntegrationReportDir` explicitly.

## Queue Policy Rules

### 1. Dependency Terminal-Only

A `depends_on_goal` or `depends_on_task` must reach a terminal *completed*
state before the dependent can start.

Goal dependencies use the durable goal status. A completed task for a still-open
goal is not enough; final writeback must close the linked goal before queue
policy treats `depends_on_goal` as satisfied.

| Policy | Description |
|--------|-------------|
| `completed_only` (default) | Only status `"completed"` satisfies the dependency. |
| `terminal_any` | Any terminal state (completed, failed, timed_out, blocked, cancelled) satisfies the dependency. |

### 2. Acceptance Gating

If the prerequisite task finished with a status other than `"completed"`
(e.g. failed, timed_out), queue items that depend on that task are blocked.

- A task that did not pass acceptance **must not advance** the queue.
- Items depending on the failing task are marked `blocked` with a clear reason.
- The `start_next_queued_goal` MCP tool reports the acceptance gate result
  in its `checks` array.

### 3. Repo Serialisation

Two items for the same repository may not run concurrently.

- When `startNextQueuedGoal` evaluates an item with a `repo_id`, it checks
  whether any other running queue item already claims the same repo.
- If a conflict is found, the candidate is marked `blocked` until the earlier
  item finishes.

### 4. Auto-Start Preconditions

A queue item is eligible for auto-start **only** when all typed eligibility
gates pass (see Typed Eligibility Gates below).

## The `start_next_queued_goal` Tool

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

## Typed Eligibility Gates (P0-MA8)

The `checkTypedEligibility` function in `goal-queue.mjs` evaluates a queue
item against nine typed gates. Each gate maps to a constant in
`BLOCKED_REASON_TYPES`. If a gate fails, the item is marked `blocked` with
the typed reason — legacy human-readable strings are no longer authored by
the queue code.

### The Nine Typed Blocked Reason Types

| Constant | Gate | Description |
|----------|------|-------------|
| `DEPENDENCY_NOT_TERMINAL` | dependency | Dependency task/goal not in terminal-completed state |
| `ACCEPTANCE_NOT_SATISFIED` | acceptance_gate | Prerequisite completed but acceptance explicitly failed |
| `INTEGRATION_NOT_SATISFIED` | integration | Mutating task completed but integration not yet satisfied |
| `FINALIZER_NOT_TERMINAL` | finalizer_terminal | Prerequisite completed but `safe_to_auto_advance` not set |
| `WAITING_FOR_REVIEW` | prerequisite_terminals | Prerequisite is in `waiting_for_review` |
| `WAITING_FOR_REPAIR` | prerequisite_terminals | Prerequisite is in `waiting_for_repair` |
| `WAITING_FOR_INTEGRATION` | prerequisite_terminals | Prerequisite is in `waiting_for_integration` |
| `ACTIVE_REPO_LOCK` | active_repo_lock | An active repo lock exists for the item's canonical repo |
| `DIRTY_WORKTREE` | dirty_worktree | Canonical worktree has uncommitted changes |

### Evaluation Order

The gates are evaluated in this order. The first failing gate short-circuits
and returns the typed blocked reason:

1. **Prerequisite terminal statuses** — direct check on prerequisite task
   status (`waiting_for_review`, `waiting_for_repair`, `waiting_for_integration`)
2. **Acceptance gate** — explicit failure evidence in the prerequisite result
3. **Generic dependency** — `resolveQueueDependencyState` checks effective
   completion, effective failure, and integration requirements
4. **Finalizer terminal** — if task completed, checks `safe_to_auto_advance`
5. **Dependency policy** — `checkDependency` from queue-policy
6. **Repo concurrency** — same-repo serialisation check
7. **Active repo lock** — any unreleased lock for the repo
8. **Dirty worktree** — uncommitted changes in canonical repo

### Typed `blocked_reason` Values

When a gate fails, the item's `blocked_reason` field is set to the exact
typed constant string (e.g., `"waiting_for_review"`, `"active_repo_lock"`).
Consumers that inspect `blocked_reason` can switch on these constants
instead of parsing human-readable text:

| Typed Constant | `blocked_reason` String |
|----------------|-------------------------|
| `DEPENDENCY_NOT_TERMINAL` | `dependency_not_terminal` |
| `ACTIVE_REPO_LOCK` | `active_repo_lock` |
| `DIRTY_WORKTREE` | `dirty_worktree` |
| `WAITING_FOR_REVIEW` | `waiting_for_review` |
| `WAITING_FOR_REPAIR` | `waiting_for_repair` |
| `WAITING_FOR_INTEGRATION` | `waiting_for_integration` |
| `ACCEPTANCE_NOT_SATISFIED` | `acceptance_not_satisfied` |
| `INTEGRATION_NOT_SATISFIED` | `integration_not_satisfied` |
| `FINALIZER_NOT_TERMINAL` | `finalizer_not_terminal` |

## Queue Auto-Advance Tick (P0-MA8)

The `queueAutoAdvanceTick` function is the central orchestration point for
automated queue advancement. It runs on every worker tick cycle.

### Tick Execution Flow

```
queueAutoAdvanceTick(store, config, opts)
  1. Load state
  2. Run reconcileQueue with fixStaleBlockers=true
     — detect and unblock items whose dependencies have resolved
     — this is the MA7 reconciler integration
  3. Reload state
  4. Filter eligible items (status=waiting|ready, auto_start=true)
  5. Sort by position
  6. For each candidate in order:
     a. Run checkTypedEligibility(state, candidate)
     b. If eligible → advance via startNextQueuedGoal
        Return { advanced: true, item, task, gates }
     c. If blocked → set candidate.status=blocked,
        candidate.blocked_reason=typed constant
        Collect in blocked_items[]
      Stop at first blocked item (respect queue order)
  7. Return summary with blocked_items diagnostics
```

### Acceptance-Aware AutoStart

When a completed task triggers `autoStartNextOnTaskCompleted`:

- Non-terminal (failed, timed_out) → all task-level dependents are explicitly
  blocked with `ACCEPTANCE_NOT_SATISFIED`
- Terminal-completed → routes through `queueAutoAdvanceTick` for full
  typed eligibility evaluation
- The task completion handler does NOT bypass any typed eligibility gate

## Queue Reconciler (P0-C8)

The reconciler in `queue-reconciler.mjs` provides deterministic dependency
state resolution and stale-blocker detection.

### `resolveQueueDependencyState`

Resolves the full dependency state for a queue item, including:

- **Integration awareness**: A `completed` mutating task that has a commit
  but no integration evidence (`integration.merged`, `auto_integration_completion`)
  is flagged as `integration_required_and_missing`. This prevents the queue
  from advancing past an accepted-but-unintegrated change.
- **Readonly detection**: Tasks with `operation_kind=readonly_validation|diagnostic`
  do not require integration — they unblock dependents immediately.
- **Repair-chain awareness**: Tasks with `status=resolved_by_successor|superseded`
  are treated as terminal-completed.
- **Extended terminal states**: The reconciler recognises these as terminal
  completed for queue purposes:

| Status | Meaning |
|--------|---------|
| `completed` | Standard task completion |
| `readonly_closed` | Readonly/validation task completed cleanly |
| `integration_not_required` | Upstream done and does not need merging |
| `integrated` | Commit merged or integrated |
| `superseded` | Task superseded by a successor |
| `resolved_by_successor` | Task resolved by a repair successor |

Returns:

```json
{
  "status": "completed",
  "kind": "task",
  "target_id": "task_xxx",
  "effective_completed": true,
  "effective_failed": false,
  "integration_required_and_missing": false,
  "readonly_operation": false,
  "is_repair_successor": false,
  "detail": "human-readable explanation"
}
```

### `detectStaleBlockers`

Scans all blocked queue items and classifies each as one of:

| stale_type | Condition | recommendation |
|------------|-----------|----------------|
| `dependency_resolved` | Dependency is terminal-completed but item still `blocked` | `unblock: set status to ready` |
| `dependency_failed_terminal` | Dependency is terminal-failed | `keep blocked: upstream failed` |
| `dependency_in_progress` | Dependency still running | `keep blocked: upstream in progress` |

### `diagnoseQueueItems`

Build a full dry-run diagnostic report for all queue items. Each scan entry
reports:

```json
{
  "queue_id": "queue_xxx",
  "goal_id": "goal_xxx",
  "position": 1,
  "item_status": "waiting|blocked|...",
  "can_advance": true|false,
  "action": "advance|unblock|block_on_*",
  "why_not": "reason if blocked",
  "effective_completed": true|false,
  "effective_failed": true|false,
  "integration_required_and_missing": true|false,
  "readonly_operation": true|false,
  "is_repair_successor": true|false,
  "stale_blocker": true|false,
  "stale_type": "dependency_resolved|..."
}
```

Summary statistics:
- `can_advance` — items ready to advance without any blocker
- `blocked` — items with one or more blockers
- `stale_blockers` — blocked items whose dependency has resolved
- `integration_required_and_missing` — completed but unintegrated upstream

### `reconcileQueue`

Applies reconciler decisions to queue state:

- `dryRun=true` — returns diagnostics only, no mutation
- `dryRun=false` — mutates state: unblocks resolved blockers, advances
  eligible items, confirms failed-dependency blockers
- `fixStaleBlockers=true` — auto-fix stale blockers by unblocking items
  whose dependency has resolved (set status to `ready`, clear blocked_reason)

### `propagateRepairSuccess`

Cascade unblocking after a repair task completes:

1. Finds queue items depending on the repaired root task or its goal
2. Re-evaluates dependency state via `resolveQueueDependencyState`
3. If effective_completed → unblocks (status=ready, clear blocked_reason)
4. If effective_failed → stays blocked with typed reason

## The Finalizer Gate

When a prerequisite task reaches `completed` status, the auto-advance tick
checks whether the finalizer decision is terminal before allowing dependent
advancement. This prevents auto-advance from starting dependents on a task
that has not completed its closure/finalizer phase.

The check inspects the task's `result.finalizer_decision`:

```json
{
  "finalizer_decision": {
    "safe_to_auto_advance": true,
    "queue_effect": { "unblock_dependents": true }
  }
}
```

The finalizer gate passes when any of these is true:
- `finalizer_decision.safe_to_auto_advance === true`
- `finalizer_decision.queue_effect.unblock_dependents === true`
- `closure_decision.status` starts with `"auto_completed"`

If none are true, the item is blocked with `FINALIZER_NOT_TERMINAL`.

## Runtime Conditions for Full Auto-Advance

The queue auto-advance system requires the following runtime conditions to
operate without manual intervention:

### 1. Worker Must Be Running

The Codex worker loop (`startCodexWorker` in `codex-worker-loop.mjs`) drives
the auto-advance cycle. Without it, the queue never advances.

**Required environment variable:**
- `GPTWORK_CODEX_WORKER=true` — enables the worker loop

**Health verification:**
- `product_status` output shows `worker: running` in the summary
- Worker health phase is `running` or `enabled_but_not_running` (between ticks)
- Worker health phase `stalled`, `overdue`, or `disabled` indicates the queue
  is not advancing

### 2. Queue Items Must Have `auto_start=true`

Each queue item has an `auto_start` field. Items with `auto_start=false` are
skipped by the auto-advance mechanism and must be started manually.

### 3. Fresh Heartbeat and Tick Cycle

The worker heartbeat is measured by the tick interval:
- Default: 5000ms (`GPTWORK_CODEX_WORKER_INTERVAL_MS`)
- A tick is **stalled** when the last tick finished more than 6 intervals ago
- A tick is **overdue** when the next tick due time is more than 3 intervals
  in the past
- A healthy worker shows `enabled_but_not_running` or `running` health phases

### 4. Dependency Resolution is Automated

| Scenario | Auto-Advance Mechanism |
|---|---|
| **queued → assigned** | `queueAutoAdvanceTick` scans eligible items, runs typed gates, advances first fully-eligible |
| **completed → dependent auto-start** | `autoStartNextOnTaskCompleted` routes through `queueAutoAdvanceTick` |
| **waiting_for_integration retry** | Reconciler detects `integration_required_and_missing` — blocks until integration completes |
| **accepted+verified review recovery** | Tasks with passing verification and acceptance are auto-resolved by blocker manifest convergence |
| **readonly closure unblocks** | Readonly tasks complete immediately without integration requirement |
| **repair success propagation** | `propagateRepairSuccess` unblocks dependents of the repaired task automatically |

### 5. Integration Requirements

- Tasks requiring integration (`needs_integration: true`) must either be
  integrated or marked `integration: { status: "not_required" }` before
  dependents can advance
- A mutating task that is `completed` with a commit but without integration
  evidence is blocked with `INTEGRATION_NOT_SATISFIED`
- Readonly and noop tasks are exempt from integration requirements

### 6. Finalizer Must Be Terminal

- A completed prerequisite task without a terminal finalizer decision is
  blocked with `FINALIZER_NOT_TERMINAL`
- `safe_to_auto_advance: true` or `auto_completed*` closure satisfies the
  finalizer gate

### 7. No Manual Reconciliation Required

When all runtime conditions are met:
- No manual `complete_task` or `reconcile` calls are needed for the normal
  accepted/integrated path
- The worker's startup reconciliation runs `reconcileStaleTasks` once, then the
  tick loop processes queued tasks automatically
- Blocker manifest (MA11-R6) and historical convergence sweep stale states
  without manual intervention

## Current Diagnostics and Safe-to-Advance

### `enabled_but_not_running` Worker State

Worker health uses `computeWorkerHealth` to produce one of six phases:

| Phase | Condition |
|-------|-----------|
| `disabled` | `enabled=false` |
| `enabled_but_not_running` | Between ticks or never started |
| `running` | Tick currently executing |
| `stalled` | Last tick finished > 6× interval ago |
| `overdue` | Next tick due > 3× interval in past |

When the phase is `disabled`, `stalled`, or `overdue`, the queue is not
advancing automatically. `enabled_but_not_running` is healthy — the worker
is idle between ticks and will pick up the next tick when scheduled.

### Heartbeat / Tick Health Diagnostics

The worker state tracks these timestamps:

| Field | Type | Meaning |
|-------|------|---------|
| `last_tick_started_at` | ISO timestamp | When the current/last tick began |
| `last_tick_finished_at` | ISO timestamp | When the last tick completed |
| `last_tick_duration_ms` | number | Execution time of the last tick |
| `next_tick_due_at` | ISO timestamp | When the next tick is scheduled |
| `current_interval_ms` | number | Active tick interval (with backoff) |

These are surfaced via `runtime_status`, `worker_status`, and `product_status`
diagnostic tools.

### Active vs Stale Repo Locks

Repo lock diagnostics via `getRepoLockSummary`:

| Metric | Meaning |
|--------|---------|
| `active_repo_locks` | Locks currently held by running workers |
| `stale_repo_locks` | Locks with status `"stale"` — no active worker |
| `released_repo_locks` | Historical released locks (diagnostic only) |

Active and stale locks block queue auto-advance via the `ACTIVE_REPO_LOCK`
gate. Released locks do not block.

Use these MCP tools to inspect:
- `runtime_status` — repo lock summary in output
- `list_repo_locks` — full lock details
- `worker_status` — active repo count in queue metrics

### Actionable Review Classification

Tasks in `waiting_for_review` are classified by `classifyCurrentBlockerTask`
(current-blocker-policy.mjs) into these decision labels:

| Label | blocks_current_work | Meaning |
|-------|---------------------|---------|
| `review` | depends | Waiting for human or machine review |
| `integration` | true | Waiting for integration to complete |
| `active` | true | Task is being actively executed |
| `completed` | false | Task completed successfully |
| `failure_evidence` | true | Task failed with evidence |
| `code_evidence_failure` | true | Task failed with code changes |
| `provider_empty` | false | Terminal failure without substantive result |
| `resolved_by_options` | false | Task resolved by successor/repair |
| `unknown_status` | false | Status not recognised |

Typed review states (P0-03) further distinguish:
- **Machine-repairable**: `waiting_for_evidence_missing`, `waiting_for_policy_uncertain`,
  `waiting_for_provider_unavailable` — do not block current work
- **Human-required**: `waiting_for_human_required`, `waiting_for_human_review`,
  `waiting_for_manual_terminal_decision`, `waiting_for_repair_budget_exhausted` —
  block current work

### Safe-to-Advance Decision

The complete safe-to-advance decision for a queue item combines:

1. **Typed gates pass** — `checkTypedEligibility` returns `eligible: true`
   meaning all nine gates passed
2. **No stale blockers** — `detectStaleBlockers` reports no `dependency_resolved`
   for this item
3. **Worker healthy** — phase is `running` or `enabled_but_not_running`
4. **No concurrent repo conflict** — same-repo serialisation check passes
5. **Worktree clean** — canonical repo has no uncommitted changes
6. **No active repo lock** — `getRepoLockSummary` reports `active_repo_locks=0`

The dry-run diagnostics report (via `diagnoseQueueItems` or
`start_next_queued_goal --dry-run`) shows the full per-item evaluation.

## How to Verify

### Quick Diagnostics

```bash
# Auto-advance tick dry-run (no mutation)
gptwork queue start-next --dry-run

# Full queue diagnostics
gptwork doctor --local

# Worker health and queue counts
worker_status
product_status
```

### Diagnostically Distinguish All Worker States

```javascript
const { computeWorkerHealth } = await import('./src/codex-worker-state.mjs');

// Worker health phases
const cases = [
  { enabled: false },                                      // disabled
  { enabled: true, running: false },                       // enabled_but_not_running
  { enabled: true, running: true,
    last_tick_started_at: new Date(Date.now() - 2000).toISOString() },  // running
  { enabled: true, running: false,
    last_tick_finished_at: new Date(Date.now() - 35000).toISOString(),
    interval_ms: 5000, next_tick_due_at: null },           // stalled
  { enabled: true, running: false,
    last_tick_finished_at: new Date(Date.now() - 5000).toISOString(),
    interval_ms: 1000,
    next_tick_due_at: new Date(Date.now() - 5000).toISOString() }, // overdue
];

for (const w of cases) {
  const h = computeWorkerHealth(w);
  console.log(`phase=${h.phase}, reason=${h.reason}`);
}
```

### Run the Tests

```bash
cd backend

# Worker state and health diagnostics
node --test test/codex-worker-state.test.mjs

# Queue auto-advance reconciler (C8: stale detection, integration awareness)
node --test test/p0-c8-queue-auto-advance.test.mjs

# Queue auto-advance runtime gates (MA8: typed eligibility)
node --test test/p0-ma8-queue-auto-advance-runtime.test.mjs

# Queue auto-advance scenarios (legacy)
node --test test/queue-auto-advance.test.mjs

# Queue policy pure logic
node --test test/queue-policy.test.mjs

# Full queue integration
node --test test/goal-queue.test.mjs

# Current blocker policy
node --test test/current-blocker-policy.test.mjs

# Syntax and imports
npm run check:syntax
npm run check:imports
```
