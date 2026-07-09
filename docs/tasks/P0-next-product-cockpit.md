# P0-Next-1 — Product Cockpit: Unified State and Next-Action Surface

## Background

GPTWork already has durable state across repo status, runtime status, worker/agent execution, queue, context retrieval, task results, acceptance bundles, review packets, GitHub PRs, and CI evidence. The product gap is that operators need to mentally reconcile these facts. That creates avoidable risk:

- marking work passed before merge/deploy evidence exists;
- creating duplicate concurrent tasks while a related worker or lock is active;
- missing dirty worktree attribution;
- losing CI failure details because logs are truncated;
- confusing review-needed with failed.

#684 adds the state reconciliation checkpoint helper and release-gate evidence artifact path. This task productizes that logic into a single cockpit surface.

## Goal

Expose a compact product cockpit status view that answers:

1. What is running?
2. What is blocked?
3. Why is it blocked?
4. What evidence exists?
5. What evidence is missing?
6. What exact next action is safe?

## Scope

### In scope

- New read-only API/tool response or extension to `open_project_context`.
- Uses existing durable state sources only.
- Includes queue, worker, locks, dirty state, latest review packet, acceptance bundle summary, context health, GitHub/CI merge-readiness when available.
- Reuses `buildStateReconciliationCheckpoint()`.
- Unit tests for canonical states.
- Documentation updates.

### Out of scope

- UI redesign.
- Security hardening.
- New vector store implementation.
- Queue mutation, lock clearing, git reset, or worktree cleanup.

## Execution steps

1. Inspect current `product-status-view`, `open_project_context`, `worker_status`, `runtime_status`, `goal_queue`, review packet, and acceptance bundle implementations.
2. Define a compact `cockpit` response object:
   - `repo`: canonical path/ref/dirty summary.
   - `runtime`: running commit/config status when available.
   - `queue`: counts plus first running/blocked item.
   - `workers`: running/idle/error summary.
   - `locks`: active locks only.
   - `context`: context bundle/index health.
   - `latest_review`: verdict, blockers, missing evidence, changed files, evidence paths.
   - `next_action`: normalized decision and rationale.
3. Reuse #684 checkpoint policy to map state to:
   - `continue_current_task`
   - `append_requirements`
   - `create_followup_task`
   - `repair_evidence`
   - `merge_ready`
   - `blocked_manual_merge`
   - `stop_passed`
4. Return partial diagnostics instead of throwing when one status source fails.
5. Add tests for:
   - active lock/running worker → append requirements, not force-clear;
   - canonical dirty → attribute dirty paths before repair;
   - result missing/no-op → collect result and acceptance evidence;
   - waiting_for_review → GPTChat continue with guardrails;
   - passed/mergeable but merge action unavailable → blocked_manual_merge.
6. Add narrow release-gate coverage.
7. Update documentation.

## Acceptance criteria

- One tool/API call can show status and next action without reading full transcripts.
- The response never recommends force-clearing active locks.
- The response never recommends resetting or overwriting dirty worktree state.
- The response distinguishes verification, acceptance, integration, deployment, closure, and review.
- Merge-ready but unmerged PRs are not reported as completed integration.
- Tests cover all canonical decision states.
- Release gate passes.

## Rollback / failure handling

- If changing `open_project_context` risks breaking callers, expose the cockpit as an additive field or new tool.
- If a source fails, return `partial` with `diagnostics.source_failures[]`.
- If merge-state cannot be checked, report `unknown_integration` rather than guessing.
- Do not mutate queue, lock, repo, or task state from this task.

## Required docs updates after completion

- `docs/current-status.md`
- `docs/operations.md`
- `docs/architecture.md`
- `README.zh-CN.md`
- `docs/productization-next-goals-2026-07-10.md`
