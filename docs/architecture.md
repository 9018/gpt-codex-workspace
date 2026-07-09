# GPT-Codex Workspace Architecture

**Status**: current main, productized modular delivery pipeline (P0-P1).
**Canonical baseline**: `140c70a` (P0-AutoTerm: evidence reconciliation fix).

## Objective

GPTWork is a backend MCP coordination service for ChatGPT and Codex. It stores goals, tasks, bounded context, worktree execution metadata, verification evidence, acceptance decisions, review packets, integration state, queue state, and operational diagnostics.

The architecture enforces a clear separation of concerns across these facts:

- **verification**: commands/checks passed
- **acceptance**: user goal satisfied (automatic via contract verifier)
- **integration**: change reached canonical main or was explicitly not required
- **deployment**: running environment uses the expected commit/configuration
- **closure**: task can be closed (deterministic policy over existing facts)
- **review**: human judgment needed, not automatic failure
- **terminalization**: finalizer decision that gates queue advancement

## Operating Model

```
ChatGPT
  -> open_project_context
  -> create_encoded_goal
  -> compact review/status tools

GPTWork backend
  -> goal/task state
  -> context bundle and retrieval diagnostics
  -> queue, worktree, repo lock, verification, acceptance, closure
  -> pipeline gate enforcement (multi-agent roles)
  -> finalizer gate (safe_to_auto_advance)
  -> review packet and operations tools
  -> worker auto-advance runtime gate

Codex
  -> reads codex.entry.md first
  -> uses context.bundle.md when available
  -> deep lookups only when entry+bundle insufficient
  -> edits inside the execution worktree
  -> writes result.json/result.md, verification evidence
```

## Core Flow

```
User request
  -> ChatGPT creates preview and encoded payload
  -> create_encoded_goal(assign_to_codex=true)
  -> backend writes .gptwork/goals/<goal_id>/ files
  -> context-index writes context.bundle.md and context.retrieval.json
  -> goal enqueued (auto_start=true by default)

  -> queue auto-advance tick evaluates typed eligibility gates:
       prerequisite_terminals -> acceptance_gate -> dependency
       -> finalizer_terminal -> repo_concurrency -> repo_lock -> dirty_worktree
  -> first eligible item advances to task assignment

  -> Codex worker picks up task (GPTWORK_CODEX_WORKER=true)
  -> reads codex.entry.md first
  -> uses context.bundle.md for supporting context when present
  -> degradation warnings emitted when bundle is missing
  -> deep lookups (goal.md, transcript.md) only when entry+bundle insufficient

  -> Codex executes in a per-task worktree
       primary: codex exec (default production path)
       fallback: codex_tui (explicit operator fallback)

  -> result parser/recovery normalizes result.json/stdout evidence
  -> delivery recovery handles dirty worktree and changed_files mismatch
  -> evidence profiles normalize operation facts (code_change, readonly, etc.)
  -> contract verifier checks acceptance contract and state assertions
  -> run evidence written (events.jsonl, verification.log, acceptance.evidence.json)

  -> finalizer decision evaluates safe_to_auto_advance
  -> integration completion attempts ff-only merge when eligible
  -> if accepted+integrated -> final writeback marks task, goal, queue item completed
     -> auto-start next eligible queue item via queueAutoAdvanceTick
  -> if review needed -> typed review state with blocking findings
  -> repair tasks created automatically for recoverable failures
  -> closure decider returns close/review/repair/integration state
  -> review packet exposes compact evidence for humans/ChatGPT
```

## Module Boundaries

---

### Acceptance

Paths: `backend/src/acceptance/`, `backend/src/acceptance-contract-verifier.mjs`

Responsibilities:

- Build acceptance contracts from goal intent and task operation kind.
- Validate contract shape and semantic consistency against schema.
- Apply operation profiles (code_change, readonly_validation, diagnostic, noop).
- Verify blocking requirements (commit, changed_files, verification, integration).
- Verify optional requirements and state assertions.
- Generate quality notes and non-blocking follow-up findings.

Acceptance is **automatic** via the contract verifier. It is about satisfying the user's objective, not about command success alone. The contract verifier enforces:

- Blocking requirements must all pass before the task can close.
- Non-blocking quality concerns are recorded as followup_findings, not used to block.
- Evidence profiles ensure each operation kind is verified with the right expectations (e.g., readonly tasks do not require code changes).

### Evidence

Paths: `backend/src/evidence/`, `backend/src/run-evidence/`

Responsibilities:

- Normalize task result fields and operation-specific evidence.
- Preserve integration/deployment/verification facts independently.
- Surface missing evidence explicitly.
- Collect run-evidence artifacts: `events.jsonl` (structured event log), `verification.log` (compact verification and git evidence), `acceptance.evidence.json` (structured evidence with findings).

Evidence modules prevent shortcuts such as treating `health 200` as deployment proof or treating a pushed branch as a merge. Run evidence paths are stored in `result.evidence_paths` so review packets and task cards can surface them without reading raw transcripts.

### Assertions

Paths: `backend/src/assertions/`

Responsibilities:

- Run contract state assertions.
- Report assertion failures as structured findings.
- Keep assertion evidence separate from command verification.
- Support no-change-repair assertion: detect tasks that produced no evidence of change and classify cleanly.

### Closure

Path: `backend/src/closure/`

Responsibilities:

- Decide whether a task can close, needs review, needs repair, or needs integration, using deterministic policy over existing facts.
- Treat `quality_notes` and `non_blocking_followups` as non-blocking (do not create followups).
- Recognize `resolved_by_successor` and `superseded` as terminal states for repair-chain cleanup.
- Closure is **deterministic policy** over existing facts; it does not create new implementation evidence.

Terminalization is automatic under the normal contract. The closure decider returns one of:
- `auto_completed` -- all blocking requirements satisfied, no review needed
- `auto_completed_with_followups` -- completed with non-blocking notes
- `waiting_for_review` -- human judgment needed
- `waiting_for_integration` -- completed but not yet integrated
- `waiting_for_repair` -- recoverable failure, repair task created

### Review

Paths: `backend/src/review/`

Responsibilities:

- Build compact acceptance bundles and review packets.
- Include contract summary, result summary, verification, contract verification, closure decision, changed files, missing evidence, blockers/follow-ups, and recommended next action.
- Include pipeline gate info (blocked status, reasons, missing roles/artifacts) when gates are enforced.
- Exclude full transcript, durable memories, raw context bundle, payload files, and large diffs.

Review means **human judgment**. It is not equivalent to failure.

**Typed review states** (P0-03, 6 canonical states) classify review-required tasks by resolution path:

| Typed State | Resolution |
|---|---|
| `waiting_for_evidence_missing` | Machine-repairable; does not block current work |
| `waiting_for_policy_uncertain` | Machine-repairable; does not block current work |
| `waiting_for_provider_unavailable` | Machine-repairable; does not block current work |
| `waiting_for_human_required` | Human-required; blocks current work |
| `waiting_for_human_review` | Human-required; blocks current work |
| `waiting_for_repair_budget_exhausted` | Human-required; blocks current work |
| `waiting_for_manual_terminal_decision` | Human-required; blocks current work |

Current blocker policy (`current-blocker-policy.mjs`) further classifies review tasks into actionable decision labels: `review`, `integration`, `active`, `completed`, `failure_evidence`, `code_evidence_failure`, `provider_empty`, `resolved_by_options`, `unknown_status`.

### Pipeline Gate Enforcement & Multi-Agent Pipeline

Paths: `backend/src/pipeline-orchestration.mjs`, `backend/src/agent-run-writeback.mjs`, `backend/src/agent-artifact-contract.mjs`, `backend/src/agent-execution-backends.mjs`

A pipeline of agent roles executes sequentially for tasks that require pipeline gates, including new builder/deploy/admin tasks. Each role has a default backend, execution semantic, and expected artifact kind.

**Pipeline Roles and Default Backends:**

| Role | Default Backend | Execution Semantic | Evidence Source | Description |
|---|---|---|---|---|
| context_curator | `codex_exec` | `real` | Codex CLI agent execution | Prepare context bundle and manifest |
| planner | `codex_exec` | `real` | Codex CLI agent execution | Determine plan from entry/bundle |
| builder | `codex_exec` | `real` | Codex CLI agent execution | Execute code changes |
| verifier | `codex_exec` | `real` | Codex CLI agent execution | Run verification suite (can be switched to `local_command` via `agentRoleBackends`) |
| reviewer | `codex_exec` | `real` | Codex CLI agent execution | Run structured review (can be switched to `local_command` via `agentRoleBackends`) |
| integrator | `codex_exec` | `real` | Codex CLI agent execution | Complete integration handoff (can be switched to `null`/auto_artifact via `agentRoleBackends`) |
| finalizer | `codex_exec` | `real` | Codex CLI agent execution | Evaluate safe_to_auto_advance (can be switched to `null`/auto_artifact via `agentRoleBackends`) |
| repairer | `codex_exec` | `real` | Codex CLI agent execution | Recovery branch for failed tasks |

**Pipeline execution order**: `context_curator -> planner -> builder -> verifier -> reviewer -> integrator -> finalizer`

`repairer` is a recovery branch (not in the default pipeline). It runs when a builder task fails recoverably.

**Execution backend semantics** (`AGENT_BACKEND_SEMANTIC` in `agent-execution-backends.mjs`):

| Semantic | Backend Set | Meaning |
|---|---|---|
| `real` | `codex_exec` or `local_command` | Actual execution with side effects |
| `auto_artifact` | `null` | Auto-completed from existing evidence |
| `test_noop` | `null` (test-only) | Test stub, explicitly marked `test_only` |
| `configured` | `null` (operator choice) | Operator explicitly selected null backend |

Both `codex_exec` and `local_command` are `real` executions -- the former runs a Codex LLM agent, the latter runs a deterministic shell command. Both produce side effects.

**Backend resolution precedence** (`resolveAgentBackendId()`):
1. Task-level: `task.agent_backend` / `task.metadata.agent_backend` (highest priority)
2. Role-level config: `config.agentRoleBackends` / `config.agentBackendByRole` (user explicit override)
3. Global config / product default: `config.agentBackend` / `config.agentBackendDefault` (e.g. `GPTWORK_AGENT_BACKEND=codex_exec`)
4. Role fallback: `ROLE_BACKEND_DEFAULTS` — all roles are `codex_exec` by product default (only when none of the above is set)

**Gate enforcement flow:**

1. Task creation in `buildGoalTask` sets `require_pipeline_gates: true` for new builder/deploy/admin tasks.
2. `ensurePipelineRunsForTask` creates agent_run records for each pipeline role.
3. Agent writeback functions record completed runs with output artifacts per `ARTIFACT_SCHEMA.required_by_role`.
4. Before closure, `applyPipelineGateBeforeClosure` evaluates gates: blocking roles must have completed runs with required artifact kinds.
5. Missing required artifacts downgrade the task from `completed` to `waiting_for_review`.
6. Legacy tasks (without `require_pipeline_gates`) pass through with `allowMissingGates: true`.

### Context-Index & Layered Context

Paths: `backend/src/context-index/`

GPTWork organizes execution context into a layered system designed to give Codex the minimal information needed for each task, while keeping deep context available only when explicitly needed.

**Layer hierarchy (Codex entry flow):**

```
Tier 1 (always available):   codex.entry.md (bounded entrypoint)
Tier 2 (preferred):          context.bundle.md, context.manifest.json
Tier 3 (deep lookup):        goal.md, context.json, transcript.md
Tier 4 (authoritative):      result.json, acceptance.contract.json, git state
```

Three principles guide the context layer:

1. **Entry-first**: Codex always starts from `codex.entry.md`, not the full goal/transcript.
2. **Degrade cleanly**: When a context component is unavailable, the system describes the degradation explicitly so Codex can adapt.
3. **Prioritize facts over indexes**: Durable files (git, result, diagnostics) are authoritative. Vector/retrieval indexes are rebuildable caches.

**Context bundle building** uses two-phase retrieval:
1. **Cross-goal retrieval**: Searches all indexed goals for related context (no goal_id filter).
2. **Per-goal retrieval**: Searches the current goal's index for precision.

Chunks are scored and boosted by evidence type (accepted_result: +0.25, repair_result: +0.22, integration_result: +0.20) with stale/noop penalty (-0.30). The bundle is capped at configurable max tokens (default 2048) and max chunks (default 8).

**Degradation warnings** are injected into the Codex prompt when:
- `context.bundle.md` is missing -- Codex relies on entry + deep lookups only.
- Retrieval produced zero chunks -- diagnostic_only mode, fall back to durable sources.
- Transcript exceeds 100 KB -- warning not to read by default.

**Context index stores** resolve via `GPTWORK_CONTEXT_VECTOR_STORE`:
- `auto` (default): Try `@zvec/zvec`; fall back to `local-json-store`.
- `zvec`: Require `@zvec/zvec`; warn if unavailable.
- `local`: Use `local-json-store` directly.

Vector store (zvec/local-json) is optional and rebuildable. It is not a source of truth. Durable facts remain in goal/task/result state, conversation records, Git commits, and runtime diagnostics. When indexing fails, `maybeBuildContextBundle()` returns `{ ok: false, warning }` and the system writes only a diagnostic `context.retrieval.json`.

**Project context files** (`project.md`, `project.env` under canonical repo `.gptwork/`) are optional lookups. `project.env` uses hot-loaded KEY=VALUE pairs per Codex context build -- it does NOT mutate `process.env`. Secret-like key names are detected and redacted in diagnostics.

See [docs/context-layer.md](context-layer.md) for the full context layer specification.

### Queue Auto-Advance

Paths: `backend/src/goal-queue.mjs`, `backend/src/queue-policy.mjs`, `backend/src/queue-reconciler.mjs`, `backend/src/codex-worker-loop.mjs`

The execution queue (`state.goal_queue`) holds ordered items representing goals waiting to run. The queue is driven forward by the auto-advance tick on every worker cycle.

**Queue status lifecycle:**

```
waiting -> ready -> running -> completed|failed
waiting -> blocked (typed reason in blocked_reason)
blocked -> ready (reconciler detects resolved dependency)
running -> completed|failed
```

**Typed eligibility gates** (P0-MA8, 9 gates evaluated in order):

| Gate | Typed Constant | Condition |
|---|---|---|
| Prerequisite terminal | `WAITING_FOR_REVIEW/REPAIR/INTEGRATION` | Prerequisite task in non-terminal state |
| Acceptance gate | `ACCEPTANCE_NOT_SATISFIED` | Prerequisite completed but acceptance explicitly failed |
| Generic dependency | `DEPENDENCY_NOT_TERMINAL` | Dependency task/goal not in terminal-completed state |
| Finalizer terminal | `FINALIZER_NOT_TERMINAL` | Completed prerequisite without terminal finalizer decision |
| Dependency policy | (via `checkDependency`) | `completed_only` or `terminal_any` policy |
| Repo concurrency | (serialization) | Same-repo conflict with running item |
| Active repo lock | `ACTIVE_REPO_LOCK` | Unreleased lock for canonical repo |
| Dirty worktree | `DIRTY_WORKTREE` | Uncommitted changes in canonical repo |

The first failing gate short-circuits and sets the typed `blocked_reason`.

**Auto-advance tick execution** (`queueAutoAdvanceTick`):
1. Load state
2. Run reconcileQueue with `fixStaleBlockers=true` -- detect and unblock resolved dependencies
3. Filter eligible items (status=waiting|ready, auto_start=true)
4. For each candidate in position order: run `checkTypedEligibility`; advance first eligible item; block ineligible items with typed reason

**Queue reconciler** (`queue-reconciler.mjs`):
- `resolveQueueDependencyState` -- integration-aware dependency resolution (flags completed but unintegrated tasks), readonly detection, repair-chain awareness, extended terminal states.
- `detectStaleBlockers` -- classifies blocked items as `dependency_resolved`, `dependency_failed_terminal`, or `dependency_in_progress`.
- `reconcileQueue` -- applies reconciler decisions (dry-run or mutation).
- `propagateRepairSuccess` -- cascades unblocking after a repair task completes.

**Dependency policy**: `completed_only` (default) vs `terminal_any`. Goal dependencies use durable goal status -- a completed task for a still-open goal is not enough.

**Auto-start on task completed** routes through `queueAutoAdvanceTick` for full typed eligibility evaluation. Non-terminal completion explicitly blocks all task-level dependents with `ACCEPTANCE_NOT_SATISFIED`.

See [docs/queue-auto-advance.md](queue-auto-advance.md) for the full queue auto-advance specification.

### Integration

Paths: `backend/src/integration-queue.mjs`, `backend/src/auto-integration-completion.mjs`, `backend/src/task-worktree-manager.mjs`

Responsibilities:

- Isolate work in per-task branches/worktrees.
- Attempt ff-only integration when policy and evidence allow.
- Track branch push, PR creation, merge, and verification-after-merge as different states.
- Support auto-integration completion with verification report generation.

Required semantics:

- `branch_pushed != merged` (non-terminal state)
- `pr_opened != merged` (non-terminal state)
- `merged != deployed` (separate evidence types)

Integration is **queue-aware**: the reconciler detects `integration_required_and_missing` and blocks dependent queue items with `INTEGRATION_NOT_SATISFIED`. Readonly/noop tasks do not require integration. Repair-chain supersedence is recognized.

Auto-integration verification reports are generated outside the canonical repository by default, keeping the canonical repo clean for the dirty-repo guard that protects queue auto-advance.

### Finalizer & Terminalization

Paths: `backend/src/closure/`, `backend/src/agent-execution-backends.mjs` (finalizer role)

The finalizer pipeline role evaluates whether a completed task can safely unblock queue dependents. It runs after integration but before the queue advance decision.

**Finalizer decision fields on task result:**

```json
{
  "finalizer_decision": {
    "safe_to_auto_advance": true,
    "queue_effect": { "unblock_dependents": true }
  }
}
```

**Finalizer gate passes** when any of these is true:
- `finalizer_decision.safe_to_auto_advance === true`
- `finalizer_decision.queue_effect.unblock_dependents === true`
- `closure_decision.status` starts with `"auto_completed"`

If none pass, the queue item is blocked with `FINALIZER_NOT_TERMINAL`.

The finalizer uses the `null` backend (auto-artifact from result evidence). It does not execute external commands. The `safe_to_auto_advance` decision is based on:
- Acceptance contract satisfaction (blocking requirements pass)
- No unresolved review/integration/repair findings
- No pipeline gate violations

Terminalization is **unified**: the same closure decider evaluates all paths (acceptance, integration, review, repair) and produces a deterministic terminal decision. The finalizer gate ensures this decision is complete before queue advancement.

### Tasks

Paths: `backend/src/task-*.mjs`, `backend/src/goal-task-*.mjs`, `backend/src/codex-*.mjs`, `backend/src/task-final-writeback.mjs`

Responsibilities:

- Create/link goals and tasks.
- Build Codex prompts and run metadata.
- Execute Codex workers.
- Parse result JSON/stdout fallback.
- Handle delivery recovery (dirty worktree, changed_files mismatch).
- Execute final writeback (mark task, goal, queue item completed).
- Write final task state and artifacts.

The task processor orchestrates smaller modules rather than owning all acceptance, integration, and closure policy inline.

**Task state machine:**

```
created -> queued -> waiting_for_dependency -> queued -> waiting_for_lock
                                                              |
                                              materializing_worktree
                                                      |
                                                  assigned
                                                      |
                                                  running -> timed_out
                                                      |
                                                verifying -----> completed
                                                   |
                                           waiting_for_repair
                                                   |
                                              repairing -> verifying (re-entry)
                                                   |
                                        waiting_for_integration
                                                   |
                                              integrating -> completed
```

Terminal states: `completed`, `failed`, `waiting_for_review`, `cancelled`, `timed_out`.

### Agent Execution Backends

Path: `backend/src/agent-execution-backends.mjs`

Assigned agent tasks execute through a small backend abstraction before result parsing and final writeback. Supported backends:

- `codex_exec` (default for all pipeline roles by product default): Real Codex CLI execution.
- `local_command` (explicit override only): Deterministic shell command execution, commonly used for verifier/reviewer in constrained deployments.
- `null` (explicit override only): Auto-artifact from result evidence for roles that support deterministic completion.

**Runtime configuration:**

```text
GPTWORK_AGENT_BACKEND=codex_exec                                    # Global default
GPTWORK_AGENT_ROLE_BACKENDS=verifier=local_command,reviewer=local_command  # Optional explicit per-role overrides
GPTWORK_AGENT_LOCAL_COMMAND=npm --prefix backend test               # Default shell command
GPTWORK_AGENT_ROLE_COMMANDS=verifier=npm test||reviewer=node scripts/review.mjs  # Per-role commands
```

All backends return the same execution envelope: `cr`, `parsedResult`, `summary`, `backend`, `role`, and `execution_semantic`. Task results record `execution_backend` and `execution_backend_role` so review packets can tell which backend produced the evidence.

`normalizeBackendResult()` normalizes all backend results into a unified structure with `execution_semantic`, `evidence_source`, `null_reason`, and inherited `parsed` fields.

## Goal Workspace Files

```text
.gptwork/goals/<goal_id>/codex.entry.md          bounded execution entry; read first
.gptwork/goals/<goal_id>/context.bundle.md       preferred compact supporting context
.gptwork/goals/<goal_id>/context.manifest.json   artifact map for diagnostics
.gptwork/goals/<goal_id>/context.retrieval.json  retrieval diagnostics
.gptwork/goals/<goal_id>/context.json            metadata lookup
.gptwork/goals/<goal_id>/goal.md                 deep lookup when needed
.gptwork/goals/<goal_id>/transcript.md           deep conversation lookup when needed
.gptwork/goals/<goal_id>/payload.json            payload debug only
.gptwork/goals/<goal_id>/payload.base64          payload debug only
.gptwork/goals/<goal_id>/acceptance.contract.json  acceptance criteria contract
.gptwork/goals/<goal_id>/result.json             structured result contract
.gptwork/goals/<goal_id>/result.md               human-readable result
```

Codex must not read complete goal context by default. Start with `codex.entry.md`, then `context.bundle.md` if present, then targeted deep lookup only when necessary.

Run evidence files may also be present:

```text
.gptwork/goals/<goal_id>/events.jsonl             structured event log
.gptwork/goals/<goal_id>/verification.log         compact verification and git evidence
.gptwork/goals/<goal_id>/acceptance.evidence.json  structured acceptance evidence
.gptwork/goals/<goal_id>/implementation-diff.patch  diff when available
```

## Tool Surface

Tool exposure is controlled by `GPTWORK_TOOL_MODE` (or local config):

| Mode | Scope |
|---|---|
| `minimal` | health/status and narrow task/context entry points |
| `standard` | normal ChatGPT use (goals, tasks, queue, review, context, safe reads, coordination) |
| `operator` | diagnostics and read-heavy operations |
| `codex` | execution-oriented surface for Codex |
| `full` | all tools, including high-risk debug/restart functions |

ChatGPT normally uses `standard`. `full` is for trusted operator sessions.

## Worker Runtime Gate (Auto-Advance)

The Codex worker loop (`startCodexWorker` in `codex-worker-loop.mjs`) drives the auto-advance cycle. The queue does not advance without a running worker.

**Required environment variable**: `GPTWORK_CODEX_WORKER=true`

**Worker health phases** (`computeWorkerHealth`):

| Phase | Condition | Queue Advancing? |
|---|---|---|
| `disabled` | `enabled=false` | No |
| `enabled_but_not_running` | Between ticks or never started | Yes (healthy idle) |
| `running` | Tick currently executing | Yes |
| `stalled` | Last tick finished > 6x interval ago | No |
| `overdue` | Next tick due > 3x interval in past | No |

**Heartbeat diagnostics** tracked in worker state:
- `last_tick_started_at`, `last_tick_finished_at`, `last_tick_duration_ms`
- `next_tick_due_at`, `current_interval_ms`

Surfaced via `runtime_status`, `worker_status`, and `product_status` diagnostic tools.

**Auto-advance runtime conditions:**
1. Worker is running and healthy (phase is `running` or `enabled_but_not_running`).
2. Queue items have `auto_start=true`.
3. Dependency resolution is automated -- no manual `complete_task`/`reconcile` calls needed for the normal accepted/integrated path.
4. Integration requirements are satisfied or waived (readonly/noop).
5. Finalizer gate is terminal (`safe_to_auto_advance: true`).
6. No active or stale repo lock for the canonical repo.
7. Canonical worktree is clean (no uncommitted changes).

**Product status dashboard** (`product_status` tool, P1-09) provides a single-pane-of-glass overview:
- System, Worker, Queue, Blockers, Review, Retention, TUI Provider, Config, Next Actions.
- Raw counts separated from actionable blockers.
- Review tasks classified by typed review state / resolution path.
- Retention pressure diagnostics (none/medium/high relative to `GPTWORK_RETENTION_LIMIT`).

### Codex Exec as Automated Path (P0-07)

`codex_exec` is the default production execution mode. All tasks use `codex exec` CLI by default. The hardened production path includes:

- `codex-run-diagnostics.mjs` -- failure classification and diagnostics.
- `self-healing-policy.mjs` -- dirty worktree recovery, changed_files reconciliation.
- `delivery-result-recovery.mjs` -- recovery evidence for missing results.
- `task-final-writeback.mjs` -- stronger result fallback and evidence.
- `task-codex-execution.mjs` -- timeout and no-output diagnosis.

**Execution flow:**

```
codex exec -> result parsing -> acceptance check -> delivery recovery -> finalization
```

**Failure classification:**

| Failure Class | Severity | Auto Action |
|---|---|---|
| `no_first_output_timeout` | Recoverable | Compact and retry |
| `codex_timeout` | Failed/Recoverable | Compact and retry + recovery evidence |
| `result_missing` | Failed | Fallback parse and retry |
| `dirty_worktree_after_codex` | Recoverable | delivery_result_recovery |
| `changed_files_mismatch` | Recoverable | Reconcile from git |

All non-normal paths auto-resolve: recoverable -> create repair task or auto-retry; unrecoverable -> `waiting_for_review` with precise `review_reason` and `blocking_findings`.

**Runtime metrics** recorded during execution: `stdout_bytes`, `stderr_bytes`, `first_output_delay_ms`, `content_first_output_delay_ms`, `no_content_first_output_timeout`, `no_content_progress_timeout`.

**Provider/model detection** via `extractHeaderMetadata()`: extracts `model`, `api_provider`, `reasoning_effort` from Codex CLI banner output.

### Codex TUI Operator Fallback (P1-08)

`codex_exec` is the default production execution mode. `codex_tui` is available as an **explicit-only fallback** for operator sessions.

| Feature | `codex_exec` (default) | `codex_tui` (fallback) |
|---|---|---|
| Automation | Fully automatic | Human-driven |
| Start | `codex exec` CLI | Interactive PTY session |
| Evidence | Auto-generated structured result | Operator writes result.md |
| Acceptance | Automatic closure flow | Requires durable evidence first |

**TUI enablement** requires both:
1. Runtime config: `config.codexTuiEnabled=true` or `env.GPTWORK_CODEX_TUI_ENABLED=true`
2. Task metadata: `task.metadata.codex_execution_provider="codex_tui_goal"`

**Evidence chain for TUI -> acceptance:**
1. `result.md` must exist in goal directory
2. Clean worktree (all changes committed)
3. Commit evidence present

The `collectCodexTuiCompletion()` function returns `ready_for_review=true` when evidence is sufficient, with structured findings (`result_md_missing`, `dirty_worktree`, `commit_missing`) when it is not.

**Superpowers plugin preflight** (`GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=true`): TUI fallback requires the Superpowers plugin. If missing, `codex_exec` remains the fallback provider.

## Init/Onboarding (P0-06)

Path: `backend/src/onboarding-init.mjs`
CLI: `backend/bin/gptwork.mjs` subcommands `init`, `doctor`, `fix`, `status`, `connect`, `self-test`

Productized onboarding flow:
1. `gptwork init` runs diagnostics and auto-fixes common issues.
2. `gptwork doctor --local` performs detailed env validation, repo registry check, and config safety.
3. `gptwork fix` auto-creates missing files and resolves dependency gaps.

## Retention and Worktree GC

Retention diagnostics via `product_status` and `retention_status` tools evaluate task/goal counts against `GPTWORK_RETENTION_LIMIT` (default 50):
- `none`: task <= limit, goal <= limit
- `medium`: task or goal > limit (<= 2x)
- `high`: task or goal > 2x limit

Cleanup policies per goal:
- `always_remove`: remove worktree immediately after task completion
- `remove_on_success_retain_on_failure`: remove on success, retain on failure/review
- `always_retain`: never auto-remove worktree

Tools: `retention_status`/`retention_cleanup`, `tmp_status`/`cleanup_tmp`, `goal_storage_status`/`cleanup_goals`. All support `dry_run=true` mode.

## Security Boundaries

- Do not write tokens, `.env` contents, API keys, GitHub tokens, or notification keys into docs, payloads, transcripts, results, or Issues.
- Path-token URLs may be documented only with placeholders.
- Workspace file tools must stay inside selected workspace roots.
- A healthy HTTP response is not deployment evidence for a specific commit.
- Auth is required by default (`GPTWORK_REQUIRE_AUTH=true`).

## Related Documents

- [Current Status](current-status.md)
- [Operations](operations.md)
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md)
- [Context Layer](context-layer.md)
- [Queue Auto-Advance](queue-auto-advance.md)
- [Goal Queue](goal-queue.md)
- [Closure Acceptance](closure-acceptance.md)
- [Codex Exec Production Mode](codex-exec-production-mode.md)
- [Run Evidence](run-evidence.md)
- [Task State Machine](delivery/task-state-machine.md)
- [Release Gate](delivery/release-gate.md)
- [中文主文档](../README.zh-CN.md)

---

*This documentation is synchronized with the current codebase implementation (commit `140c70a`).*

---

## Reference Docs

- [Closed-Loop Automation](closed-loop-automation.md) — Goal → Task → Agent → Evidence → Acceptance → Replan/Continue/Stop 闭环设计
- [Closure and Acceptance](closure-acceptance.md) — 验收门、合同验证、闭环节点判定详解
- [E2E Acceptance](e2e-acceptance.md) — 端到端交付流程与验收
