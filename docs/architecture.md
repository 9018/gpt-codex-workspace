# GPT-Codex Workspace Architecture

Status: current main, modular delivery pipeline.

## Objective

GPTWork is a backend MCP coordination service for ChatGPT and Codex. It stores goals, tasks, bounded context, worktree execution metadata, verification evidence, acceptance decisions, review packets, integration state, and operational diagnostics.

The architecture separates facts that are often conflated:

- verification: commands/checks passed.
- acceptance: user goal satisfied.
- integration: change reached canonical main or was explicitly not required.
- deployment: running environment uses the expected commit/configuration.
- closure: task can be closed.
- review: human judgment needed, not automatic failure.

## Operating Model

```text
ChatGPT
  -> open_project_context
  -> create_encoded_goal
  -> compact review/status tools

GPTWork backend
  -> goal/task state
  -> context bundle and retrieval diagnostics
  -> queue, worktree, repo lock, verification, acceptance, closure
  -> review packet and operations tools

Codex
  -> reads codex.entry.md first
  -> uses context.bundle.md when available
  -> edits inside the execution worktree
  -> writes result.json/result.md and verification evidence
```

## Core Flow

```text
User request
  -> ChatGPT creates preview and encoded payload
  -> create_encoded_goal(assign_to_codex=true)
  -> backend writes .gptwork/goals/<goal_id>/ files
  -> context-index may write context.bundle.md and context.retrieval.json
  -> task enters queue or assignment
  -> Codex executes in a per-task worktree
  -> result parser/recovery normalizes result.json/stdout evidence
  -> evidence profiles normalize operation facts
  -> contract verifier checks acceptance contract and state assertions
  -> integration completion attempts ff-only merge when eligible
  -> closure decider returns close/review/repair/integration state
  -> review packet exposes compact evidence for humans/ChatGPT
```

## Module Boundaries

### Acceptance

Path: `backend/src/acceptance/`

Responsibilities:

- Build acceptance contracts from goals and task intent.
- Validate contract shape and semantic consistency.
- Apply operation profiles.
- Verify blocking requirements, optional requirements, state assertions, quality notes, and non-blocking follow-ups.

Acceptance is about satisfying the user's objective. It must not be inferred from command success alone.

### Evidence

Path: `backend/src/evidence/`

Responsibilities:

- Normalize task result fields and operation-specific evidence.
- Preserve integration/deployment/verification facts independently.
- Surface missing evidence explicitly.

Evidence modules prevent shortcuts such as treating `health 200` as deployment proof or treating a pushed branch as a merge.

### Assertions

Path: `backend/src/assertions/`

Responsibilities:

- Run contract state assertions.
- Report assertion failures as structured findings.
- Keep assertion evidence separate from command verification.

### Closure

Path: `backend/src/closure/`

Responsibilities:

- Decide whether a task can close, needs review, needs repair, or needs integration.
- Treat `quality_notes` and `non_blocking_followups` as non-blocking.
- Preserve follow-up work without blocking current closure.

Closure is deterministic policy over existing facts; it does not create new implementation evidence.

### Review

Path: `backend/src/review/`

Responsibilities:

- Build compact acceptance bundles and review packets.
- Include contract summary, result summary, verification, contract verification, closure decision, changed files, missing evidence, blockers/follow-ups, and recommended next action.
- Include pipeline gate info (blocked status, reasons, missing roles/artifacts) when gates are enforced.
- Exclude full transcript, durable memories, full context bundle, payload files, and large diffs.

Review means human judgment. It is not equivalent to failure.

### Pipeline Gate Enforcement

Paths: `backend/src/pipeline-orchestration.mjs`, `backend/src/agent-run-writeback.mjs`, `backend/src/agent-artifact-contract.mjs`

P0-04: Pipeline gates transitioned from passive recording to strict enforcement.

Responsibilities:

- Create and maintain agent_run records for each pipeline role (context_curator, planner, builder, verifier, reviewer, integrator, finalizer).
- Evaluate pipeline gate satisfaction before task closure: each blocking role must have a completed agent_run with the required artifact kind.
- Enforce strict gates for new builder-mode tasks (`require_pipeline_gates: true`): missing required artifacts downgrade the task from `completed` to `waiting_for_review`.
- Provide legacy compatibility via `allowMissingGates`: legacy tasks (without `require_pipeline_gates`) bypass gate enforcement.
- Include pipeline gate blocking findings in acceptance findings and review packets, with explicit messages naming the missing role and required artifacts.

Gate enforcement flow:

1. Task creation in `buildGoalTask` sets `require_pipeline_gates: true` for builder-mode tasks.
2. `ensurePipelineRunsForTask` is awaited for new tasks; init failures are logged, not silently swallowed.
3. Agent writeback functions record completed runs with output artifacts per `ARTIFACT_SCHEMA.required_by_role`.
4. Before closure, `applyPipelineGateBeforeClosure` evaluates gates: if blocking roles lack required artifacts, the task is downgraded with detailed findings.
5. Legacy tasks (without `require_pipeline_gates`) pass through with `allowMissingGates: true`.

Legacy compatibility strategy:

- Tasks created before this change do not have `require_pipeline_gates` and are treated as legacy.
- Legacy tasks bypass pipeline gate enforcement: `allowMissingGates` is set to `true` based on `isLegacyTask(task)`.
- Explicit legacy markers (`legacy: true`, `agent_pipeline: false`, `skip_pipeline: true`) are still respected.

### Context-Index

Path: `backend/src/context-index/`

Responsibilities:

- Chunk goal/task/conversation/result context.
- Retrieve relevant context with local JSON or optional Zvec store.
- Write bounded `context.bundle.md` and diagnostic `context.retrieval.json`.

Zvec is a rebuildable index, not a source of truth. Goal/task/result state and Git remain authoritative facts.

### Integration

Paths: `backend/src/integration-queue.mjs`, `backend/src/auto-integration-completion.mjs`, `backend/src/task-worktree-manager.mjs`

Responsibilities:

- Isolate work in per-task branches/worktrees.
- Attempt ff-only integration when policy and evidence allow.
- Track branch push, PR creation, merge, and verification-after-merge as different states.

Required semantics:

- `branch_pushed != merged`
- `pr_opened != merged`
- `merged != deployed`

### Tasks

Paths: `backend/src/task-*.mjs`, `backend/src/goal-task-*.mjs`, `backend/src/codex-*.mjs`

Responsibilities:

- Create/link goals and tasks.
- Build Codex prompts and run metadata.
- Execute Codex workers.
- Parse result JSON/stdout fallback.
- Write final task state and artifacts.

The task processor orchestrates smaller modules rather than owning all acceptance, integration, and closure policy inline.

### Agent Execution Backends

Path: `backend/src/agent-execution-backends.mjs`

Assigned agent tasks execute through a small backend abstraction before result parsing and final writeback. The default backend is `codex_exec`, which preserves the existing Codex CLI path. Operators can select `local_command` or `null` globally or per role with runtime config:

```text
GPTWORK_AGENT_BACKEND=codex_exec
GPTWORK_AGENT_ROLE_BACKENDS=builder=codex_exec,verifier=local_command,reviewer=null
GPTWORK_AGENT_LOCAL_COMMAND=npm --prefix backend test
GPTWORK_AGENT_ROLE_COMMANDS=verifier=npm --prefix backend test||reviewer=node scripts/review.mjs
```

All backends return the same execution envelope: `cr`, `parsedResult`, `summary`, `backend`, and role metadata. Task results record `execution_backend` and `execution_backend_role` so review packets can tell which backend produced the evidence.

## Goal Workspace Files

```text
.gptwork/goals/<goal_id>/codex.entry.md          bounded execution entry; read first
.gptwork/goals/<goal_id>/context.bundle.md       preferred compact supporting context
.gptwork/goals/<goal_id>/context.retrieval.json  retrieval diagnostics
.gptwork/goals/<goal_id>/context.json            metadata lookup
.gptwork/goals/<goal_id>/goal.md                 deep lookup when needed
.gptwork/goals/<goal_id>/transcript.md           deep conversation lookup when needed
.gptwork/goals/<goal_id>/payload.json            payload debug only
.gptwork/goals/<goal_id>/payload.base64          payload debug only
.gptwork/goals/<goal_id>/result.json             structured result contract
.gptwork/goals/<goal_id>/result.md               human-readable result
```

Codex should not read complete goal context by default. Start with `codex.entry.md`, then `context.bundle.md` if present, then targeted deep lookup only when necessary.

## Tool Surface

Tool exposure is controlled by `GPTWORK_TOOL_MODE`:

- `minimal`: health/status and narrow task/context entry points.
- `standard`: normal ChatGPT use; includes goals, tasks, queue, review, context, safe reads, and coordination tools.
- `operator`: diagnostics and read-heavy operations.
- `codex`: execution-oriented surface for Codex.
- `full`: all tools, including high-risk debug/restart functions.

ChatGPT should normally use `standard`. `full` is for trusted operator sessions only.

## Operational Architecture

- `open_project_context` is the recommended first ChatGPT call.
- `project_context_status` / `context_status` diagnose project context and context-index health without exposing secrets.
- `runtime_status` checks running commit, restart markers, worker state, repo locks, and process facts.
- `schedule_service_restart` is the safe two-phase restart path for self-restart tasks.
- `release-delivery-check.mjs --fast` is the current lightweight delivery gate.

## Security Boundaries

- Do not write tokens, `.env` contents, API keys, GitHub tokens, or notification keys into docs, payloads, transcripts, results, or Issues.
- Path-token URLs may be documented only with placeholders.
- Workspace file tools must stay inside selected workspace roots.
- A healthy HTTP response is not deployment evidence for a specific commit.

## Related Documents

- [Current Status](current-status.md)
- [Operations](operations.md)
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md)
- [中文主文档](../README.zh-CN.md)
