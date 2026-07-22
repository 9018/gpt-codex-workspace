# Closed-Loop Automation

> Source-backed as of 2026-07-22.

## Loop

```text
Goal
  -> Task
  -> Execution Provider
  -> Evidence
  -> Acceptance / Convergence
  -> Repair | Integration | Review | Complete
  -> Next Goal / Queue Advance / Stop
```

This loop is implemented primarily by:

- goal/task creation services
- `codex-worker-loop.mjs`
- `codex-worker-runner.mjs`
- `task-processing/task-execution-runner.mjs`
- acceptance / repair / integration / finalizer modules
- goal queue auto-advance

## Stage Details

### 1. Goal creation

Primary client path:

```text
create_encoded_goal(preview_text, payload_base64, assign_to_codex=true)
```

Backend:

1. decodes payload
2. creates goal + conversation/memory context
3. writes goal workspace files
4. creates linked codex task (`mode=full`)

Compatibility paths:

- `create_goal`
- `create_task` then `ensureTaskGoal`

### 2. Scheduling

Worker tick selects actionable codex tasks:

- assigned / queued / running-related active states
- waiting_for_lock
- waiting_for_repair
- waiting_for_integration
- selected review recovery cases

If active capacity remains, queue may auto-start ready goals.

### 3. Execution

For each task:

1. ensure goal and pipeline scaffolding
2. resolve repo and execution cwd
3. lock path if needed
4. run provider:
   - `codex_tui_goal` default
   - `codex_exec` explicit/fallback
5. collect durable result evidence

### 4. Evidence

Evidence sources include:

- `result.json` / `result.md`
- session/TUI collection artifacts
- git worktree status / commit / changed files
- tests and verification reports
- acceptance findings
- integration results

Missing evidence is not treated as ordinary “implementation failed, retry forever”.

### 5. Acceptance and convergence

`runAcceptanceAgent` + `convergeTaskAfterRun` decide:

- complete
- repair
- wait for capacity/retry
- fail/block
- escalate to review

### 6. Repair

If repairable and budget remains:

1. create repair goal/task
2. parent enters `waiting_for_repair`
3. worker later executes repair task
4. repair completion can converge parent

If budget is exhausted or failure is non-repairable, escalate.

### 7. Integration

If acceptance passes and code/config/runtime changes exist:

1. run integration queue
2. maybe auto-integration completion
3. terminal complete, repair, or `waiting_for_integration`

If no such changes, integration may be marked `not_required`.

### 8. Pipeline gate and final writeback

Before closure:

- agent_runs gates are evaluated
- finalizer decision is applied
- task/goal/result files are written back
- queue auto-advance may start the next ready item

## Stop Conditions

The loop stops or parks when:

- product/goal acceptance is satisfied
- task is terminal failed/blocked/cancelled
- human review is required
- external capacity/provider is unavailable
- integration is waiting on external conditions

## Anti-patterns Explicitly Avoided

```text
model says done
  != task completed

result.json missing
  != auto rerun original task forever

small mid-run deviation
  != always open a brand-new goal

verification failed once
  != unlimited repair creation
```

Correct control is budgeted, evidence-based, and status-typed.
