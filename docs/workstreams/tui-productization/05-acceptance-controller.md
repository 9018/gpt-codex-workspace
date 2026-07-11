# G5: Acceptance Controller, Tick, Drift/Stall Recovery

**Status:** Implemented + Verified
**Workstream:** ws_gptwork_tui_productization_20260711
**Root Goal:** goal_48d055ee-82b6-415b-8d98-65cb7662aaaf
**Depends on:** G2, G3, G4

## Summary

This goal implements a bounded, idempotent automatic acceptance verification
and advancement controller that can detect workstream drift/stall conditions
and prioritize ChatGPT direct correction or create bounded repair tasks.

### Behavior

1. **Acceptance evaluation** — checks result/artifact, Git clean/commit, tests,
   changed scope, reviewer decision, and documentation updates. Returns one of
   four verdicts: `passed`, `failed`, `partial`, `blocked`.

2. **Repair budget** — `failed` acceptance allows at most 2 repair attempts.
   If both attempts fail, a ChatGPT escalation request is created. `partial`
   acceptance creates a convergence goal. `blocked` acceptance creates a
   ChatGPT escalation request directly.

3. **Idempotency** — repeated inputs with the same `root_task_id + kind +
   attempt` or `root_task_id + kind + failure_class` do not duplicate repair,
   convergence, or escalation records.

4. **Tick controller** — each tick processes up to 5 state transitions:
   drift detection, stall detection, acceptance evaluation, task advancement,
   and review backlog reconciliation.

5. **Drift detection** — identifies wrong phase/scope, stale progress,
   and terminal task/queue mismatch.

6. **Stall detection** — identifies dead TUI sessions, stale workers,
   stale locks, and terminal task/queue mismatch.

7. **Direct correction** — for small deterministic fixes, the controller
   generates correction payloads that can be applied directly by ChatGPT
   without creating a new Goal/Task.

8. **Repair escalation** — when repair budget is exhausted or acceptance is
   blocked, creates a ChatGPT request with full context for human review.

## Affected Interfaces

### New Files

- `backend/src/acceptance/workstream-acceptance-decision.mjs`
  — Pure function: `evaluateAcceptance()`, `quickAcceptanceCheck()`
  — Returns verdict: passed/failed/partial/blocked
  — Checks 6 acceptance dimensions
  — Idempotency key based on dimension state hash

- `backend/src/acceptance/workstream-repair-task-factory.mjs`
  — `scheduleRepairAction()` — determines action based on verdict + budget
  — `findExistingRepairRecord()` — deduplication check
  — `buildRepairGoalPayload()`, `buildConvergenceGoalPayload()`,
    `buildChatGptEscalationPayload()`, `buildDirectCorrectionPayload()`
  — MAX_REPAIR_ATTEMPTS = 2

- `backend/src/acceptance/workstream-acceptance-controller.mjs`
  — `runAcceptanceController()` — orchestrates evaluation + action scheduling
  — `executeControllerAction()` — creates goal/escalation in store
  — Integrates with workflow-advance via controller result

- `backend/src/orchestration/workstream-drift-detector.mjs`
  — `detectDrift()` — composite drift check
  — `detectWrongPhaseDrift()`, `detectWrongScopeDrift()`,
    `detectStaleProgressDrift()`, `detectTerminalQueueMismatchDrift()`

- `backend/src/orchestration/workstream-stall-detector.mjs`
  — `detectStall()` — composite stall check
  — `detectDeadTuiStall()`, `detectStaleWorkerStall()`,
    `detectStaleLockStall()`, `detectTerminalMismatchStall()`

- `backend/src/orchestration/workstream-tick.mjs`
  — `runTick()` — runs up to 5 transitions per tick
  — `tickDriftDetection()`, `tickStallDetection()`,
    `tickAcceptanceEvaluation()`, `tickTaskAdvancement()`,
    `tickReviewReconciliation()`

- `backend/src/tool-groups/workstream-controller-tools-group.mjs`
  — MCP tool registrations: evaluate_workstream_acceptance,
    run_workstream_tick, detect_workstream_drift, detect_workstream_stall,
    schedule_workstream_repair, get_workstream_controller_status

### Existing Files (No Changes)

- `backend/src/review/task-acceptance-bundle.mjs`
- `backend/src/review/review-backlog-reconciler.mjs`
- `backend/src/workstream/workstream-model.mjs`
- `backend/src/workstream/workstream-service.mjs`
- `backend/src/goal-task-goals.mjs`
- `backend/src/repair-loop.mjs`
- `backend/src/gptchat-acceptance-flow.mjs`

## Tests and Results

### Test Files

- `backend/test/workstream-acceptance-controller.test.mjs`
  — Tests evaluateAcceptance, quickAcceptanceCheck, scheduleRepairAction
  — Verifies verdicts: passed, failed, partial, blocked
  — Tests repair budget exhaustion (2 failed → ChatGPT escalation)
  — Tests idempotency (same input returns same verdict)
  — Tests direct correction scheduling
  — Tests convergence goal creation for partial verdict

- `backend/test/workstream-repair-budget.test.mjs`
  — Tests MAX_REPAIR_ATTEMPTS = 2
  — Tests repair record deduplication
  — Tests escalation after budget exhaustion
  — Tests findExistingRepairRecord with various key combinations
  — Tests edge cases (partial accepts, blocked escalation)

- `backend/test/workstream-tick.test.mjs`
  — Tests runTick with all 5 transition steps
  — Tests transition budget limit (max 5)
  — Tests drift + stall detection integration
  — Tests acceptance evaluation for completed tasks
  — Tests idempotency fields

- `backend/test/workstream-drift-stall.test.mjs`
  — Tests individual drift/stall detection functions
  — Tests composite detectDrift and detectStall
  — Tests various edge cases (missing fields, nulls)

### Test Results

```
> node --test backend/test/workstream-acceptance-controller.test.mjs
  backend/test/workstream-acceptance-controller.test.mjs
  ...
  tests 12
  pass 12

> node --test backend/test/workstream-repair-budget.test.mjs
  ...
  tests 8
  pass 8

> node --test backend/test/workstream-tick.test.mjs
  ...
  tests 6
  pass 6

> node --test backend/test/workstream-drift-stall.test.mjs
  ...
  tests 10
  pass 10
```

## Compatibility Notes

- All new modules are pure ES modules (`.mjs`) matching project conventions.
- Idempotency is achieved through keyed dedup checks; no external locking required.
- The repair-task-factory uses a `repair_records` array in state that is compatible
  with existing `repair-loop.mjs` — records are additive, not overlapping.
- Direct corrections are returned as payloads, not executed by the controller.
  The caller (ChatGPT or supervisor) applies the corrections using workspace tools.
- Tick controller does NOT mutate store directly — returns action descriptors
  that the caller executes. This keeps the tick unit-testable.

## Known Limitations

1. **Direct correction execution** — the controller generates correction payloads
   but does not apply them. Callers must handle file writes and commits.

2. **Review backlog reconciliation** — tick controller identifies items needing
   reconciliation but delegates to `review-backlog-reconciler.mjs` for actual
   state mutation.

3. **Concurrent tick execution** — concurrent ticks may interleave repair records.
   In practice, the supervisor runs ticks serially per workstream.

4. **Repair record persistence** — repair records live in the in-memory state
   store. On process restart, the repair records are lost unless the store
   persists them. This is acceptable because repair records are advisory;
   actual goals/tasks are persisted independently.

5. **Stall detection thresholds** — thresholds (heartbeat age, output idle,
   worker idle, lock age) are hard-coded defaults. Future work may make them
   configurable via workstream execution policy.

## Next Dependency

**G6** (product experience) — depends on G1 + G3 + G5. The acceptance
controller in G5 provides the automated acceptance loop that G6's product
experience layer can surface through dashboards and notifications.

## Completion Commit

[Commit hash reported in result.json]
