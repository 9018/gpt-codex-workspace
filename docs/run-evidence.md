# Run Evidence

Run evidence is the structured evidence chain for a GPTWork task run. It connects the Codex execution result, verification artifacts, acceptance evidence, contract verification, integration evidence, and the final unified decision without requiring operators to read full transcripts. This document describes the evidence model used by the acceptance gate, contract verifier, finalizer, closure decider, delivery recovery, and automated terminalization.

---

## 1. result.json Structure

`result.json` is the primary output of a Codex task run. It is read by `codex-result-json-parser.mjs` and consumed by the acceptance gate, finalizer, and recovery modules.

### Canonical Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | yes | `completed`, `failed`, `timed_out` |
| `summary` | string | yes for completed | Human-readable summary of what was done |
| `changed_files` | string[] | conditional | Files changed by the task (required for code_change) |
| `tests` | string | conditional | Verification text (e.g. "check:syntax pass") |
| `commit` | string | conditional | Git commit SHA (required for code_change) |
| `remote_head` | string | optional | Remote tracking head SHA |
| `warnings` | string[] | optional | Non-blocking warnings |
| `followups` | string[] | optional | Followup task descriptions |
| `verification` | object | conditional | Verification result `{passed, commands, profile, report_path}` |
| `reviewer_decision` | object | optional | `{passed, status, decision, findings}` |
| `acceptance_findings` | array | optional | Structured acceptance findings `[{severity, code, message, source}]` |
| `next_tasks` | array | optional | Suggested next task descriptors |
| `repair_proposal` | object | optional | Repair proposal for failed tasks |
| `subagents_used` | bool | optional | Whether subagents were used |
| `subagents` | array | optional | Subagent details |
| `gpt_questions_used` | number | optional | GPT question count |
| `decision_log` | array | optional | Decision log entries |
| `escalation` | object | optional | Escalation details |
| `acceptance_contract` | object | optional | Inline acceptance contract override |
| `no_mutation` | bool | optional | Explicit marker that no repo mutation occurred |
| `repo_mutated` | bool | optional | Explicit marker that repo was not mutated |
| `operation_kind` | string | optional | The operation kind (code_change, diagnostic, sync_only, etc.) |
| `acceptance_profile` | string | optional | Acceptance profile name |
| `mutation_scope` | string | optional | `none` for no-mutation tasks |
| `delivery_result_recovery` | object | optional | Delivery recovery evidence (see SS6) |
| `auto_integration_completion` | object | optional | Auto-integration completion evidence (see SS7) |
| `finalizer_decision` | object | optional | Finalizer decision (see SS8) |
| `unified_decision` | object | optional | Unified acceptance decision (see SS9) |
| `closure_decision` | object | optional | Closure decider output |
| `integration` | object | optional | Integration evidence `{status, merged, auto_completed, commit}` |
| `contract_verification` | object | optional | Contract verification output |
| `non_blocking_followups` | array | optional | Followup items that do not block completion |
| `quality_notes` | array | optional | Informational quality notes |
| `noop` | bool | optional | No-op execution marker (or `kind:"noop"`) |
| `failure_class` | string | optional | Failure classification code |
| `timed_out` | bool | optional | Whether execution timed out |
| `timeout_seconds` | number | optional | Timeout duration |
| `diagnostics` | object | optional | No-op diagnostics for debugging |
| `completed_at` | string | optional | ISO timestamp of completion |

### Task Result Builder

`codex-task-result-builder.mjs` (`buildTaskResult`) builds the standardized task result from parsed Codex output. It produces:

- **kind:"executed"** -- normal completion with action
- **kind:"noop"** -- completion with no changed files, tests, or commit
- **kind:"failed"** -- non-zero exit or structured failure
- **kind:"timed_out"** -- execution timed out
- **failure_class:"result_missing"** -- no structured output detected, with `retryable:true` and diagnostics for debugging

### Result Parser Fallback Chain

`codex-result-parser.mjs` tries parsers in order:
1. `codex-result-json-parser.mjs` -- reads `result.json` from disk
2. `codex-result-stdout-parser.mjs` -- parses the structured stdout report
3. `codex-result-fallback-parser.mjs` -- fallback for partial/invalid output

---

## 2. Verification Reports

Verification evidence is collected by `task-acceptance.mjs` (`verifyTaskCompletion`) and stored as `verification.json` alongside the goal directory.

### Verification Object Structure

```
{
  "passed": true,
  "status": "completed",
  "commands": [
    {"cmd": "git diff --check", "exit_code": 0, "stdout_tail": "", "stderr_tail": ""},
    {"cmd": "cd backend && npm run check:syntax", "exit_code": 0, ...}
  ],
  "changed_files": ["docs/run-evidence.md"],
  "failure_class": null,
  "requires_review": false,
  "findings": [],
  "evidence": { ... },
  "contract_verification": { ... },
  "report_reuse": {
    "attempted": true,
    "reused": true,
    "reason": "reusable",
    "path": "/path/to/report.json",
    "profile": "fast",
    "head": "abc123"
  }
}
```

### Verification Report Reuse

`verification-report.mjs` provides `isVerificationReportReusable` which checks:
- Report passed
- Head matches repo HEAD
- Repo is not dirty
- Profile satisfies required profile
- Report is not expired (`maxAgeMs`, default 24h)
- Required commands are present

`verificationReportToEvidence` and `commandEvidenceFromReport` extract command-level evidence from reusable reports.

### Verification Evidence Collection

`verification-evidence.mjs` (`collectVerificationEvidence`) writes these files to the goal output directory:

| File | Description |
|------|-------------|
| `verification.log` | Git status, diff stat, changed files |
| `implementation-diff.patch` | Full diff patch (`baseSha..HEAD` or `HEAD~1..HEAD`) |
| `acceptance.evidence.json` | Collected evidence with findings |
| `events.jsonl` | Structured event log |

### Verification Log

The verification log contains:
- Git status (`--porcelain`)
- Diff stat
- Changed files list

### Events JSONL

`events.jsonl` records one compact JSON event per line with `type`, `stage`, `message`, `artifact`, `data`, `created_at`, and `id`.

Event types:
| Type | Stage | Description |
|------|-------|-------------|
| `run_evidence.workflow` | workflow | Git status and diff capture |
| `run_evidence.context` | context | Evidence linked to goal directory |
| `run_evidence.verification_log` | verification | Verification evidence written |
| `run_evidence.acceptance_evidence` | acceptance | Acceptance evidence written |
| `run_evidence.queue` | queue | Queue/review status surface |
| `run_evidence.card` | card | Compact card surface |

---

## 3. acceptance.evidence.json

Written by `collectVerificationEvidence` in `verification-evidence.mjs` to the goal output directory.

```
{
  "collected_at": "2026-07-07T...",
  "git_path": "/repo/path",
  "git_status": " M docs/run-evidence.md\\n",
  "diff_stat": " 1 file changed, 1 insertion(+)\\n",
  "changed_files": ["docs/run-evidence.md"],
  "implementation_diff_patch_path": "/path/to/implementation-diff.patch",
  "verification_log_path": "/path/to/verification.log",
  "result_json": { ... },
  "acceptance_findings": []
}
```

---

## 4. acceptance.json

The acceptance verdict is produced by `acceptance-gate-engine.mjs` (`runAcceptanceGate`) and stored as `acceptance.json` in the goal directory.

```
{
  "status": "accepted",
  "passed": true,
  "task_status": "completed",
  "closure_decision": {
    "status": "auto_completed_clean",
    "blocking_passed": true,
    "requires_human_decision": false
  },
  "findings": [],
  "evidence_paths": {
    "acceptance_evidence_json": "/path/to/acceptance.evidence.json",
    "verification_log": "/path/to/verification.log"
  },
  "contract_verification": {
    "blocking_passed": true,
    "contract_valid": true,
    "semantic_ambiguity": false
  }
}
```

### Gate Statuses

| Status | Meaning |
|--------|---------|
| `passed` | Closure allows auto-complete AND verification passed |
| `failed` | Closure status is `failed` or result status is `failed` |
| `needs_action` | All other states (review, repair, integration needed) |

---

## 5. Contract Verification Blockers

The contract verifier (`acceptance/contract-verifier.mjs`, `verifyAcceptanceContract`) validates each blocking requirement from `acceptance.contract.json` against the task result evidence.

### Generic Blocking Requirements

Defined in `evidence/operation-evidence-profiles.mjs`:

| Requirement ID | Description | Evidence Check |
|----------------|-------------|----------------|
| `commit_present` | A commit hash must exist | `result.commit` non-empty |
| `changed_files_reported` | Changed files must be listed | `changed_files` is a non-empty array |
| `diff_reported` | Diff must be verifiable | `changed_files` has items, `diff`, or `diff_summary` |
| `verification_report` | Verification commands passed | `verification.passed == true` |
| `integration_completed` | Integration reached terminal state | Integration merged/skipped/not_required/auto_completed |
| `file_exists` | File existence evidence | `file_evidence.some(f => f.exists)` |
| `file_checksum` | File checksum evidence | `file_evidence.some(f => f.sha256)` |
| `restart_performed` | Restart marker evidence | `restart_evidence.restart_marker` |
| `process_status_evidence` | PID changed evidence | `restart_evidence.pid_changed` |
| `runtime_health_evidence` | Health check evidence | `restart_evidence.health_check` 2xx |
| `audit_evidence` | Audit log written | `audit_log_written == true` |
| `diagnostic_report` | Diagnostic report evidence | `diagnostic_evidence.summary` or `report_path` |
| `no_mutation_evidence` | No repo mutation | `no_mutation == true` or `repo_mutated == false` |

### Operation Evidence Profiles

Each `operation_kind` defines expected evidence fields and required-when-completed fields:

| Profile | Evidence Fields | Required When Completed |
|---------|----------------|------------------------|
| `code_change` | changed_files, commit, verification, integration | changed_files, commit, verification, integration |
| `file_write` | file_evidence, changed_files, commit | file_evidence |
| `restart` | restart_evidence | restart_evidence |
| `admin_command` | admin_evidence | admin_evidence |
| `diagnostic` | diagnostic_evidence | diagnostic_evidence |
| `cleanup` | cleanup_evidence | cleanup_evidence |
| `readonly_validation` | validation_evidence | validation_evidence |
| `already_integrated` | already_integrated_evidence | already_integrated_evidence |
| `integration` | changed_files, commit, verification | changed_files, commit, verification |
| `repair` | changed_files, commit, verification, integration, repair_evidence | changed_files, commit, verification, integration |
| `queue_admin` | queue_admin_evidence | queue_admin_evidence |

### Blocker Classification

Blockers produced by contract verification include:

- **commit_present_missing** -- missing commit
- **changed_files_reported_missing** -- missing changed_files
- **verification_report_missing** -- missing verification
- **integration_completed_missing** -- missing integration evidence (P0-C5)
- **operation_kind_mismatch** -- result kind doesn't match contract
- **semantic_ambiguity** -- low semantic confidence
- Profile-specific blockers: `{field}_missing` for each required-when-completed field

### Non-Mutating Operations

Tasks with `operation_kind` in `NO_MUTATION_PROFILES` (`diagnostic`, `noop`, `readonly_validation`, `already_integrated`, `repair_noop`, `network_retry`, `verification_only`, `sync_only`, `github_sync_only`) bypass commit and changed-files requirements. These are classified as **non-mutating** and pass through without those blockers.

### No-Change Repair

When `no-change-repair-classifier.mjs` determines `completion_eligible == true`, it satisfies commit, changed-files, diff, and integration requirements directly, allowing terminal completion without real source mutations.

---

## 6. Integration Evidence

Integration evidence tracks whether a task's changes have been merged into the canonical branch. It is stored in `result.integration`.

```
{
  "integration": {
    "status": "merged",
    "merged": true,
    "auto_completed": true,
    "commit": "abc123",
    "mode": "ff_only",
    "satisfied": true
  }
}
```

### Integration Statuses

| Status | Meaning |
|--------|---------|
| `merged` | FF-only merge completed |
| `ff_only_merged` | Fast-forward merge done |
| `skipped` | Integration skipped (e.g. diagnostic tasks) |
| `not_required` | Integration not required (noop, readonly) |
| `branch_pushed` | Branch pushed to remote |
| `pr_opened` | PR opened for review |
| `pending` / `queued` | Integration queued |
| `conflict` | Merge conflict |
| `check_failed` | CI check failed |
| `push_failed` | Push to remote failed |
| `pr_failed` | PR creation failed |

### Integration Detection (P0-C5)

The closure decider (`closure/task-closure-decider.mjs`) differentiates:

- **integration_completed_missing**: No integration was attempted or status is unknown/pending/queued/waiting. This is a **deterministic recovery path** -- `delivery-result-recovery` can detect and repair it.
- **integration_unsatisfied**: Integration was attempted but did not reach terminal state (conflict, check_failed, push_failed). Requires investigation.

### Integration Required Logic

Integration is required when:
- `changed_files` has items AND a commit exists AND the operation is not in `NO_MUTATION_PROFILES`
- OR `needs_integration == true`

Integration is satisfied when ANY of:
- `integration.merged == true`
- `integration.auto_completed == true`
- `integration.status` = `merged`, `ff_only_merged`, `skipped`, or `not_required`
- Auto-integration completed and verification did not fail

---

## 7. delivery_result_recovery

The delivery result recovery module (`delivery-result-recovery.mjs`) runs when Codex fails to produce a valid result or the task's worktree is dirty. It is invoked by the finalizer for tasks with repairable failures.

### Recovery Triggers

`analyzeDeliveryRecoveryCandidate` detects these triggers:

| Trigger | Description |
|---------|-------------|
| `commit_missing` | Commit evidence missing despite changed files |
| `dirty_worktree_after_codex` | Worktree has unstaged changes |
| `result_missing` | No valid result.json (`failure_class:"result_missing"`) |
| `codex_failed` | Codex execution failed |
| `integration_completed_missing` | Missing integration evidence (P0-C5) |
| `changed_files_without_commit` | Changed files present but no commit |

### Recovery Outcomes

| Outcome | Description |
|---------|-------------|
| `already_integrated` | Commit already reachable on canonical branch (`git merge-base --is-ancestor`); no operations needed |
| `recovered_dirty_worktree_delivery` | Full recovery performed: commit, merge, verify |
| `diagnostic_no_mutation_completed` | Diagnostic/no-mutation task with no changed files; valid terminal |
| `canonical_dirty` | Canonical repo is dirty before recovery |
| `ff_only_merge_failed` | Fast-forward merge failed |
| `verification_failed` | Recovery verification command failed |
| `no_changed_files` | Worktree has no changed files |
| `no_recoverable_files` | Changes don't include code/config/tests/docs |
| `diff_check_failed` | `git diff --check` reported issues |
| `empty_commit` | No staged changes for commit |

### Recovery Evidence Structure

```
{
  "delivery_result_recovery": {
    "attempted": true,
    "eligible": true,
    "recovered": true,
    "reason": "already_integrated",
    "task_id": "...",
    "triggers": ["integration_completed_missing"],
    "commit": "abc123",
    "local_head": "abc123",
    "remote_head": "abc123",
    "changed_files": ["..."],
    "canonical_clean_before": true,
    "canonical_clean_after": true,
    "commit_integrated": true,
    "verification": {"passed": true, "commands": []},
    "integration": {"mode": "ff_only", "merged": true, "status": "already_integrated"},
    "warnings": ["..."],
    "blockers": [],
    "commands": [],
    "duration_ms": 1234
  }
}
```

### Propagation to Integration Evidence (P0-AutoTerm)

When `evidence-normalizer.mjs` detects `delivery_result_recovery.reason == 'already_integrated'` or `commit_integrated == true`, it propagates the recovery's integration evidence into the normalized `result.integration` object so downstream consumers see `merged:true` and `satisfied:true`.

---

## 8. auto_integration_completion

The auto-integration completion module (`auto-integration-completion.mjs`) performs local `git merge --ff-only` and optional cherry-pick fallback, then runs post-merge verification.

### Eligibility

`analyzeAutoIntegrationCandidate` checks:
- Integration result was successful (`ok == true`)
- AND integration is not already marked merged
- AND integration status is `branch_pushed` or `pr_opened`
- Acceptance passed (`reviewer_decision.passed` or `verification.passed` without blockers)
- No existing blocker findings
- Changed files present (unless no-mutation profile)
- Commit evidence present
- Task branch evidence present
- Git worktree lifecycle
- Canonical repo path available

### Auto-Integration Analysis Fields

| Field | Description |
|-------|-------------|
| `eligible` | Whether auto-integration can proceed |
| `reason` | Eligibility reason or blocker code |
| `blockers` | Array of `{severity, code, message, source}` |
| `warnings` | Array of warning strings |
| `base_sha` | Base commit SHA for merge |
| `commit` | Task commit to integrate |
| `no_change_repair` | No-change repair classification |
| `has_no_mutation_evidence` | Whether the task has explicit no-mutation markers |

### Execution Outcomes

| Outcome | Description |
|---------|-------------|
| `no_change_repair_already_integrated_and_verified` | No-change task, already integrated |
| `verification_only_completed` | Verification-only task with no-mutation evidence |
| `already_integrated_and_verified` | Commit already reachable, verified |
| `ff_only_merged_and_verified` | FF-only merge completed, verified |
| `cherry_pick_merged_and_verified` | Cherry-pick fallback used, verified |
| `canonical_dirty` | Canonical repo dirty before operation |
| `commit_missing` | Task commit does not exist |
| `ff_only_merge_failed` | FF merge failed, no cherry-pick fallback |
| `cherry_pick_failed` | Cherry-pick failed |
| `post_merge_verification_failed` | Verification after merge failed |

### Post-Merge Verification

After merge, `verifyPostMerge` runs `release-delivery-check.mjs --profile changed` first, falling back to `--fast` if the changed profile fails. Reports are validated by `isVerificationReportReusable` against the merged HEAD.

### No-Mutation Profile Set

Tasks with `operation_kind` in `NO_MUTATION_PROFILES` (`diagnostic`, `noop`, `readonly_validation`, `already_integrated`, `repair_noop`, `network_retry`, `verification_only`, `sync_only`, `github_sync_only`) or with `changed_files == []` AND `(no_mutation == true || repo_mutated == false)` bypass the merge step entirely and are treated as already-integrated.

---

## 9. finalizer_decision

The finalizer (`task-finalizer.mjs`, `decideTaskFinalState`) is the last decision stage. It produces `finalizer_decision` stored in the task result.

### Decision Order

1. **Capacity failure** -- rate-limit/quota -> `waiting_for_capacity`
2. **Manual review blockers** -- semantic ambiguity, manual approval required, state corruption -> `waiting_for_review`
3. **No-change repair completion** -- `completion_eligible == true` -> immediate completion
4. **Terminal evidence satisfied** -- verification AND acceptance AND contract AND integration all passed -> `completed` with `safe_to_auto_advance == true`
5. **Integration non-terminal** -- all passed but integration pending -> `waiting_for_integration`
6. **Repairable failures** -- repairable failures with budget -> `waiting_for_repair`
7. **Budget exhausted** -- repair budget used up -> `waiting_for_review`
8. **Terminal unrecoverable** -- timed out/failed without repair -> `timed_out` / `failed`
9. **Fallback** -- `waiting_for_review`

### Finalizer Statuses

`completed`, `waiting_for_integration`, `waiting_for_repair`, `waiting_for_capacity`, `waiting_for_review`, `waiting_for_human_review`, `waiting_for_missing_evidence_repair`, `waiting_for_integration_recovery`, `waiting_for_result_contract_repair`, `waiting_for_noop_evidence`, `waiting_for_manual_terminal_decision`, `human_interrupted_for_repair_budget_exhausted`, `timed_out`, `failed`.

### Evidence Source Fields

The finalizer reads from multiple evidence sources in order:

| Source | Priority | Used For |
|--------|----------|----------|
| `evidence.codex_result` | Highest | Execution result, failure class |
| `evidence.result` | Fallback | Task result fields |
| `evidence.task_result` | Fallback | Full task result |
| `evidence.verification` | Derived | `verification.passed` |
| `evidence.integration` | Derived | `integration.status`, `merged` |
| `evidence.runtime_guard` | Guard | Restart/approval requirements |
| `evidence.failure` | Diagnostic | Failure details |
| `evidence.contract_verification` | Contract | `blocking_passed`, `contract_valid` |

### Key Helper Functions

| Function | Checks |
|----------|--------|
| `verificationPassed` | `verify.passed`, `auto_integration_completion.verification_report.passed` |
| `acceptancePassed` | `acceptance.passed`, `reviewer_decision.passed`, or verification passed without unresolved blockers |
| `contractBlockingPassed` | `contract_verification.blocking_passed`, no unresolved blockers |
| `hasCapacityFailure` | Rate limit / quota patterns in evidence text |
| `manualReviewBlockers` | Invalid contract, semantic ambiguity, manual approval required |
| `hasRepairPath` | `repair_goal_id`, `repair_task_id`, or closure status is `waiting_for_repair` |

---

## 10. unified_decision

The unified decision normalizer (`codex-unified-decision.mjs`, `normalizeToUnifiedDecision`) produces a single canonical `UnifiedAcceptanceDecision` from the finalizer, closure decider, gate, convergence, verification, and contract verification. It is stored in `taskResult.unified_decision`.

### Canonical Fields

| Field | Type | Description |
|-------|------|-------------|
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
| `blockers` | Array | `[{severity, code, message, source}]` |
| `repairable_blockers` | Array | Findings that can be auto-repaired |
| `non_blocking_followups` | Array | Followup items (do not block completion) |
| `quality_notes` | Array | Quality notes (do not block completion) |
| `findings` | Array | All findings combined |
| `integration_effect` | object | `{required, status, satisfied, terminal}` |
| `goal_effect` | object | `{status, complete_goal, safe_to_auto_advance}` |
| `queue_effect` | object | `{status, unblock_dependents, hold_queue}` |
| `source` | string | Which module produced the decision |
| `normalized_at` | string | ISO timestamp |

### Status Categories

- **Terminal**: `completed`, `failed`, `blocked`, `timed_out`
- **Non-terminal hold**: `waiting_for_review`, `waiting_for_human_review`, `waiting_for_repair`, `waiting_for_integration`, `waiting_for_capacity`, `retry_wait`, `quota_wait`, `restart_pending`, `waiting_for_missing_evidence_repair`, `waiting_for_integration_recovery`, `waiting_for_result_contract_repair`, `waiting_for_noop_evidence`, `waiting_for_manual_terminal_decision`, `human_interrupted_for_repair_budget_exhausted`

### Effect Builders

Three parallel effect builders compute propagation effects:

- `buildIntegrationEffect` -- Determines `required`, `status`, `satisfied`, `terminal`
- `buildGoalEffect` -- Determines `status`, `complete_goal`, `safe_to_auto_advance`
- `buildQueueEffect` -- Determines `status`, `unblock_dependents`, `hold_queue`

### Derivation Functions

| Function | Logic |
|----------|-------|
| `deriveStatus` | Checks finalizer -> closure -> gate -> convergence -> verification -> result |
| `deriveRequiresReview` | False for terminal, auto-handled (repair/integration/capacity); true for review statuses |
| `deriveRequiresRepair` | True when decision has `requires_repair` or `repairable_blockers` |
| `deriveRequiresIntegration` | True when `needs_integration` or integration not terminal |
| `deriveSafeToAutoAdvance` | True only when `status == completed` AND `blocking_passed != false` |

### Consumer Binding

Downstream consumers MUST prefer `unified_decision` over re-deriving status from individual decision objects when the field is present. Modules that consume it:
- Goal convergence
- Queue propagation
- Review packet builder
- Notification service

---

## 11. Closure Decision Model

The closure decider (`closure/task-closure-decider.mjs`, `decideTaskClosure`) produces a closure decision with these statuses:

| Status | Meaning |
|--------|---------|
| `auto_completed_clean` | All gates passed, no followups |
| `auto_completed_with_followups` | All gates passed, non-blocking items noted |
| `waiting_for_repair` | Repairable failures (verification, integration, contract) |
| `requires_review` | Non-repairable failures, semantic ambiguity, safety concerns |
| `failed` | Terminal failure -- no recovery path |

### Decision Sequence

1. Contract validity -> invalid requires review
2. Semantic ambiguity -> requires review
3. Verification pass/fail -> repair or review
4. State assertion pass/fail -> review
5. Contract blocking requirements -> repair or review
6. Commit evidence (when required) -> review if missing
7. Integration requirement (P0-C5): missing -> `integration_completed_missing` (recoverable); failed -> `integration_unsatisfied`
8. Deployment/health check -> review if unsatisfied
9. Operation safety audit -> review if evidence missing
10. Result not failed -> auto-complete clean or with followups

---

## 12. Authoritative Evidence Fields for Automatic Terminalization

For automatic terminalization (completed with `safe_to_auto_advance == true`), the following evidence fields are authoritative:

| Priority | Field | Source | What it determines |
|----------|-------|--------|-------------------|
| 1 | `unified_decision.status` | `codex-unified-decision.mjs` | Canonical task status; MUST be `completed` |
| 2 | `unified_decision.blocking_passed` | `codex-unified-decision.mjs` | No unresolved blockers; MUST be `true` |
| 3 | `unified_decision.safe_to_auto_advance` | `codex-unified-decision.mjs` | Downstream auto-advance lock; MUST be `true` |
| 4 | `verification.passed` | `task-acceptance.mjs` | Syntax/imports/test checks; MUST be `true` |
| 5 | `acceptance.status` | `acceptance-gate-engine.mjs` | Gate pass/fail/needs_action; MUST be `passed` |
| 6 | `contract_verification.blocking_passed` | `contract-verifier.mjs` | Blocking requirements; MUST be `true` |
| 7 | `integration.merged` or `auto_completed` | integration evidence | Commit is on canonical branch |
| 8 | `delivery_result_recovery.reason` (if present) | `delivery-result-recovery.mjs` | If recovery ran, MUST be `already_integrated` or a recovered outcome |
| 9 | `commit` | result.json | Commit SHA on canonical branch (when applicable) |
| 10 | `changed_files` | result.json | Changed files list (when applicable) |

**Rule**: ALL of fields 1-6 must be true/satisfied. Fields 7-10 are required when the operation kind is `code_change` or integration is needed. For non-mutating operations (diagnostic, noop, readonly_validation, sync_only, already_integrated), fields 7 and 9-10 are not required.

### Finding Taxonomy for Terminalization

| Category | Severity | Effect on Completion | Sources |
|----------|----------|---------------------|---------|
| **Blockers** | `blocker`, `major` | **Block completion**. Stay in repair or review | `contract.blockers`, `verification.findings`, `closure_decision.blockers` |
| **Non-blocking followups** | `followup` or none | **Do not block completion** | `result.non_blocking_followups`, `result.followup_findings`, `contract.non_blocking_followups` |
| **Quality notes** | informational | **Do not block completion**, documented for awareness | `result.quality_notes`, `contract.quality_notes` |

### Generic Terminalization Rule

A task SHOULD complete automatically without human intervention when ALL of:

1. **Accepted** -- Acceptance gate passed (verification passed, blocking requirements satisfied, contract verified)
2. **Verification passed** -- Syntax, imports, tests, release checks passed
3. **Commit reachable / already integrated** -- Commit exists in repo, reachable from canonical branch, or fast-forward merged
4. **Clean repo** -- Canonical repo not dirty at merge time
5. **No restart required** -- No runtime restart needed or restart completed
6. **Integration satisfied / terminal** -- Merged, already-integrated, or explicitly not-required

### Evidence Propagation

Evidence flows through the system as follows:

```
Codex execution -> result.json (buildTaskResult)
                    |
                    v
         evidence-normalizer (normalizeOperationEvidence)
                    |
                    v
         acceptance-gate-engine (verifyTaskCompletion -> verifyAcceptanceContract)
                    |
                    v
         closure/task-closure-decider (decideTaskClosure)
                    |
                    v
         task-finalizer (decideTaskFinalState)
                    |
                    v
         codex-unified-decision (normalizeToUnifiedDecision)
                    |
                    v
         unified_decision stored in taskResult
```

Evidence may enter the chain at recovery points:

- `delivery-result-recovery` handles `codex_failed` / `integration_completed_missing` by detecting already-integrated commits or performing full recovery
- `auto-integration-completion` handles `branch_pushed`/`pr_opened` by performing local FF merge
- Recovery outcomes propagate through `evidence-normalizer` into `integration` and `verification` fields

---

## 13. Source Module Reference

| Module | Path | Role |
|--------|------|------|
| Task result builder | `backend/src/codex-task-result-builder.mjs` | Build standardized task result from Codex output |
| Result JSON parser | `backend/src/codex-result-json-parser.mjs` | Parse result.json from disk |
| Acceptance gate engine | `backend/src/acceptance-gate-engine.mjs` | Orchestrate result -> verification -> contract -> closure -> verdict |
| Contract verifier | `backend/src/acceptance/contract-verifier.mjs` | Validate blocking requirements against result evidence |
| Contract profiles | `backend/src/acceptance/contract-profiles.mjs` | Default contracts per operation_kind |
| Evidence profiles | `backend/src/evidence/operation-evidence-profiles.mjs` | Per-profile evidence requirements and checks |
| Evidence normalizer | `backend/src/evidence/evidence-normalizer.mjs` | Normalize result into operation-typed evidence |
| Verification report | `backend/src/verification-report.mjs` | Verification report reading, reuse validation |
| Verification evidence | `backend/src/verification-evidence.mjs` | Evidence collection and file writing |
| Task verification | `backend/src/task-acceptance.mjs` | Full verification: commands, findings, contract, state |
| Task closure decider | `backend/src/closure/task-closure-decider.mjs` | Closure decision: auto-complete, repair, review |
| Task finalizer | `backend/src/task-finalizer.mjs` | Final terminal/non-terminal state decision |
| Unified decision normalizer | `backend/src/codex-unified-decision.mjs` | Normalize all decisions into UnifiedAcceptanceDecision |
| Auto-integration completion | `backend/src/auto-integration-completion.mjs` | FF-only merge and post-merge verification |
| Delivery result recovery | `backend/src/delivery-result-recovery.mjs` | Recovery from failed Codex deliveries |
| No-change repair classifier | `backend/src/no-change-repair-classifier.mjs` | No-change repair completion eligibility |

---

*End of run evidence documentation. This document describes the current evidence model for task execution, verification, acceptance, integration, delivery recovery, and automated terminalization.*
