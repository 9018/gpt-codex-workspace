# Task State Machine

> Describes the full lifecycle of a task in the delivery system.

## States

```
created → queued → waiting_for_dependency → queued → waiting_for_lock
                                                              ↓
                                              materializing_worktree
                                                      ↓
                                                  assigned
                                                      ↓
                                                  running → timed_out
                                                      ↓
                                                verifying ──────► completed
                                                   ↓
                                           waiting_for_repair
                                                   ↓
                                              repairing
                                                   ↓
                                              verifying (re-entry)
                                                   ↓
                                        waiting_for_integration
                                                   ↓
                                              integrating
                                                   ↓
                                              completed
```

### Terminal States

- **completed**: Task passed all stages (verification, acceptance, integration).
- **failed**: Task failed irrecoverably (codex error, fatal integration conflict).
- **waiting_for_review**: Task exceeded repair budget or requires human intervention.
- **cancelled**: Task was cancelled before completion.
- **timed_out**: Task execution timed out.

## State Transition Rules

| From | To | Condition |
|---|---|---|
| created | queued | Task is enqueued via `enqueueGoal` |
| queued | waiting_for_dependency | Dependency not satisfied |
| queued | waiting_for_lock | Repo lock acquired by another task |
| queued | running | No dependencies, no lock conflicts |
| waiting_for_dependency | queued | Dependency completed |
| waiting_for_lock | queued | Lock released |
| waiting_for_lock | materializing_worktree | Lock acquired, worktree needed |
| materializing_worktree | running | Worktree ready |
| assigned | running | Worker picks up task |
| running | verifying | Codex execution complete |
| running | failed | Codex error |
| running | waiting_for_review | Runtime change without restart |
| running | timed_out | Execution timeout |
| verifying | waiting_for_repair | Acceptance found blocker/major issues |
| verifying | completed | Acceptance passed (noop/docs-only) |
| verifying | waiting_for_integration | Acceptance passed, code changes exist |
| verifying | failed | Verification error |
| waiting_for_repair | repairing | Repair task created |
| repairing | verifying | Repair executed |
| waiting_for_integration | integrating | Integration lock acquired |
| integrating | completed | Merge/push/PR successful |
| integrating | waiting_for_review | Integration conflict, repair budget exceeded |

## Validation

The state machine is enforced by `validateTaskStateTransition(from, to)` in
`backend/src/delivery-contracts.mjs`. Each transition must be explicitly listed
in `LEGAL_TRANSITIONS` or it is rejected.
