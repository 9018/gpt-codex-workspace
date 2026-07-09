## 2026-07-10 P0 Closure State Machine Convergence Second Repair

This task fixes the convergence bug where repair tasks stuck Closure parent tasks
in an infinite `waiting_for_repair` loop when the repair task produced no changed
files (`codex_failed`/no-change outcome).

### Changed files
- `backend/src/task-finalizer.mjs`
- `backend/src/repair-loop.mjs`

### Fixes
1. **task-finalizer.mjs - `hasRepairPath()`**: Added guard blocking recursive
   `waiting_for_repair` — a repair task (has `parent_task_id`) must NOT treat its
   OWN closure decision as an active external repair path.
2. **task-finalizer.mjs - `decideTaskFinalState()`**: When repairable blockers exist
   for a repair task, route to `failed` instead of `waiting_for_repair` so
   `handleRepairCompletion` is called with `passed: false`. Also in existing hold
   fallthrough — repair tasks stuck in `existing_repair_hold` escape to `failed`.
3. **repair-loop.mjs - `handleRepairCompletion`**: Budget calculation now also checks
   `parent.result.repair_attempt` and `completedTask.repair_attempt`, not only the
   top-level `parent.repair_attempt` which is often 0 for parent tasks.

### Behavior change
- **Before**: A repair task with `codex_failed`/no-changed-files would go to
  `waiting_for_repair` (via its own closure decision), `handleRepairCompletion`
  was never called, parent stayed stuck forever.
- **After**: The repair task goes to `failed`, `handleRepairCompletion` is called with
  `passed: false`, the parent's repair-budget logic runs, and the parent either
  gets a new repair attempt or moves to `human_interrupted_for_repair_budget_exhausted`.

### Verification
```
node --check backend/src/task-finalizer.mjs — passed
node --check backend/src/repair-loop.mjs — passed
node --check backend/src/task-final-writeback.mjs — passed
node -e 'import("./backend/src/task-finalizer.mjs")' — import OK
node -e 'import("./backend/src/repair-loop.mjs")' — import OK
```

# Productization Hardening

## 2026-07-10 P0 hard blockers

Actual code state reviewed in this task:

- `backend/src/agent-execution-backends.mjs` imported under Node ESM, but contained stale generated residue after `resolveBackendSource`: an extra `/**` plus `});` inside the next JSDoc, and a duplicate semicolon after `ROLE_BACKEND_DEFAULTS`. The residue was removed so the module is cleanly parseable and importable.
- `backend/src/task-final-writeback.mjs` called `shouldAttemptRepairFn` and `createRepairGoalFromFindingsFn` synchronously in integration-repair and closure-repair paths. Those dependency hooks are awaited in `task-general-processor.mjs` and tests commonly provide async implementations, so final writeback now awaits both hooks in both paths.
- `backend/src/task-general-processor.mjs` used `uniqueStrings` in the `already_integrated` delivery recovery path without defining it. A local helper now deduplicates non-empty string warnings before writeback.

Verification run:

- `node -e 'import("./backend/src/agent-execution-backends.mjs").then(() => console.log("agent-execution-backends import ok"))'` - passed.
- `npm --prefix backend run check:syntax` - passed, 506 files checked.
- `npm --prefix backend run check:imports` - passed, `imports ok`.
- `node --test --test-reporter=dot backend/test/agent-execution-backends.test.mjs backend/test/pipeline-orchestration.test.mjs` - passed.
- `node --test --test-reporter=dot backend/test/task-general-processor.test.mjs` - passed.
- `node --test --test-reporter=dot --test-name-pattern='repairable acceptance blockers create traceable follow-up task|integration repair awaits async repair helpers' backend/test/task-final-writeback.test.mjs` - passed.

Known remaining risk:

- Full `backend/test/task-final-writeback.test.mjs` still has four existing failures unrelated to this task's P0 fixes: dependent queue unblock assertions, dirty auto integration queue blocking, queue item sync for `waiting_for_repair`, and goal status wording for missing evidence. These failures were present before the await fixes were applied and should be handled as a separate closure/queue consistency task.

## 2026-07-10 Closure State Machine Convergence -- Second Repair

Fixed the convergence bug that left Closure repair tasks stuck in `waiting_for_repair` when the existing repair task was terminal (failed/no-change) and repair budget remained.

### Problem

A parent task in `waiting_for_repair` had its child repair task complete with a terminal outcome (failed or no-change). `handleRepairCompletion` was only called when `taskStatus === "completed"` and always passed `passed: true`. This meant:
- Failed repair children never triggered `handleRepairCompletion` -- the parent's stale `repair_goal_id`/`repair_task_id` metadata remained intact.
- `hasRepairPath()` in the finalizer kept returning `true` based on the stale metadata.
- `repairAttemptsRemaining()` defaulted to `true` when no explicit budget info was present.
- The finalizer kept returning `waiting_for_repair`, creating an infinite loop with no new repair task created.

### Fix (3 files changed)

**1. `backend/src/repair-loop.mjs` -- `handleRepairCompletion`:**
- On `!passed`: check remaining repair budget before deciding parent status.
  - Budget remains (`can_continue`): keep parent in `waiting_for_repair`, increment `repair_attempt`, clear stale `repair_goal_id`/`repair_task_id`/`repair_goal` from parent result, let the worker loop schedule the next repair attempt.
  - Budget exhausted: move to `human_interrupted_for_repair_budget_exhausted` (explicit human-review terminal state, not plain `failed`).
- On `passed`: also clear stale repair path metadata from parent result so `hasRepairPath()` re-evaluates cleanly.

**2. `backend/src/task-final-writeback.mjs` -- repair completion hook:**
- Moved `handleRepairCompletion` call outside the `taskStatus === "completed"` guard.
- Now fires for ANY terminal child outcome (`completed`, `failed`, `cancelled`).
- `passed` is computed correctly: `taskStatus === "completed" && verification?.passed === true && no blocker findings`.

**3. `backend/src/task-finalizer.mjs` -- `hasRepairPath`:**
- Added stale-path guard: if `result.repair_outcome` exists with a known terminal value (`repaired`, `continued`, `budget_exhausted`, `failed`) or `result.repair_status === "completed"`, return `false`.
- Prevents the finalizer from re-entering `waiting_for_repair` on metadata that was already processed by `handleRepairCompletion`.

### Behavior Changes

| Scenario | Before | After |
|----------|--------|-------|
| Repair child failed, budget remains | Parent marked `failed` | Parent stays `waiting_for_repair`, next attempt created |
| Repair child failed, budget exhausted | Parent marked `failed` | Parent moved to `human_interrupted_for_repair_budget_exhausted` |
| Repair child passed (repaired) | Parent updated, metadata lingers | Parent updated, stale path cleared, finalizer re-evaluates cleanly |
| Finalizer sees already-repaired parent | Infinite loop `waiting_for_repair` | `hasRepairPath` returns `false`, proceeds to terminal or review |
