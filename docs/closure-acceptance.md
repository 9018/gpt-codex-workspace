# GPTWork Closure and Acceptance Model

> Architecture documentation for the acceptance gate, contract verification,
> finalizer, unified decision model, and automated terminalization rules.

**Status:** Current
**Last reviewed:** 2026-07-07

---

## 1. Acceptance Gate Engine

The acceptance gate (`src/acceptance-gate-engine.mjs`) orchestrates the flow
from a completed task result through verification, contract verification,
closure decision, and acceptance verdict production. It is invoked by
`task-final-writeback.mjs` after Codex completes execution.

### Flow

1. **Load result** — Read `result.json` directly or from the task result object.
2. **Load contract** — Resolve the acceptance contract from the goal definition,
   the task result, or the adjacent `acceptance.contract.json` file.
3. **Verify** — Run `task-verifier.mjs` (`verifyTaskCompletion`) to perform
   deterministic checks: syntax, imports, changed-files diff, and any
   profile-scoped verification suite defined by the contract.
4. **Verify contract** — Run `acceptance/contract-verifier.mjs`
   (`verifyAcceptanceContract`) to check all blocking requirements against
   the result evidence.
5. **Decide closure** — Run `closure/task-closure-decider.mjs`
   (`decideTaskClosure`) with the contract, contract verification, verification
   result, integration evidence, and deployment evidence to produce a closure
   status.
6. **Produce acceptance verdict** — A JSON artifact at `acceptance.json` in the
   goal directory containing `status`, `passed`, `closure_decision`, `findings`,
   and artifact paths.

### Gate Statuses

| Status | Meaning |
|---|---|
| `passed` | closure allows auto-complete AND verification passed |
| `failed` | closure status is `failed` or result status is `failed` |
| `needs_action` | all other states (review, repair, integration needed) |

---

## 2. Contract Verification

The contract verifier (`src/acceptance/contract-verifier.mjs`) validates each
blocking requirement against the task result evidence. Requirements are defined
in `acceptance.contract.json` (blocking_requirements array) and hydrated from
default profiles based on `operation_kind`.

### Blocking Requirements

| Requirement ID | Description | Evidence Checked |
|---|---|---|
| `commit_present` | A commit hash must exist | `result.commit` is non-empty, non-"none" |
| `changed_files_reported` | Changed files must be listed | `result.changed_files` is an array with items |
| `diff_reported` | Commit diff must be verifiable | `result.diff_reported === true` or diff is available |
| `verification_report` | Verification commands passed | `result.verification.passed === true` |
| `integration_completed` | Integration reached terminal state | Integration status is merged/skipped/not_required, or auto-integration completed |

### Non-Mutating Operations

Tasks whose `operation_kind` is one of `readonly_validation`, `noop`,
`already_integrated`, or `diagnostic` are classified as **non-mutating**.
These operations do not produce `changed_files` or new commits and pass
through contract verification without being blocked by missing commit or
changed-files evidence. The operation-kind profile set is defined in
`task-finalizer.mjs` as `NO_MUTATION_PROFILES`.

### No-Change Repair

When a no-change repair cycle (`no-change-repair-classifier.mjs`) determines
`completion_eligible === true`, it satisfies commit, changed-files, diff,
and integration requirements directly — allowing terminal completion without
real source mutations.

### Contract Validity and Semantics

- **Invalid contract** (`contract_valid === false`): Requires human review.
- **Semantic ambiguity** (`semantic_ambiguity === true`): Requires human
  review, bypasses auto-completion.
- **State assertions**: Verified separately; failure requires review.

---

## 3. Finalizer

The finalizer (`src/task-finalizer.mjs`, `decideTaskFinalState`) is the last
decision stage that determines the terminal or non-terminal status for a task.
It runs after the acceptance gate and considers evidence from:

- Codex execution result (`codex_result`)
- Verification result
- Acceptance gate verdict
- Contract verification
- Integration result
- Runtime/restart guard
- Repair budget

### Decision Order

1. **Capacity failure** — External rate-limit or quota exhaustion triggers
   `waiting_for_capacity` (requires retry after backoff, not code repair).
2. **Manual review blockers** — Semantic ambiguity, manual approval required,
   or state corruption triggers `waiting_for_review`.
3. **No-change repair completion** — If the no-change repair classifier says
   `completion_eligible === true`, the task completes immediately.
4. **Terminal evidence satisfied** — If verification passed AND acceptance
   passed AND contract blocking passed AND integration satisfied AND no
   unresolved blocker-findings → status is `completed` with
   `safe_to_auto_advance === true`.
5. **Integration non-terminal** — If verification and acceptance and contract
   are all satisfied but integration is still pending/branch-pushed/PR-opened
   → status is `waiting_for_integration`.
6. **Repairable failures** — If verification failed, codex failed, or
   integration has a repairable status (conflict, check_failed, push_failed,
   pr_failed) and repair budget remains → status is `waiting_for_repair`.
7. **Budget exhausted** — Repair budget used up → `waiting_for_review`.
8. **Terminal unrecoverable** — Timed-out or failed without repair path →
   `timed_out` or `failed`.
9. **Fallback** — `waiting_for_review` with insufficient terminal evidence.

### Integration Detection

Integration is required when `changed_files` has items and a commit exists,
unless the `operation_kind` belongs to `NO_MUTATION_PROFILES`. Integration is
satisfied when:

- `integration.satisfied === true`, or
- `integration.merged === true`, or
- `integration.auto_completed === true`, or
- The integration status is one of `merged`, `ff_only_merged`, `skipped`,
  `not_required`

---

## 4. Unified Decision Model

The unified decision normalizer (`src/codex-unified-decision.mjs`) produces a
single canonical `UnifiedAcceptanceDecision` from the finalizer, closure
decider, gate, convergence, verification, and contract verification. It is
stored in `taskResult.unified_decision` and consumed by:

- Goal convergence
- Queue propagation
- Review packet builder
- Notification service

### Canonical Fields

| Field | Type | Description |
|---|---|---|
| `status` | string | `completed`, `failed`, `waiting_for_review`, `waiting_for_repair`, `waiting_for_integration`, `waiting_for_capacity`, etc. |
| `reason` | string | Human-readable reason for the decision |
| `closure_reason` | string | Structured closure reason code |
| `profile` | string | Acceptance profile (code_change, sync_only, etc.) |
| `blocking_passed` | bool | True when no blocker/major findings remain |
| `requires_review` | bool | True when human review is needed |
| `requires_repair` | bool | True when automatic repair is needed |
| `requires_integration` | bool | True when integration not yet terminal |
| `requires_restart` | bool | True when runtime restart is needed |
| `safe_to_auto_advance` | bool | True when queue/goal can auto-advance |
| `blockers` | Array | Blocking findings: `{severity, code, message, source}` |
| `repairable_blockers` | Array | Findings that can be auto-repaired |
| `non_blocking_followups` | Array | Followup items (do not block completion) |
| `quality_notes` | Array | Quality notes (do not block completion) |
| `findings` | Array | All findings combined |
| `integration_effect` | object | `{required, status, satisfied, terminal}` |
| `goal_effect` | object | `{status, complete_goal, safe_to_auto_advance}` |
| `queue_effect` | object | `{status, unblock_dependents, hold_queue}` |
| `source` | string | Which module produced the decision |

### Status Categories

- **Terminal**: `completed`, `failed`, `blocked`, `timed_out`
- **Non-terminal hold**: `waiting_for_review`, `waiting_for_human_review`,
  `waiting_for_repair`, `waiting_for_integration`, `waiting_for_capacity`,
  `retry_wait`, `quota_wait`, `restart_pending`

Downstream consumers MUST prefer `unified_decision` over re-deriving status
from individual decision objects when the field is present.

---

## 5. Closure Decision Model

The closure decider (`src/closure/task-closure-decider.mjs`) decides whether a
task should auto-complete, wait for repair, or require human review.

### Closure Statuses

| Status | Meaning |
|---|---|
| `auto_completed_clean` | All gates passed, no followups |
| `auto_completed_with_followups` | All gates passed, non-blocking items noted |
| `waiting_for_repair` | Repairable failures (verification, integration, contract) |
| `requires_review` | Non-repairable failures, semantic ambiguity, safety concerns |
| `failed` | Terminal failure — no recovery path |

### Decision Sequence

1. Contract validity check → invalid requires review
2. Semantic ambiguity check → requires review
3. Verification pass/fail → repair or review
4. State assertion pass/fail → review
5. Contract blocking requirements → repair or review
6. Commit evidence (when required) → review if missing
7. Integration requirement (P0-C5):
   - If no integration status → `integration_completed_missing` (recoverable)
   - If status is pending/queued/waiting → `integration_completed_missing`
   - If failed (conflict, check_failed, etc.) → `integration_unsatisfied`
8. Deployment/health check → review if unsatisfied
9. Operation safety audit → review if evidence missing
10. Result not failed → auto-complete clean or with followups

### P0-C5 Integration Evidence

The decider differentiates two integration-failure cases:

- **integration_completed_missing**: No integration was attempted or status is
  unknown/pending/queued/waiting. This is a **deterministic recovery path**:
  `delivery-result-recovery` can detect and repair it.
- **integration_unsatisfied**: Integration was attempted but did not reach
  terminal state (conflict, check_failed, push_failed). Requires investigation.

---

## 6. Generic Terminalization Rule

The core terminalization rule for tasks after auto-terminalization is:

> If all of the following conditions hold, the task SHOULD complete
> automatically without requiring human intervention:
>
> 1. **Accepted** — The acceptance gate passed (verification passed, blocking
>    requirements satisfied, contract verified).
> 2. **Verification passed** — Task verification (syntax, imports, tests,
>    release checks) passed with clean status.
> 3. **Commit reachable / already integrated** — The task commit exists in
>    the repository and is already reachable from the canonical branch, or
>    has been fast-forward merged.
> 4. **Clean repo** — The canonical repository is not dirty at merge time.
> 5. **No restart required** — The task does not require a runtime restart
>    or the restart has been completed.
> 6. **Integration satisfied / terminal** — Integration evidence indicates
>    merged, already-integrated, or explicitly not-required status.
>
> **Genuine blockers must remain blocking.** Findings with severity
> `blocker` or `major` that are unresolved block auto-completion. The
> system does not sweep genuine failures under non-blocking categories.

This rule is implemented by `closure/task-closure-decider.mjs` in the
decision sequence (steps 1-10 above) and by `task-finalizer.mjs` in the
terminal evidence check. When all gates pass, the closure decider returns
`auto_completed_clean` or `auto_completed_with_followups`, and the finalizer
returns `completed` with `safe_to_auto_advance === true`.

### Future-Task Applicability

This is a generic rule. Any future task (regardless of topic, milestone, or
task_id) should follow the same terminalization logic. There are no hardcoded
task-id special cases. The rule applies equally to code-change tasks
(integration required) and noop/sync/diagnostic tasks (no integration needed).

---

## 7. Automated Terminalization Details

### 7.1 `integration_completed` Evidence

`integration_completed` as a blocking requirement is satisfied when ANY of
the following hold:

- `integration.merged === true` (ff-only merge completed in canonical repo)
- `integration.auto_completed === true` (auto-integration-completion ran)
- `integration.status` is `merged`, `ff_only_merged`, `skipped`, or
  `not_required`
- Auto-integration completed (`auto_integration_completion.completed === true`)
  and verification did not fail

When integration is not required (noop, readonly, already_integrated,
diagnostic), `integration_completed` is automatically satisfied.

### 7.2 `delivery_result_recovery` / `already_integrated` Semantics

The delivery result recovery module (`src/delivery-result-recovery.mjs`) runs
when Codex fails to produce a valid result or the task's worktree is dirty.

**Recovery triggers** (via `analyzeDeliveryRecoveryCandidate`):
- `commit_missing` — commit evidence missing despite changed files
- `dirty_worktree_after_codex` — worktree has unstaged changes
- `result_missing` — no valid result.json
- `codex_failed` — Codex execution failed
- `integration_completed_missing` — no integration evidence (P0-C5)

**`already_integrated` recovery path:**

When the delivery recovery finds that the task commit is already reachable
on the canonical branch (detected via `git merge-base --is-ancestor`), it
classifies the recovery outcome as `already_integrated`. This means:

- The commit was already fast-forward merged or is a direct ancestor of HEAD.
- No additional merge, commit, or worktree operations are needed.
- The recovery sets `evidence.recovered = true` and
  `evidence.reason = 'already_integrated'`.
- Verification is skipped because the canonical repo state is already valid.

This path is distinct from `recovered_dirty_worktree_delivery` (which performs
actual recovery operations: commit, merge, verify) and is more efficient.

**Other recovery outcomes:**
- `recovered_dirty_worktree_delivery` — Full recovery performed: commit, merge,
  verify.
- `diagnostic_no_mutation_completed` — Diagnostic task with no changed files
  and no mutation; valid terminal state.
- Various blocker reasons (`canonical_dirty`, `ff_only_merge_failed`,
  `verification_failed`, etc.) when recovery cannot proceed.

### 7.3 `non_blocking_followups` / `quality_notes` vs Blockers

The system distinguishes three categories of findings:

| Category | Severity | Effect on Completion | Examples |
|---|---|---|---|
| **Blockers** | `blocker`, `major` | **Block completion.** Task stays in repair or review until resolved. | Verification failed, contract invalid, integration conflict, deployment health missing |
| **Non-blocking followups** | `followup` or no severity | **Do not block completion.** Reported as followup tasks or findings for later resolution. | UI polish, performance improvements, refactoring suggestions |
| **Quality notes** | informational | **Do not block completion.** Documented for awareness but do not create followup tasks. | Style preferences, documentation gaps, low-severity warnings |

Source fields:
- Blockers come from: `contract.blockers`, `verification.findings` with
  `severity = blocker | major`, `closure_decision.blockers`
- Non-blocking followups come from: `result.non_blocking_followups`,
  `result.followup_findings`, `result.followups`,
  `contract.non_blocking_followups`
- Quality notes come from: `result.quality_notes`,
  `contract.quality_notes`

The `completion_policy` field in the acceptance contract controls whether
certain non-blocking items may still block completion. By default:

```json
{
  "auto_complete_when_blocking_requirements_pass": true,
  "allow_completed_with_followups": true,
  "do_not_block_on_quality_notes": true
}
```

Tasks with only non-blocking followups or quality notes auto-complete
with status `auto_completed_with_followups`. Only genuine `blocker`/`major`
findings can prevent terminalization.

---

## 8. Remaining Non-Security Risks

The following non-security risks are documented as typed findings. None of
these block closure per the acceptance contract.

### 8.1 Non-Blocking Residual Risks

| ID | Risk | Type | Mitigation | Severity |
|---|---|---|---|---|
| R01 | No graceful shutdown for in-flight Codex subprocesses | Operations | Worker reaps on exit; subprocess can outlive parent | Low |
| R02 | State file not sharded for concurrent writes | Durability | Single-file JSON; writes are serial via lock | Low |
| R03 | No automatic log rotation | Operations | logrotate can manage `gptwork.log` | Low |
| R04 | Bark notification outage is silent | Monitoring | Notifications are fire-and-forget; no retry queue | Low |
| R05 | Worktree GC not automated | Operations | Worktrees accumulate if tasks crash; manual `git worktree prune` needed | Low |
| R06 | No built-in rate limiter on MCP server | Operations | Relies on upstream proxy for rate limiting | Low |
| R07 | Context index rebuild clears all cached bundles | UX | Rebuild is fast; cache warming is manual | Informational |
| R08 | Task timeout kills only the worker loop, not the Codex subprocess | Operations | Subprocess orphaned; reaped on worker restart | Low |
| R09 | No multi-node state replication | Scaling | Single-node design; horizontal scaling requires shared state | Informational |
| R10 | Repair loop does not persist repair state across restarts | Durability | Repair jobs are ephemeral; no checkpointing | Low |

### 8.2 Security Posture

Security-sensitive items are intentionally not enumerated here. Operators
must follow standard secret management practices:

- `GPTWORK_GITHUB_TOKEN`, `GPTWORK_BARK_KEY`, `GPTWORK_TOKENS` are secrets
  and must not be committed to the repository
- `runtime.env` is in `.gitignore` and must never be committed
- Auth is required by default (`GPTWORK_REQUIRE_AUTH=true`)
- Bark keys and GitHub tokens should use environment variables, not config files

---

## 9. Acceptance Procedure

### 9.1 Pre-Acceptance Checklist

Before accepting a deployment or release, the operator verifies:

- [ ] Canonical HEAD matches the expected baseline commit
- [ ] `cd backend && npm run check:syntax` passes
- [ ] `cd backend && npm run check:imports` passes
- [ ] `cd backend && npm run release:delivery-check` passes (or fast profile)
- [ ] `node scripts/init-production.mjs` reports readiness
- [ ] Server starts and responds on health endpoint
- [ ] `runtime.env` is configured with production values
- [ ] `state.json` is present (or will be created on first start)
- [ ] Repository registry is populated (or empty for fresh start)

### 9.2 Acceptance Decision

A task is considered accepted when:

1. **Blocking requirements** are satisfied:
   - A commit exists for the final configuration/documentation update
   - Changed files are reported and match the committed diff
   - Verification commands are reported and passed
   - Integration is completed (local or already-integrated evidence)
   - The acceptance gate status is `passed`
2. **Non-blocking items** are documented as followups or quality notes.
3. **No admin override** was used and no gate was bypassed.

The acceptance verdict is produced by `runAcceptanceGate` and stored as
`acceptance.json` in the goal directory. Downstream consumers use
`unified_decision` (set by the finalizer via normalizeToUnifiedDecision)
for all status and finding decisions.

### 9.3 Rollback Procedure

If a deployment fails acceptance:

1. Revert to the previous known-good commit
2. Restart the server
3. Verify health and re-run the release gate
4. Diagnose the failure from logs, acceptance artifacts, and test output
5. Re-deploy after fix

### 9.4 Normal Operations Handoff

After acceptance, the operator should:

1. Monitor runtime health (`runtime_status`, health endpoint)
2. Review completed task results through `get_task_acceptance_bundle`
3. Review review-required tasks through `get_task_review_packet`
4. Use `gptwork_doctor` and `gptwork_self_test` for ongoing diagnostics
5. Use `schedule_service_restart` for safe two-phase restarts after updates

---

## 10. Source Module Reference

| Module | Path | Role |
|---|---|---|
| Acceptance gate engine | `backend/src/acceptance-gate-engine.mjs` | Orchestrates flow from result to acceptance verdict |
| Contract verifier | `backend/src/acceptance/contract-verifier.mjs` | Validates blocking requirements against result evidence |
| Contract profiles | `backend/src/acceptance/contract-profiles.mjs` | Default contracts per operation_kind |
| Semantic validator | `backend/src/acceptance/semantics.mjs` | Semantic ambiguity and confidence checks |
| Task closure decider | `backend/src/closure/task-closure-decider.mjs` | Closure decision: auto-complete, repair, or review |
| Auto-progress policy | `backend/src/closure/auto-progress-policy.mjs` | Closure status constants and auto-progress rules |
| Task finalizer | `backend/src/task-finalizer.mjs` | Final terminal/non-terminal state decision |
| Unified decision normalizer | `backend/src/codex-unified-decision.mjs` | Normalizes all decisions into UnifiedAcceptanceDecision |
| Auto-closure classifier | `backend/src/auto-closure-classifier.mjs` | Task type and closure path classification |
| Auto-integration completion | `backend/src/auto-integration-completion.mjs` | ff-only merge and post-merge verification |
| Delivery result recovery | `backend/src/delivery-result-recovery.mjs` | Recovery from failed deliveries |
| No-change repair classifier | `backend/src/no-change-repair-classifier.mjs` | No-change repair completion eligibility |
| Verification evidence | `backend/src/verification-report.mjs` | Verification report reading and reuse validation |
| Acceptance policy | `backend/src/acceptance-policy.mjs` | Severity taxonomy and acceptance decision helpers |
| Delivery evidence profiles | `backend/src/evidence/operation-evidence-profiles.mjs` | Per-requirement evidence checks |

---

*End of closure acceptance documentation. This document describes the current
architectural model for closure, acceptance, and automated terminalization.*
