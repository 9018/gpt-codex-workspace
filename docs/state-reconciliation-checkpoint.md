# State Reconciliation Checkpoint

This document defines the productized recovery checkpoint used when GPTWork cannot safely advance a task from logs alone.

## Purpose

The checkpoint converts ambiguous task states into a durable decision snapshot instead of asking the user to manually decide or blindly retrying the same implementation task.

Target loop:

```text
Goal -> Task -> Agent execution -> Evidence collection -> Acceptance verification -> Replan / Continue / Stop
```

## Default GPTChat policy

When a task reports `human review required`, `needs GPTChat decision`, `human interrupt required`, or an equivalent review gate, GPTChat should make the default judgment and continue with guardrails.

Guardrails:

- Do not force-clear locks.
- Do not overwrite or discard dirty worktree changes.
- Do not fake completion.
- Do not bypass acceptance.
- Prefer `partial` or `blocked-with-next-action` unless evidence is sufficient for `passed`.

## Required snapshot fields

A `decision_snapshot` or `state_reconciliation_checkpoint` must include:

- `task_id` and `goal_id` when known.
- `primary_signal`: one of `canonical_dirty`, `result_missing`, `no_op_without_evidence`, `active_lock_or_running_worker`, `waiting_for_review`, `codex_failed`, or `needs_reconciliation`.
- `verdict`: usually `partial` or `blocked-with-next-action`; only use `passed` with sufficient evidence.
- `decision`: `continue`, `replan`, or `stop`.
- `next_action`: the smallest safe next action.
- `guardrails`: non-destructive execution constraints.
- `state.changed_files`, `state.evidence_paths`, `state.retained_worktrees`, and any dirty-path classification.
- `required_evidence`.
- documentation updates required before closure.

## Signal policy

### `canonical_dirty`

Decision: `replan`.

Next action: attribute dirty paths before repair.

Required behavior:

1. Do not reset, clean, or overwrite canonical dirty paths.
2. Attribute each dirty path to prior work, current work, generated artifact, or unknown source.
3. Split the next task into the smallest safe repair or evidence task.
4. Require `result.json`, `result.md`, review packet, acceptance bundle, test commands, changed files, evidence paths, and docs update.

### `result_missing` / `no_op_without_evidence`

Decision: `replan`.

Next action: collect result and acceptance evidence.

Required behavior:

1. Do not retry broad implementation immediately.
2. Inspect retained worktrees and logs.
3. Produce an evidence packet first.
4. Only create an implementation follow-up after the missing evidence is attributed.

### `active_lock_or_running_worker`

Decision: `continue`.

Next action: append requirements to the current task or queue a non-conflicting follow-up.

Required behavior:

1. Do not force-clear the lock.
2. Do not抢占 the active worker.
3. Append correction, acceptance, evidence, and docs requirements to the current task/workflow log.

### `waiting_for_review`

Decision: `continue`.

Next action: GPTChat default continue with guardrails.

Required behavior:

1. Treat GPTChat as the default decision-maker.
2. Use `partial` when evidence is incomplete.
3. Use `passed` only when changed files, tests, result artifacts, and acceptance evidence are sufficient.

## Implementation entry point

`backend/src/state-reconciliation-checkpoint.mjs` exports:

```js
buildStateReconciliationCheckpoint(input)
```

The helper is intentionally pure so it can be used by worker loops, review reconciliation, repair-loop planning, or GitHub/ChatGPT sync without touching the filesystem.

## Verification

Focused verification:

```bash
cd backend && node --test --test-reporter=dot test/state-reconciliation-checkpoint.test.mjs
```

Broader verification before merge:

```bash
cd backend && npm run check:syntax
cd backend && npm run check:imports
cd backend && npm test
```

## Closure requirement

A task blocked by dirty/no-op/lock/review states should not be marked completed until the checkpoint records enough evidence to justify `passed`. Otherwise, close with `partial` or `blocked-with-next-action` and a precise next task.
