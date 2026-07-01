# GPTWork Current Status

Last reviewed for current main: 2026-07-01.

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
| closure | The task can be closed because blocking gates passed or no longer apply. |
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
