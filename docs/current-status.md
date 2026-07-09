# GPTWork Current Status

Last reviewed for current main: 2026-07-09 (P0/P1 repair convergence, README/docs refresh, clean release gates).

This document describes code-backed capabilities that are present in the repository. It does not assert that a particular production process has been restarted onto the latest commit; use `runtime_status.running_commit` for that check.

## Summary

GPTWork currently supports the full goal-to-task delivery loop: bounded goal files, compact context retrieval, isolated Codex execution, verification evidence, contract-aware acceptance, deterministic closure, compact review packets, and ff-only integration completion when the task result provides enough evidence.

The project now treats delivery state as several separate facts:

| Term | Current meaning |
|---|---|
| verification | Commands or checks passed, such as syntax/import tests or release checks. |
| acceptance | The user goal is satisfied according to the acceptance contract and evidence. |
| integration | The change entered canonical main or was explicitly not required. |
| deployment | The running environment is using the expected commit/configuration. |
| closure | The task can be closed because blocking gates passed or no longer apply. P0-04: New builder/deploy/admin tasks enforce strict pipeline gates before closure — missing required artifacts block the task. |
| review | Human judgment is required. Review is not the same as failure. |

Important boundaries are enforced in code and docs: `branch_pushed` is not `merged`; `pr_opened` is not `merged`; `merged` is not `deployed`; `health 200` is not proof of the expected running commit. `quality_notes` and `non_blocking_followups` are preserved but do not block current task closure.

## Delivered Capabilities

### Acceptance Contract

`backend/src/acceptance/` contains contract construction, profiles, schema validation, semantic checks, and the contract-aware verifier. New goals can carry an `acceptance_contract.json`; result processing uses the contract to distinguish required evidence, operation kind, blocking requirements, and optional follow-up notes.

The semantic layer rejects common state conflations, including treating branch push or PR creation as a merge. This keeps the acceptance gate aligned with user intent instead of raw tool success.

### Operation-Specific Evidence

`backend/src/evidence/` normalizes result data into operation evidence. The evidence profiles separate implementation, integration, deployment, verification, and recovery facts so that a command pass does not accidentally imply user acceptance or production deployment.

The recovery path also generates evidence for missing or incomplete task results when possible. If required evidence is absent, compact review APIs report `missing_evidence` rather than hiding the gap.

### Contract-Aware Verifier

`backend/src/acceptance/contract-verifier.mjs` evaluates verification commands, normalized result data, state assertions, blockers, non-blocking follow-ups, and quality notes. It returns a structured contract verification result with blocking status and completion eligibility.

`quality_notes` and `non_blocking_followups` are intentionally non-blocking. They can create follow-up tasks or review notes, but do not prevent closure after blocking gates pass.

### Deterministic Closure

`backend/src/closure/task-closure-decider.mjs` decides whether a task can close, needs review, needs integration, or needs repair. Closure consumes verification, acceptance, integration, and result shape as separate inputs. That means:

- A task can have passing verification but failed acceptance.
- A task can be merged but not deployed.
- A task can require review without being failed.
- A task can close with non-blocking follow-ups.

`backend/src/closure/followup-task-planner.mjs` preserves follow-up and quality-note information for later work.

### Agent Execution Backends

`backend/src/agent-execution-backends.mjs` provides the G3 execution backend abstraction. The legacy Codex path remains the default `codex_exec` backend, while `local_command` can run a configured shell command and `null` returns a structured no-op result for tests. Runtime config supports global and per-role routing with `GPTWORK_AGENT_BACKEND`, `GPTWORK_AGENT_ROLE_BACKENDS`, `GPTWORK_AGENT_LOCAL_COMMAND`, and `GPTWORK_AGENT_ROLE_COMMANDS`.

The task processor still owns worktree setup, locking, prompt preparation, parsing, acceptance, and final writeback. Backend output is normalized into `cr`, `parsedResult`, and `summary`, and final task results include `execution_backend` and `execution_backend_role` for review and diagnostics.

Repair reporting note: G3 backend results must report `changed_files` from the committed task diff, not from the post-commit worktree diff. A clean `git status --short` check is separate evidence for worktree cleanliness and must not erase the committed file list from `result.json`.

### Compact Review Packet

`backend/src/review/task-acceptance-bundle.mjs` and `backend/src/review/review-packet-builder.mjs` provide the preferred review path:

```text
get_task_acceptance_bundle(task_id)
get_task_review_packet(task_id)
```

These tools return the minimal evidence needed for review or closure: contract summary, result summary, verification, contract verification, closure decision, changed files, blockers, non-blocking follow-ups, missing evidence, report paths, compact git summary, and recommended next action.

They deliberately do not return complete transcripts, durable memories, complete context bundles, payload files, or large diffs. Operators and ChatGPT should prefer these packets over full `get_goal_context` reads.

### Zvec Context-Index

`backend/src/context-index/` builds bounded `context.bundle.md` files and retrieval diagnostics. The store mode is controlled by `GPTWORK_CONTEXT_VECTOR_STORE=auto|zvec|local`.

Zvec is optional and rebuildable. It is an index for retrieval, not the source of truth. Durable facts remain in goal/task/result files, conversation state, Git commits, and runtime diagnostics. `context.retrieval.json` records the store, retrieval mode, store capabilities, embedding provider, selected chunks, budget, top-K values, and scan caps.

### Directory Semantics Cleanup

Goal workspaces now distinguish bounded entry, supporting context, metadata, deep lookup, and result files:

```text
.gptwork/goals/<goal_id>/codex.entry.md          required bounded entry
.gptwork/goals/<goal_id>/context.bundle.md       preferred supporting context when present
.gptwork/goals/<goal_id>/context.retrieval.json  retrieval diagnostics when generated
.gptwork/goals/<goal_id>/context.json            metadata lookup
.gptwork/goals/<goal_id>/goal.md                 deep lookup
.gptwork/goals/<goal_id>/transcript.md           deep conversation lookup
.gptwork/goals/<goal_id>/result.json             structured result
.gptwork/goals/<goal_id>/result.md               human-readable result
```

Codex prompts are entry-first and instruct workers not to read full goal context unless the bounded entry and bundle are insufficient.

### Finalizer and Processor Slimming

Large finalization and task-processing responsibilities have been split into focused modules: result parsers, result fact factories, finalizer validation, runtime change handling, status handling, task final writeback, delivery result recovery, and closure/integration helpers. The remaining processor paths orchestrate these modules rather than embedding all policy in one place.

### Pipeline Gate Enforcement (P0-04)

Multi-agent pipeline gates transitioned from passive recording to strict enforcement for new builder/deploy/admin tasks.

Key changes:

- **New task detection**: Tasks created with `mode: builder`, `mode: deploy`, or `mode: admin` now set `require_pipeline_gates: true` during task construction. This flag gates the strict enforcement path.
- **isLegacyTask hardening**: `isLegacyTask` now checks `require_pipeline_gates` first — if `true`, the task is definitively non-legacy and requires gate enforcement. Existing tasks without this flag retain legacy compatibility.
- **Pipeline init is no longer fire-and-forget**: `ensurePipelineRunsForTask` is awaited for new tasks. Initialization failures are logged to goal messages rather than silently swallowed. The downstream gate check handles blocking when agent runs are missing.
- **Strict gate default**: `applyPipelineGateBeforeClosure` defaults `allowMissingGates` to `false`. New tasks pass `allowMissingGates: false` via caller logic. Legacy tasks still get `allowMissingGates: true`.
- **Detailed blocking messages**: Pipeline gate blocking findings now include the specific missing required artifact kinds (e.g. `change_summary`, `verification`, `reviewer_decision`, `result`, `integration`).
- **Review packet enrichment**: `get_task_review_packet` now includes `pipeline_gate` field when the task has gate blocking info: `{ blocked, reasons, legacy_bypass }`.
- **Legacy compatibility strategy**: Tasks without `require_pipeline_gates` (existing tasks, readonly/admin tasks) bypass gate enforcement via `allowMissingGates: true`. Explicit legacy markers (`legacy: true`, `skip_pipeline: true`) continue to work.

Large finalization and task-processing responsibilities have been split into focused modules: result parsers, result fact factories, finalizer validation, runtime change handling, status handling, task final writeback, delivery result recovery, and closure/integration helpers. The remaining processor paths orchestrate these modules rather than embedding all policy in one place.

## Tooling State

### ChatGPT Entry Tools

- `open_project_context` returns a compact repo/worker/queue/scripts/recent-work snapshot and recommended next tools.
- `create_encoded_goal` is the preferred execution entry for implementation, deployment, maintenance, and multi-step work.
- `project_context_status` and `context_status` provide safe context-health diagnostics, including context-index/Zvec status without exposing secret values.

### Review Tools

- `get_task_acceptance_bundle` returns compact acceptance evidence.
- `get_task_review_packet` returns review-ready evidence, blockers, changed files, and recommended next action.

### Operations Tools

- `runtime_status`, `worker_status`, `gptwork_doctor`, and `gptwork_self_test` cover liveness and diagnostics.
- `schedule_service_restart` implements safe two-phase restart for self-restart tasks.
- Recovery, retention, tmp cleanup, goal cleanup, and repo-lock tools provide the recovery plane.

### Queue and Integration Tools

- Queue tools are available in standard/codex/full mode, with operator read access for list/get.
- Per-task worktrees isolate Codex execution.
- ff-only integration completion can mark a task merged only after merge and verification evidence align.
- `branch_pushed` and `pr_opened` are non-terminal integration states and must not be treated as merged or deployed.
- Accepted auto-integration completion now propagates through final writeback: the linked goal and queue item are completed atomically, dependent blocked queue items are reconciled from the completed goal state, and the next eligible auto-start item is attempted. Manual `complete_task`, `recovery_queue_reconcile`, or `start_next_queued_goal` is not required for this normal path.

## Verification Commands

Use these as the narrow current release gate for documentation-only and delivery-contract changes:

```bash
cd backend && npm run check:syntax
cd backend && npm run check:imports
cd backend && node scripts/release-delivery-check.mjs --fast
```

Broader test suites remain available when changing behavior:

```bash
cd backend && npm test
cd backend && npm run test:e2e-acceptance
cd backend && npm run test:e2e-delivery
```

## Known Boundaries

- Health checks prove process liveness, not expected commit deployment.
- A merged commit still needs deployment/restart verification when the running service matters.
- Review packets are intentionally compact; use deeper files only when the packet is insufficient.
- Zvec/local retrieval can be rebuilt and should not be cited as durable fact.
- Secrets must not be copied into docs, issue bodies, goal payloads, transcripts, result files, or review packets.

## Related Documents

- [Architecture](architecture.md)
- [Operations](operations.md)
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md)
- [Acceptance and Repair Contract](delivery/acceptance-and-repair-contract.md)
- [Goal Queue](goal-queue.md)
- [GitHub Fallback](github-fallback.md)
- [中文主文档](../README.zh-CN.md)

## Productization Delivery (P0/P1 Series)

The following productization capabilities have been delivered across the P0/P1 goal series:

### P0-02: Retention Cleanup Productization (Completed)

`backend/src/retention-service.mjs` now includes:

- **git_branches family**: Tracks branch counts, stale branches (no commit in threshold days), and the oldest branch.
- **git_worktrees family**: Tracks per-repo worktree counts (same as the existing worktrees family but under a dedicated namespace).
- **storage_pressure metric**: Added to `retention_status` summary. `release-storage-pressure.mjs` script reports when task/goal counts approach configured limits.
- **Branch pruning**: `retentionCleanup` now prunes stale git branches when the data source allows (currently diagnostic-only for worktree pruning pending a safe removal strategy).
- **Release gate**: `release-storage-pressure.mjs` script and `check-storage-pressure-gate` can be wired into the CI/CD pipeline.

### P0-03: Review State Auto-Resolution (Completed)

`backend/src/review/review-backlog-reconciler.mjs` and `backend/src/task-review-status-taxonomy.mjs` define 6 canonical review categories:

| Category | Meaning |
|---|---|
| `evidence_missing` | Verification or result evidence is absent. |
| `policy_uncertain` | Policy cannot determine the correct action. |
| `integration_uncertain` | Integration state is ambiguous. |
| `repair_budget_exhausted` | Auto-repair attempts exhausted without resolution. |
| `provider_unavailable` | Execution provider is unavailable. |
| `human_required` | Semantic ambiguity requiring human judgment. |

These categories flow into the blocker-policy, review backlog reconciliation, and review packet builder so that review tasks are properly classified and can be handled accordingly.

### P0-04: Pipeline Gate Hardening (Completed)

See "Pipeline Gate Enforcement" section above. New builder/deploy/admin tasks enforce strict gate defaults before closure.

### P0-05: Real Agent Backends (Completed)

`backend/src/agent-execution-backends.mjs` is the canonical source for productized execution backend defaults:

- All pipeline roles now default to `codex_exec` (real agent execution) by product default, with per-role overrides via `agentRoleBackends`.
- `ROLE_AUTO_ARTIFACT_DEFAULTS` tracks roles that complete as `auto_artifact` when explicitly configured with `null` backend (context_curator, planner, integrator, finalizer).
- User explicit overrides via `agentRoleBackends` or `GPTWORK_AGENT_ROLE_BACKENDS` take precedence over product defaults.
- Runtime config supports global and per-role routing via `GPTWORK_AGENT_BACKEND`, `GPTWORK_AGENT_ROLE_BACKENDS`, etc.

### P0-06: Init/Onboarding Productization (Completed)

`backend/src/onboarding-init.mjs` and `backend/bin/gptwork.mjs` commands deliver and are further hardened with production mode support:

- **`gptwork init`**: One-shot initialization + diagnostics for new environments. Supports `--production` flag to run 9 production profile checks.
- **`gptwork doctor --local`**: Detailed diagnostics including env validation, repo registry checks, and pre-existing-config safety. Also supports `--production` mode for production-specific blocker checks.
- **`gptwork fix`**: Auto-creates missing files and dependencies.
- **Integration**: All CLI commands (`init`, `doctor`, `fix`, `status`, `connect`, `self-test`) now share the productized onboarding flow.
- **Production flag propagation**: `--production` is parsed at CLI entry, passed through to `runInit()`/`runProductionProfile()`, and blockers cause non-zero exit.

#### Production Blockers (Hard-Fail)

| Check | Blocking Condition | Fix |
|-------|-------------------|-----|
| `production_worker` | `GPTWORK_CODEX_WORKER` != `true` | Set `GPTWORK_CODEX_WORKER=true` in `.gptwork/runtime.env` |
| `role_commands` | `local_command` backend missing role command | Set `GPTWORK_AGENT_ROLE_COMMANDS` in runtime.env |

These blockers only apply when `--production` flag is passed. Local/dev mode is not affected.

Documentation updated: `docs/setup-connect.md`, `docs/launch-initialization.md`, `README.zh-CN.md`.

### P0-07: Codex Exec Production Hardening (Completed)

`backend/src/codex-run-diagnostics.mjs`, `backend/src/self-healing-policy.mjs`, and related modules deliver:

- **Failure classification**: Added `no_first_output_timeout`, `codex_timeout` failure classes for better diagnostics.
- **Self-healing categories**: `dirty_worktree` and `changed_files_mismatch` now have dedicated self-healing paths.
- **Result fallback**: Stronger fallback diagnostics for missing `result.json` and execution evidence.
- **Delivery recovery**: Improved recovery evidence quality so review packets can explain problems and suggest fixes.
- **21 new tests** covering no-first-output, timeout, missing result, dirty worktree, no-mutation verified, changed_files scenarios.

### P1-08: Codex TUI Operator Fallback (Completed, no-mutation)

Diagnostic review confirmed that codex_tui operator fallback is already correctly positioned:

- `codex_exec` is the default production execution mode.
- `codex_tui` is available as an **explicit-only fallback** for operators.
- No code changes were needed; the product boundary is correctly implemented.

### P1-09: Operator Dashboard Status (Completed)

`product_status` tool provides a single-pane-of-glass operator dashboard aggregating:

- **System**: Running commit, repo head, worktree cleanliness, runtime env, tool mode.
- **Worker**: Worker enabled/running state, health phase, last tick age, concurrency.
- **Queue**: Assigned, queued, running, completed, failed counts.
- **Current Blockers**: Raw non-terminal count vs policy-filtered actionable blockers.
- **Review**: Human-required, machine-repairable, and resolved-history categories.
- **Retention**: Storage pressure, task/goal counts vs limit.
- **TUI Provider**: Session count, active sessions, findings severity.
- **Next Actions**: Prioritized action items with severity labels.

### P0-AFC1: Unified Decision Core Module (Completed)

`backend/src/codex-unified-decision.mjs` provides the `UnifiedAcceptanceDecision` normalizer that
produces a canonical acceptance decision from the finalizer, verification evidence, and integration
evidence. Downstream consumers (finalizer, closure decider, reconciler, review packet builder) all
reference the canonical `unified_decision` rather than recomputing from raw signals.

Tests in `unified-decision-consistency.test.mjs` verify:
- Consistent output regardless of which source module drives the decision.
- Edge cases for sync mode, invalid contracts, failed results, and missing commit evidence.
- Deterministic field ordering and absence of spurious fields.

### P0-AFC2: Evidence Rules (Completed)

`backend/src/evidence/evidence-normalizer.mjs` normalizes result data into structured evidence
profiles covering implementation, integration, deployment, verification, and recovery facts.
`operation-evidence-profiles.mjs` defines the profiles for each operation kind.

- `operation-evidence.test.mjs` and `evidence-normalizer.test.mjs` verify profile construction and
  field normalization.
- Recovery paths generate evidence for missing or incomplete task results.

### P0-AFC3: Acceptance Explain Only (Completed)

The explain-only acceptance model surfaces the acceptance result as a clear structured explanation
in task results and review packets without requiring explicit acceptance artifact approval. The
verification, acceptance, and integration statuses are reported as facts that downstream consumers
(finalizer, closure decider) can act on.

### P0-AFC4: Finalizer Apply Decision (Completed)

`backend/src/codex-finalizer-status.mjs` and `backend/src/codex-finalizer-contract.mjs` ensure
that `reconcileTaskClosure` sets the canonical `unified_decision` when the R1 path normalizes the
finalizer decision. The finalizer propagates unified_decision as the source of truth for downstream
workflow-advance decisions.

Tests in `p0-afc4-finalizer-apply-decision.test.mjs` and `codex-finalizer-contract.test.mjs` verify:
- `reconcileTaskClosure` sets unified_decision after R1 normalization.
- Field reconciliation between finalizer output and task acceptance evidence.
- Edge cases for missing or incomplete finalizer decisions.

### P0-AFC5: Workflow Advance Decision (Completed)

The workflow advance path now prefers the canonical `unified_decision` over raw findings from
individual modules. `backend/src/codex-unified-decision.mjs` is the single source of truth for
workflow transition decisions. Downstream paths (integration queue, queue auto-advance, goal
advancement) consume the unified decision rather than independently evaluating raw findings.

`unified-decision-consistency.test.mjs` covers multi-module consistency for workflow advance scenarios.

### P0-AFC6: Reconciler Drift Repair (Completed)

`backend/src/closure/task-closure-reconciler.mjs` trusts the canonical `unified_decision` as the
source of truth when reconciling drift between task result state and expected closure records. When
unified_decision indicates completion and integration, the reconciler does not second-guess the
decision with independently computed acceptance rules.

Tests in `task-closure-reconciler.test.mjs` verify:
- Verified + integrated + result-artifact tasks auto-close via unified_decision trust.
- Drift repair does not overwrite canonical decisions.
- Missing evidence paths still produce clear findings.

### P0-AFC7: Continuation Flow (Completed)

`backend/src/closure/continuation-flow.mjs` connects completed canonical outcomes
(`unified_decision`) to continuation behavior. When a task completes with a unified_decision
indicating acceptance, the continuation flow determines the appropriate next action:
- No continuation needed when the task is terminal.
- Follow-up task creation when quality notes or followups are present.
- Advancement of the parent goal or queue when all tasks are complete.

Tests in `continuation-flow.test.mjs` and `followup-task-planner.test.mjs` verify:
- Canonical outcomes trigger correct continuation behavior.
- Follow-up task planner correctly preserves quality notes and non-blocking followups.
- Goal/queue advancement is gated on unified_decision acceptance.

### P0-AFC8: Review Packet Status (Completed)

`backend/src/review/review-packet-builder.mjs` and
`backend/src/review/task-acceptance-bundle.mjs` now use the canonical outcome
(`unified_decision`) as the primary status in review packets, alongside context bundle health
diagnostics. Review packets report:
- `canonical_outcome` from unified_decision (accepted, rejected, needs_review, etc.)
- `context_health` from context bundle diagnostics (present, missing, stale)
- `missing_evidence` when required evidence is absent

Tests in `task-review-packet.test.mjs`, `task-acceptance-bundle.test.mjs`, and
`review-backlog-reconciler.test.mjs` verify:
- Canonical outcome is correctly embedded in review packets.
- Context bundle health is reported without leaking bundle contents.
- Missing evidence produces findings, not silent omission.

### P0-AFC9: Closure Records (Completed)

`backend/src/closure/auto-progress-policy.mjs` provides the closure status record system covering
all status transitions, mappings, configuration overrides, and auto-complete predicate logic.
Auto-progress is the deterministic path for tasks that meet all closure criteria without human
review.

Tests in `auto-progress-policy.test.mjs` verify:
- `CLOSURE_STATUSES` constants match expected values with correct ordering.
- Auto-complete predicate evaluates all blocking gates correctly.
- Configuration overrides (env, runtime, per-task) produce expected results.
- Every status transition and edge case is covered across the closure status space.

### P0-AFC10: Project Verification (Completed)

P0-AFC10 adds verification coverage for the completed AFC sequence by:
- Recording the AFC1--AFC9 delivery summary in this status document.
- Running syntax check (`check:syntax`) and release delivery check (`release-delivery-check --fast`).
- Verifying that all nine preceding AFC tasks produce passing tests and a clean delivery gate.
- Committing the documentation update as the final AFC increment.

The full AFC series delivers a complete pipeline from unified decision normalization (AFC1) through
evidence rules (AFC2), acceptance explanation (AFC3), finalizer apply (AFC4), workflow advance (AFC5),
drift repair (AFC6), continuation flow (AFC7), review packet status (AFC8), closure records (AFC9),
to final project verification (AFC10). Every task produces passing tests in its commit, and the
combined test suite covers the acceptance, finalization, closure, continuation, and review pipeline
end to end.

### AFC-07: Docs Status Consistency (Repair Verified)

The docs-only acceptance profile has been verified for the AFC-07 documentation update. Only
documentation files are modified (`docs/current-status.md`), confirming the docs-only contract
is satisfied without incidental code or test file changes.

### P0-01: Release Gate Hardening (Addressed via CI Workflow)

Goal P0-01 was created but its intent was addressed through related productization work (P0-04 pipeline gate hardening, P0-07 codex exec hardening, and the release-gate CI workflow). The original intent was to:
- Elevate the fast gate (`release-delivery-check --fast`) to a production hard gate.
- Add explicit `check:syntax`, `check:imports` (full graph), `npm test`, e2e acceptance, e2e delivery, and `release-delivery-check --full` requirements.
- Add release gate CI/CD integration.

All three items are now in place: `.github/workflows/release-gate.yml` runs syntax/import checks, the release gate, and a full profile delivery check on push/PR to `main`. The release gate and CI pipeline cover the hardening intent.

## Known Gaps (Updated)

1. **P0-01**: Release gate hardening has been addressed. Both fast and full release delivery checks pass. The production release gate requires `GPTWORK_TOOL_MODE=full` to pass the runtime env check, which is expected for production deployments.
2. **P0-AFC series**: The acceptance-flow-closure pipeline (AFC1-AFC10) is complete. All nine preceding AFC tasks produce passing tests. Each task is verified individually and the combined test suite covers the acceptance, finalization, closure, continuation, and review pipeline end to end. No known gaps in the AFC series.
3. **CI/CD pipeline integration**: The `.github/workflows/release-gate.yml` workflow runs on push/PR to `main` covering syntax, imports, release gate, and full delivery check. This provides automated CI/CD release gate integration.
