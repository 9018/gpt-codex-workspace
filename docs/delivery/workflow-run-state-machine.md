# Workflow Run State Machine

`workflow_run` is an additive persisted execution model for GPTWork. It does not replace the existing `goal`, `task`, `goal_queue`, result, reviewer decision, or worktree lifecycle records. Instead it records a compact run snapshot that ties those records together for status display and recovery diagnostics.

## Storage

Run files are written under:

```text
.gptwork/workflow_runs/<run_id>.json
```

For task-backed runs, `<run_id>` is the task id. This keeps `create_goal` and `create_task` compatibility paths simple: when either path creates a Codex task, GPTWork creates a matching run file as a side effect while preserving the existing tool response shape.

## Shape

Each run contains:

- `schema_version`: currently `1`.
- `run_id`, `workflow_id`, `goal_id`, `task_id`, `queue_id`: cross-record identifiers.
- `status`: normalized run status.
- `current_step`: user-facing step, such as `goal_created`, `task_queue`, `codex_execution`, `waiting_for_lock`, `reviewer_decision`, `verification`, or `completed`.
- `blocking_reason` and `blocker`: the current blocker, when known.
- `refs`: non-authoritative references such as source path or task status.
- `events`: in-file event trail for creation, transitions, and diagnostic notes.
- `created_at`, `updated_at`, `last_event_at`: recovery timestamps.

## Statuses

Allowed run statuses are:

```text
created -> queued -> running -> completed
                   -> blocked -> queued|running|waiting_for_review|completed|failed|cancelled
                   -> waiting_for_review -> running|blocked|completed|failed|cancelled
                   -> failed|cancelled
```

Terminal statuses are `completed`, `failed`, and `cancelled`. Illegal transitions throw before the run file is rewritten.

## Status Tool Integration

`workflow_status` now returns:

- `workflow_run`: compact run view.
- `current_step`: top-level alias for card and text display.
- `blocking_reason`: top-level alias when the run is blocked.

Existing `workflow_status` fields remain intact. If no run exists for the selected task, the status tool creates one from the current task state and diagnostics. If a run has a richer persisted blocker than the task snapshot, the persisted blocker is preserved.

## Recovery Diagnostics

`diagnoseWorkflowRun(workspaceRoot, runId, { now, staleAfterMs })` reports whether a non-terminal run is stale based on `last_event_at`, includes the current step and blocker, and returns a recovery hint that points operators back to the task and queue records. This gives recovery tooling a single entrypoint while keeping task, queue, result, reviewer decision, and worktree records authoritative.
