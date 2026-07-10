# Productization Next Goals — 2026-07-10

## Current snapshot

Latest integrated PR: #684 (`chatgpt/state-reconciliation-checkpoint`) was merged into `main` as merge commit `7e41bde9f219156f9bfd2a958030c6d39fd55da6`.

Evidence available:

- Repository `9018/gpt-codex-workspace` is writable through the GitHub connector and uses `main` as default branch.
- #684 is closed and merged.
- `backend/src/state-reconciliation-checkpoint.mjs` is present on `main`.
- `backend/package.json` includes `state-reconciliation-checkpoint.mjs` in `check:imports`.
- Current active productization task: #685 (`Dispatch v5card P0 task`) is open and waiting for review.
- #685 produced a useful diagnosis but should not be marked passed yet: it reports 21 new `workspace-task-tools.test.mjs` regressions and 5 pre-existing `task-final-writeback.test.mjs` failures.

## Product design assessment

GPTWork is past the prototype stage for the core loop: goal creation, bounded context, Codex execution, evidence normalization, acceptance, review packet, integration, and queue auto-advance are documented and covered by release gates.

The remaining productization gap is not another isolated helper. It is operator trust and state observability:

1. The product needs one compact cockpit view that answers: what is running, what is blocked, why, what evidence exists, and what exact safe next action should happen.
2. Product onboarding needs a deterministic init wizard/checklist that validates config, backend routing, context store mode, Codex exec availability, optional TUI fallback, artifact/report paths, and CI expectations.
3. Multi-agent parallelism needs an explicit collision policy in the UI/API layer: append requirements to active task when locked/running; create follow-up only when paths and locks are non-conflicting.
4. `codex_exec` and `codex_tui_goal` need a user-facing mode switch contract that makes default automation and manual fallback impossible to confuse.
5. Acceptance artifacts need to be first-class delivery outputs, not hidden internals. Every failed CI or task should expose machine-readable JSON plus compact human review text.

## Context7 calibration

LangGraph JavaScript docs show three transferable implementation patterns:

- task-level checkpointing lets resumed runs skip already completed sub-operations;
- `Promise.all` can safely express bounded parallel I/O tasks when results are checkpointed;
- orchestrator-worker workflows should collect worker outputs into reduced/shared state rather than relying on hidden transcripts.

For GPTWork, this means the project should copy the architecture pattern, not add LangGraph as a dependency: durable task snapshots, explicit worker outputs, reduced state, and a small orchestrator decision surface.

## Highest-priority decision

Do not start another broad code-change PR before #685 is reconciled.

#685 is the active P0 productization task. It is `waiting_for_review`, but the default GPTChat verdict is not manual stop. The right status is:

```json
{
  "verdict": "blocked-with-next-action",
  "decision": "replan",
  "next_action": "fix_workspace_task_tools_regression_then_resume_product_cockpit"
}
```

Reason: #685 found a real new regression (`workspace-task-tools.test.mjs` undefined returns). That must be repaired before the Product Cockpit can be trusted.

## Highest-priority goals/tasks

### Goal P0-685-R1 — Repair workspace-task-tools regression from completion checkpoint changes

#### Background

#685 completed diagnosis and found:

- syntax/import/delivery gates pass;
- core modules pass;
- 21 new `workspace-task-tools.test.mjs` failures exist;
- 5 `task-final-writeback.test.mjs` failures appear pre-existing;
- no code mutations were made in #685.

Because the 21 failures are new and tied to recent lifecycle/checkpoint changes, they block productization.

#### Target

Repair the `workspace-task-tools.test.mjs` regression with the smallest safe code change and produce complete acceptance evidence.

#### Scope

In scope:

- inspect `buildCompletionCheckpoint` return shape;
- inspect workspace task tools callers;
- preserve backwards-compatible fields or add defensive normalization;
- update tests and docs where required;
- generate result and acceptance evidence.

Out of scope:

- security expansion;
- scheduler rewrite;
- force-clearing locks;
- broad refactor of task-final-writeback semantics.

#### Execution steps

1. Confirm latest `main` contains merge commit `7e41bde9f219156f9bfd2a958030c6d39fd55da6`.
2. Run `cd backend && npm run check:syntax`.
3. Run `cd backend && npm run check:imports`.
4. Run `cd backend && node --test --test-reporter=dot test/workspace-task-tools.test.mjs`.
5. Trace the undefined return source to checkpoint/lifecycle/workspace task boundary.
6. Add minimal compatibility fix.
7. Re-run focused test.
8. Re-run broader release/delivery checks that #685 already used.
9. Produce `result.json`, `result.md`, review packet, acceptance bundle, changed files, test commands, evidence paths.
10. Update docs.

#### Acceptance criteria

- All 21 `workspace-task-tools.test.mjs` regressions pass.
- `check:syntax` passes.
- `check:imports` passes.
- `release-delivery-check` passes.
- The result distinguishes fixed new regressions from the 5 pre-existing `task-final-writeback.test.mjs` failures.
- No task is marked `passed` without changed files, tests, result artifacts, and acceptance evidence.

#### Rollback/failure handling

- If the minimal fix creates new failures, revert only that change and return `blocked-with-next-action` with exact failing tests.
- If a lock/running worker exists, append requirements to #685/current workflow instead of creating a competing task.
- If dirty worktree exists, attribute dirty paths first; do not reset or clean.

#### Docs to update after completion

- `docs/productization-next-goals-2026-07-10.md`
- `docs/state-reconciliation-checkpoint.md`
- `docs/operations.md`
- `docs/current-status.md`

---

### Goal P0-Next-1 — Product cockpit: unified state and next-action surface

#### Background

Current status data exists across runtime, queue, worker, context, result, review packet, acceptance bundle, GitHub PR/CI, and docs. Operators must mentally reconcile these facts, which creates risk of false completion, duplicate tasks, and unsafe lock handling.

#### Target

Expose one compact product status endpoint/view that returns:

- repo/ref/runtime commit status;
- queue counts and first blocked/running items;
- worker/agent status;
- active locks and dirty worktree classification;
- latest task review packet summary;
- acceptance/delivery artifact paths;
- recommended next action using the state-reconciliation checkpoint policy.

#### Scope

In scope:

- API/tool response model;
- tests for canonical dirty, active lock, result missing, waiting_for_review, passed;
- docs and README update;
- compact response only, no full transcript or payload dump.

Out of scope:

- security hardening;
- UI redesign beyond response contract;
- new vector store implementation.

#### Execution steps

1. Reuse `buildStateReconciliationCheckpoint()`.
2. Add `product_cockpit_status` or extend `open_project_context` with a `cockpit` field.
3. Gather durable facts from existing status modules only.
4. Normalize next action into one of: `continue_current_task`, `append_requirements`, `create_followup_task`, `repair_evidence`, `merge_ready`, `blocked_manual_merge`, `stop_passed`.
5. Ensure output includes evidence paths and missing evidence, not raw transcripts.
6. Add unit tests and a narrow release-gate test.
7. Update docs/current-status.md, docs/operations.md, README.zh-CN.md.

#### Acceptance criteria

- A single command/tool call can show running/blocked/dirty/review/merge-ready status.
- Active lock or running worker never recommends force-clear.
- Dirty worktree recommends attribution before repair.
- Merge-ready PR with passed gates returns `blocked_manual_merge` if merge action is unavailable.
- Tests cover at least five canonical states.
- Release gate passes.

#### Rollback/failure handling

- If response model breaks existing callers, add field behind new optional key instead of replacing current schema.
- If status collection fails partially, return `partial` with per-source diagnostics.
- Do not mutate queue, locks, or dirty worktree from this read-only cockpit task.

#### Docs to update after completion

- `docs/current-status.md`
- `docs/operations.md`
- `docs/architecture.md`
- `README.zh-CN.md`

---

### Goal P0-Next-2 — Initialization wizard and config preflight

#### Background

The project has many runtime flags: context store, Codex backend, role backend overrides, local command backend, TUI fallback, Superpowers requirement, CI report paths, worker mode, and tool mode. Productization requires deterministic setup validation before users run agents.

#### Target

Create a guided init/preflight command that validates required and optional runtime configuration and emits a safe, redacted report.

#### Scope

In scope:

- `gptwork doctor/init` style command or MCP tool;
- redacted config summary;
- checks for Codex exec availability, Node version, Git state, context store mode, artifact output path, queue dir, writable workspace;
- optional TUI fallback diagnostics.

Out of scope:

- storing secrets;
- cloud deployment automation;
- security policy expansion.

#### Execution steps

1. Inventory existing `gptwork_doctor`, `context_status`, `runtime_status`, `worker_status` capabilities.
2. Add missing preflight checks only where gaps exist.
3. Produce JSON plus compact Markdown report.
4. Add failure classifications: `fatal`, `degraded`, `optional_missing`, `ready`.
5. Include copy-paste next actions for missing config.
6. Add tests for redaction and optional fallback behavior.
7. Update setup docs.

#### Acceptance criteria

- Fresh clone can run one preflight and know whether it is ready for `codex_exec` production mode.
- Missing optional zvec or TUI does not block default `codex_exec` path.
- Secret-like env keys are redacted.
- Report includes exact docs links and commands.
- Release gate passes.

#### Rollback/failure handling

- If new command is unstable, keep existing doctor unchanged and expose preflight as separate experimental tool.
- On partial diagnostics failure, report degraded status rather than throwing.

#### Docs to update after completion

- `docs/setup-connect.md`
- `docs/launch-initialization.md`
- `docs/operations.md`
- `README.md`
- `README.zh-CN.md`

---

### Goal P1-Next-3 — Parallel task collision policy and append-not-fork behavior

#### Background

The product already has queue gates for repo concurrency, active repo lock, and dirty worktree. The operator policy says new requirements should be appended to a current related task when lock/running state exists. That policy needs to be represented in task APIs and docs as a product behavior, not only an operator convention.

#### Target

Make parallel task handling deterministic: related work under the same repo/path should append acceptance/documentation/evidence requirements to the active task or create a non-conflicting follow-up with explicit dependency.

#### Scope

In scope:

- task relation detector using repo/path/goal labels;
- API/tool response that says append vs follow-up;
- acceptance criteria injection into current task notes or follow-up task;
- tests for lock/running/dirty states.

Out of scope:

- distributed scheduler rewrite;
- force-unlocking;
- overwriting dirty worktree.

#### Execution steps

1. Reuse typed eligibility gates and current-blocker policy.
2. Add an `append_or_followup_decision` helper.
3. When active lock/running worker exists, prefer append to current task if same repo/scope.
4. If non-conflicting paths, create dependent follow-up only.
5. Ensure docs and result artifacts are required in appended requirements.
6. Add tests for active lock, same scope, different scope, dirty repo.

#### Acceptance criteria

- Same-scope active task receives appended requirements instead of a competing new task.
- Different-scope work creates a dependent follow-up only when safe.
- Dirty worktree still blocks destructive execution and requires attribution.
- Review packet shows appended requirements and evidence expectations.

#### Rollback/failure handling

- If relation detection is uncertain, return `needs_review_packet` and do not mutate queue.
- Never clear locks or reset worktree as part of collision handling.

#### Docs to update after completion

- `docs/goal-queue.md`
- `docs/queue-auto-advance.md`
- `docs/current-status.md`
- `docs/state-reconciliation-checkpoint.md`

---

### Goal P1-Next-4 — Codex exec/TUI mode switch product contract

#### Background

`codex_exec` is the production default and `codex_tui_goal` is a manual fallback. Product users need the switch to be explicit, inspectable, and reversible, with evidence requirements shown before starting.

#### Target

Add a user-facing provider mode contract that reports default mode, requested mode, enablement, Superpowers/TUI preflight result, expected evidence, and fallback path.

#### Scope

In scope:

- mode description endpoint/tool output;
- TUI evidence checklist in task preview;
- tests for disabled TUI, missing Superpowers, default codex_exec, explicit TUI.

Out of scope:

- implementing a new TUI terminal UI;
- changing default production mode.

#### Execution steps

1. Extend existing provider diagnostics with task-preview output.
2. Show whether `GPTWORK_CODEX_TUI_ENABLED` and `GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI` allow the requested mode.
3. Include required evidence files: `result.json`, `result.md`, commit/tests, clean worktree.
4. If TUI unavailable, recommend default `codex_exec` or explicit operator remediation.
5. Update docs and tests.

#### Acceptance criteria

- Default tasks clearly show `codex_exec` as automatic production mode.
- Explicit TUI tasks show manual fallback warning and evidence checklist.
- Missing Superpowers never silently starts TUI.
- Unified acceptance path remains the same after evidence collection.

#### Rollback/failure handling

- If provider diagnostics fail, fall back to existing codex_exec default and report degraded diagnostics.
- Do not start TUI unless both config and task metadata explicitly request it.

#### Docs to update after completion

- `docs/codex-exec-production-mode.md`
- `docs/operations.md`
- `docs/current-status.md`

## Short operating decision

Immediate action: continue #685 as the active P0 task by repairing the 21 new workspace task tool regressions. After #685 is reconciled, implement P0-Next-1 Product Cockpit as the next code task.
