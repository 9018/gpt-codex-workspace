# Acceptance and Repair Contract

> Defines how task results are verified, accepted, and automatically repaired.

## Acceptance Profiles

| Profile | Required Checks | Relaxed Checks |
|---|---|---|
| `default` | result_json_valid, summary_present, changed_files_safe_paths, verification_present_for_non_noop, verification_passed, worktree_clean, no_blocker_or_major_findings | — |
| `code_change` | extends default + tests_present, commit_or_patch_evidence, changed_files_match_git | — |
| `docs_only` | extends default + docs_paths_only | tests_present |
| `config_change` | extends default + commit_or_patch_evidence | tests_present |
| `deploy` | extends code_change + safe_restart_evidence, post_restart_verification | — |
| `noop` | result_json_valid, summary_present, noop_reason_present | — |

### Severity Policy

| Severity | Action |
|---|---|
| `blocker` | Must repair or review — blocks completion |
| `major` | Must repair or review — blocks completion |
| `minor` | Accepted with follow-up tasks |
| `followup` | Accepted with follow-up tasks |

## Evidence Requirements

Before acceptance, the following evidence is collected:

1. **Git status**: Dirty/clean state of the worktree.
2. **Diff summary**: What files were changed.
3. **Commit exists**: Whether changes were committed.
4. **Changed files from git**: Canonical list of changed paths.
5. **Verification log**: Output of verification commands.
6. **Result parse status**: Whether result.json was valid.
7. **Safe restart marker**: Whether runtime changes have restart markers.

## Repair Loop

When acceptance fails with blocker or major findings:

1. Acceptance agent generates `repair_proposals` with specific findings.
2. A `repairing` task is created with `parent_task_id` and `root_task_id`.
3. The repair prompt includes: original goal, what was changed, what failed, what to fix.
4. Repair reuses the original worktree if possible; otherwise creates a `gptwork/<root_id>-repair-<attempt>` worktree.
5. After repair, the task re-enters `verifying` for re-acceptance.
6. Repair attempts are bounded by `GPTWORK_MAX_REPAIR_ATTEMPTS` (default: 2).
7. If repair budget is exceeded, the task enters `waiting_for_review` with full evidence.

Repair can be triggered by verifier failure or by the acceptance gate returning a repairable `waiting_for_repair` closure decision. In both cases, the parent task result records the created repair goal and task ids and remains compatible with the existing `repair_goal`, `repair_goal_id`, `repair_task_id`, `repair_attempt`, and `repair_of_attempt` fields.

### Follow-up Processing Attribution

Every unaccepted task that is converted into a follow-up repair records `result.followup_processing` so the loop can be audited without reading the full transcript:

| Field | Meaning |
|---|---|
| `kind` | Always `unaccepted_task_followup` for this record. |
| `source_task_id` | The task that failed acceptance. |
| `source_goal_id` | The goal linked to the source task. |
| `root_task_id` | The root task for multi-attempt repair chains. |
| `followup_goal_id` | The repair/follow-up goal created for the next handling pass. |
| `followup_task_id` | The repair/follow-up Codex task created for the next handling pass. |
| `handling_attempt` | One-based handling attempt for the repair loop. |
| `handling_result` | Status, closure status, reason, failure class, acceptance status, and pass/fail result that caused the follow-up. |
| `blockers` | Repairable blockers or review blockers attributed to this follow-up. |
| `auto_enqueue` | `true` when a follow-up goal or task was created automatically. |

The same record is included in fallback `result.json`, so source task, source goal, handling count, and handling result remain traceable from durable task state and goal artifacts.

### Special Self-Healing Repairs

| Error | Recovery |
|---|---|
| ENOSPC / tmp write failure | Cleanup tmp, retry prompt write |
| No first output timeout | Compact context bundle, retry |
| Stale repo lock | Archive/reconcile, retry waiting tasks |
| Worker crash | Reconciler detects no heartbeat, preserves worktree, creates recovery task |
| Result.json missing | Stdout/last-message parser fallback |
