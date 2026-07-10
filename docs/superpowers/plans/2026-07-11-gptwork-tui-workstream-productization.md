# GPTWork TUI Workstream Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize GPTWork into a durable Workstream orchestrator that runs parallel Codex TUI tasks in isolated Git worktrees, exposes structured subagent progress, and performs bounded automatic acceptance, repair, integration, and hourly supervision.

**Architecture:** Add Workstream/context-link and execution records around the existing JSON state store, then route TUI startup through the existing two-phase worktree materialization path. Build DAG scheduling and acceptance as bounded idempotent services, expose high-level MCP tools, and extend the Apps SDK card/widget with Workstream-oriented views. Preserve all existing public tool names and legacy `conv_*` conversation behavior.

**Tech Stack:** Node.js ESM, built-in `node:test`, current JSON StateStore, Git worktrees, Codex CLI TUI through PTY, Apps SDK widget HTML/JavaScript, existing MCP tool registry and result-card infrastructure.

## Global Constraints

- Durable workstream key: `ws_gptwork_tui_productization_20260711` during transition; production records use generated `ws_*` IDs.
- Keep GPTWork internal `conversation_id = conv_*`; ChatGPT conversation IDs are context links.
- One writing Task owns one worktree, branch, execution, and parent TUI session.
- Default Workstream parallel Task limit: 3.
- Default TUI subagent limit: 4; recursion depth: 1.
- Maximum automatic repair iterations: 2.
- Maximum automatic transitions per `workstream_tick`: 5.
- Every completed Task must update its owned document under `docs/workstreams/tui-productization/`.
- Every subsystem is developed test-first and committed independently.

---

### Goal 1: Workstream Identity, Context Links, and Legacy Compatibility

**Files:**
- Create: `backend/src/workstream/workstream-model.mjs`
- Create: `backend/src/workstream/workstream-store.mjs`
- Create: `backend/src/workstream/workstream-service.mjs`
- Create: `backend/src/workstream/workstream-context-links.mjs`
- Create: `backend/src/tool-groups/workstream-tools-group.mjs`
- Modify: `backend/src/state-store.mjs`
- Modify: `backend/src/goal-task-goals.mjs`
- Modify: `backend/src/goal-task-task-factory.mjs`
- Modify: `backend/src/server-tools.mjs`
- Test: `backend/test/workstream-model.test.mjs`
- Test: `backend/test/workstream-tools-group.test.mjs`
- Test: `backend/test/workstream-legacy-migration.test.mjs`
- Document: `docs/workstreams/tui-productization/01-workstream-context.md`

**Interfaces:**
- Produces `createWorkstream(store, input)`, `getWorkstream(store, id)`, `listWorkstreams(store, filters)`, `updateWorkstream(store, id, patch)`.
- Produces `linkWorkstreamContext(store, input)`, `listWorkstreamLinks(store, filters)`, `resolveWorkstreamsByContext(store, kind, externalId)`.
- Adds optional `workstream_id`, `root_goal_id`, `parent_goal_id`, `phase`, `iteration`, `shard_key`, and `workflow_id` to Goal/Task records.

- [ ] Write failing model tests that initialize missing arrays, reject duplicate Workstream IDs, preserve legacy records, and round-trip context links.
- [ ] Run `node --test backend/test/workstream-model.test.mjs`; expect failures caused by missing modules.
- [ ] Implement record normalization and state initialization without rewriting existing state families.
- [ ] Write failing MCP tool tests for `create_workstream`, `get_workstream`, `list_workstreams`, `update_workstream`, `link_workstream_context`, `list_workstream_links`, and `resolve_workstream_by_context`.
- [ ] Register the new tool group with metadata consistent with existing tool groups.
- [ ] Add lazy compatibility resolution for Goals and Tasks without `workstream_id`; do not mutate records during read-only listing.
- [ ] Run the three focused test files and existing `goal-tools`, `state-store`, and `public-tool-names` tests.
- [ ] Update `01-workstream-context.md` with schemas, tool examples, migration behavior, exact test commands, changed files, and completion commit.
- [ ] Commit with `feat: add workstream identity and context links`.

**Acceptance:** Multiple ChatGPT conversation IDs and Codex thread IDs can link to one Workstream; one external context can resolve back to its Workstream; internal `conv_*` IDs remain unchanged; legacy Goal/Task reads still pass.

---

### Goal 2: Codex TUI Execution in Task Worktrees

**Files:**
- Modify: `backend/src/tool-groups/codex-tui-tools-group.mjs`
- Modify: `backend/src/task-repo-resolution.mjs`
- Modify: `backend/src/task-worktree-manager.mjs`
- Modify: `backend/src/codex-tui-session-manager.mjs`
- Modify: `backend/src/codex-tui-session-store.mjs`
- Modify: `backend/src/codex-tui-completion-collector.mjs`
- Create: `backend/src/executions/execution-store.mjs`
- Create: `backend/src/executions/execution-service.mjs`
- Test: `backend/test/codex-tui-task-worktree.test.mjs`
- Test: `backend/test/execution-service.test.mjs`
- Extend: `backend/test/codex-tui-tools-group.test.mjs`
- Extend: `backend/test/task-repo-resolution.test.mjs`
- Document: `docs/workstreams/tui-productization/02-tui-worktree-execution.md`

**Interfaces:**
- TUI startup materializes the task worktree and launches with `cwd = task_worktree_path`.
- Produces execution records with `id`, `workstream_id`, `goal_id`, `task_id`, `provider`, `session_id`, `status`, `worktree_path`, `branch`, `base_commit`, `head_commit`, and optional `codex_thread_id`.
- Completion collection reads Git/result evidence from the execution worktree rather than the canonical repository.

- [ ] Write a failing test that passes a repository plan with distinct canonical and task worktree paths and asserts the PTY adapter receives the task worktree as `cwd`.
- [ ] Run the focused test; expect the current canonical-repository `cwd` behavior to fail.
- [ ] Change startup to call `materializeTaskWorktree()` and block only when the task worktree cannot be created or is dirty.
- [ ] Persist worktree/branch/base commit on both Task and TUI session records.
- [ ] Add execution creation, status transition, lookup, and terminal writeback tests and implementation.
- [ ] Update completion collection and lock release to use the execution worktree path.
- [ ] Add a parallel-start test proving two Tasks produce two different worktrees and TUI `cwd` values.
- [ ] Run existing TUI session, PTY, worktree manager, repo lock, completion collector, and provider-routing tests.
- [ ] Update `02-tui-worktree-execution.md` with lifecycle, paths, branch naming, cleanup behavior, tests, and completion commit.
- [ ] Commit with `feat: run codex tui tasks in isolated worktrees`.

**Acceptance:** Two tasks can launch TUI sessions with different worktree paths; neither writes to the canonical checkout; each result bundle contains its worktree, branch, base/head commit, changed files, and documentation update.

---

### Goal 3: Structured TUI/Subagent Progress and Parent Pipeline

**Files:**
- Create: `backend/src/subagents/subagent-policy.mjs`
- Create: `backend/src/subagents/subagent-progress-store.mjs`
- Create: `backend/src/subagents/subagent-result-normalizer.mjs`
- Modify: `backend/src/codex-tui-goal-prompt.mjs`
- Modify: `backend/src/codex-tui-session-store.mjs`
- Modify: `backend/src/tool-groups/codex-tui-tools-group.mjs`
- Modify: `backend/src/agent-run-service.mjs`
- Test: `backend/test/subagent-progress-store.test.mjs`
- Test: `backend/test/codex-tui-product-prompt.test.mjs`
- Extend: `backend/test/subagent-policy.test.mjs`
- Extend: `backend/test/codex-tui-session-store.test.mjs`
- Document: `docs/workstreams/tui-productization/03-execution-subagents.md`

**Interfaces:**
- Writes `.gptwork/goals/<goal_id>/progress.json` and `.gptwork/goals/<goal_id>/subagents.json` atomically.
- Exposes `codex_tui_progress(session_id)` and `codex_tui_subagents(session_id)`.
- Parent prompt requires context curator, planner, one builder, verifier, reviewer, bounded repairer, and finalizer roles.

- [ ] Write failing tests for atomic progress writes, malformed-file recovery, stale-progress classification, and normalized agent states.
- [ ] Implement structured progress storage with timestamps, phase, status, current action, blockers, next event, agent role, summary, changed files, and artifacts.
- [ ] Write a failing prompt test asserting one-writer semantics, maximum two repair rounds, required result artifacts, and required documentation update.
- [ ] Update the TUI prompt builder and session metadata with progress/subagent artifact paths.
- [ ] Add MCP read tools that return structured progress without parsing ANSI output.
- [ ] Link structured subagent entries to existing `agent_runs` where an agent run ID is available.
- [ ] Run focused tests plus existing `agent-run-service`, `pipeline-orchestration`, `codex-tui-goal-prompt`, and TUI session tests.
- [ ] Update `03-execution-subagents.md` with role contract, JSON schemas, prompt flow, examples, tests, and completion commit.
- [ ] Commit with `feat: expose structured tui subagent progress`.

**Acceptance:** ChatGPT can determine phase, activity, blockers, and subagent states without reading the terminal screen; the parent TUI uses one writing implementer and records final result/document evidence.

---

### Goal 4: Workstream DAG, Fan-Out, Join, and Capacity Scheduling

**Files:**
- Create: `backend/src/orchestration/task-dag-service.mjs`
- Create: `backend/src/orchestration/dependency-resolver.mjs`
- Create: `backend/src/orchestration/task-fanout-service.mjs`
- Create: `backend/src/orchestration/task-join-service.mjs`
- Create: `backend/src/orchestration/execution-capacity.mjs`
- Create: `backend/src/tool-groups/workstream-orchestration-tools-group.mjs`
- Modify: `backend/src/goal-queue.mjs`
- Modify: `backend/src/task-graph-state.mjs`
- Modify: `backend/src/server-tools.mjs`
- Test: `backend/test/workstream-dag.test.mjs`
- Test: `backend/test/workstream-fanout-join.test.mjs`
- Test: `backend/test/workstream-capacity.test.mjs`
- Extend: `backend/test/goal-queue.test.mjs`
- Extend: `backend/test/task-graph-state.test.mjs`
- Document: `docs/workstreams/tui-productization/04-dag-orchestration.md`

**Interfaces:**
- Supports dependency policies `all_completed`, `all_passed`, `any_passed`, and `manual_release`.
- Exposes `create_workstream_fanout`, `get_workstream_execution_graph`, `start_workstream_ready_tasks`, and `create_workstream_join`.
- Uses Workstream limits to select at most three ready writing Tasks.

- [ ] Write failing graph tests for cycle rejection, deterministic topological order, dependency-policy resolution, and stable graph serialization.
- [ ] Implement focused graph/dependency modules without embedding execution side effects.
- [ ] Write failing fan-out tests that create child Goals/Tasks with shared root/workstream fields and unique `shard_key` values.
- [ ] Implement fan-out and join creation with idempotency keys derived from Workstream, phase, shard, and iteration.
- [ ] Write capacity tests covering global, repository, Workstream, and TUI limits.
- [ ] Integrate ready-task selection with the existing queue while preserving existing queue behavior for non-Workstream Tasks.
- [ ] Run focused tests plus queue auto-advance, integration queue, task graph, and worker queue-count tests.
- [ ] Update `04-dag-orchestration.md` with dependency semantics, graph format, fan-out/join examples, tests, and completion commit.
- [ ] Commit with `feat: add workstream dag orchestration`.

**Acceptance:** Independent child Tasks can be represented and selected in parallel, dependencies prevent premature execution, duplicate fan-out/join calls are idempotent, and an integration Task becomes ready only after required child verdicts.

---

### Goal 5: Acceptance Controller, Repair/Convergence, Workstream Tick, and Drift Recovery

**Files:**
- Create: `backend/src/acceptance/workstream-acceptance-controller.mjs`
- Create: `backend/src/acceptance/workstream-acceptance-decision.mjs`
- Create: `backend/src/acceptance/workstream-repair-task-factory.mjs`
- Create: `backend/src/orchestration/workstream-tick.mjs`
- Create: `backend/src/orchestration/workstream-drift-detector.mjs`
- Create: `backend/src/orchestration/workstream-stall-detector.mjs`
- Create: `backend/src/tool-groups/workstream-controller-tools-group.mjs`
- Modify: `backend/src/workflow-advance.mjs`
- Modify: `backend/src/review-backlog-reconciler.mjs`
- Modify: `backend/src/server-tools.mjs`
- Test: `backend/test/workstream-acceptance-controller.test.mjs`
- Test: `backend/test/workstream-repair-budget.test.mjs`
- Test: `backend/test/workstream-tick.test.mjs`
- Test: `backend/test/workstream-drift-stall.test.mjs`
- Extend: `backend/test/workflow-tools-group.test.mjs`
- Document: `docs/workstreams/tui-productization/05-acceptance-controller.md`

**Interfaces:**
- Exposes `workstream_tick`, `workstream_accept`, `workstream_pause`, and `workstream_resume`.
- Produces deterministic verdicts `passed`, `failed`, `partial`, and `blocked`.
- Creates at most two repair Tasks per root Task and at most five transitions per tick.
- Returns a decision packet with actions, drift, stall diagnosis, repair decision, and next check recommendation.

- [ ] Write failing acceptance tests for result/artifact presence, clean worktree, commit, tests, changed-file scope, reviewer output, and documentation update.
- [ ] Implement deterministic acceptance composition over existing review packet and acceptance bundle services.
- [ ] Write failing repair-budget tests proving duplicate ticks do not create duplicate repairs and attempt three becomes a ChatGPT request rather than a new repair.
- [ ] Implement convergence Tasks for `partial` verdicts using only unmet acceptance criteria.
- [ ] Write failing drift/stall tests for wrong phase, wrong scope, stale progress, dead TUI session, stale worker, stale lock, and terminal Task/queue mismatch.
- [ ] Implement direct-correction proposals for small deterministic edits and fallback repair Goal creation when direct ChatGPT mutation is unavailable or blocked.
- [ ] Implement one bounded idempotent `workstream_tick` pass and compatibility delegation from existing workflow advancement.
- [ ] Run focused tests plus acceptance agent, repair loop, self-healing policy, stale-state sweeper, runtime patrol, workflow, and convergence tests.
- [ ] Update `05-acceptance-controller.md` with verdict rules, repair budget, drift/stall rules, direct-edit fallback policy, exact tests, and completion commit.
- [ ] Commit with `feat: add bounded workstream acceptance controller`.

**Acceptance:** A repeated tick over unchanged state is a no-op; passed Tasks release dependencies; failed/partial Tasks follow bounded repair/convergence paths; stalled or drifted Tasks are diagnosed and corrected or converted into explicit repair Tasks; completion requires documentation evidence.

---

### Goal 6: Product Experience and Apps SDK Workstream Views

**Files:**
- Modify: `backend/src/apps-sdk-card/widget.html`
- Modify: `backend/src/apps-sdk-card/constants.mjs`
- Modify: `backend/src/card-view-model.mjs`
- Modify: `backend/src/mcp-tooling.mjs`
- Create: `backend/src/workstream/workstream-card-view-model.mjs`
- Test: `backend/test/workstream-card-view-model.test.mjs`
- Extend: `backend/test/apps-sdk-card-smoke.test.mjs`
- Extend: `backend/test/card-view-model.test.mjs`
- Document: `docs/workstreams/tui-productization/06-product-experience.md`

**Product Design Sequence:**
- Capture the current card/widget views and identify the primary outcome: understand Workstream health and take the next corrective action in one view.
- Produce exactly three visual directions for Workstream list, DAG/status, Task execution detail, subagent progress, acceptance/repair, and ChatGPT requests.
- Record the selected direction and source visual in the task artifacts before implementation.
- Compare the rendered implementation against the selected direction and record QA findings.

- [ ] Write failing view-model tests for Workstream summary, graph node states, active executions, acceptance outcomes, repairs, and open decision requests.
- [ ] Implement a bounded Workstream card view model that does not embed full transcripts or raw logs.
- [ ] Extend the widget with accessible summary, graph/list fallback, Task detail, progress, and action affordances.
- [ ] Preserve existing card versions and legacy rendering paths.
- [ ] Run focused tests and existing Apps SDK/card smoke and payload contract tests.
- [ ] Update `06-product-experience.md` with user outcome, three directions, selected direction, interaction states, accessibility notes, screenshots/artifacts, QA result, tests, and completion commit.
- [ ] Commit with `feat: add workstream product views`.

**Acceptance:** The product surface clearly shows Workstream status, next action, parallel Tasks, TUI/subagent progress, failed acceptance, repairs, and pending ChatGPT requests while preserving legacy cards.

---

### Goal 7: Integration, End-to-End Release, Documentation, and Operational Handoff

**Files:**
- Create: `backend/test/e2e-workstream-productization.test.mjs`
- Create: `backend/test/workstream-hourly-supervisor.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/current-status.md`
- Create: `docs/workstreams/tui-productization/README.md`
- Create: `docs/workstreams/tui-productization/07-integration-release.md`
- Update all six subsystem documents with integrated commit references.

**Interfaces:**
- End-to-end scenario creates one Workstream, links multiple contexts, fans out three Tasks, materializes distinct worktrees, records structured subagents, accepts child results, creates integration, and completes the Workstream.
- Hourly supervisor contract consumes root and child Goal IDs, checks status/queue/locks/TUI/progress/docs, applies bounded corrections, and creates repair Tasks only when direct ChatGPT edits are unavailable.

- [ ] Integrate accepted subsystem branches into an integration worktree in dependency order.
- [ ] Resolve interface mismatches using the names and schemas declared in Goals 1–6; do not add parallel alternate APIs.
- [ ] Write the full end-to-end test and verify it fails before final integration fixes.
- [ ] Implement only the integration fixes required for the end-to-end scenario.
- [ ] Write the supervisor contract test covering normal progress, drift correction, stalled execution recovery, repair fallback, duplicate-run idempotency, and documentation enforcement.
- [ ] Run `npm --prefix backend run check:syntax`.
- [ ] Run all focused Workstream/TUI tests.
- [ ] Run `npm --prefix backend test`.
- [ ] Run GPTWork self-test, doctor, runtime status, repository status, and health check.
- [ ] Update `docs/workstreams/tui-productization/README.md`, `07-integration-release.md`, `docs/current-status.md`, `README.md`, and `README.zh-CN.md` with architecture, usage, MCP tools, hourly supervision, migration, exact verification evidence, and release commit.
- [ ] Commit with `feat: release workstream tui productization`.

**Acceptance:** The complete product flow is executable and documented; all subsystem and regression tests pass; hourly supervision is idempotent; every completed Task has an owned documentation update; the final Workstream summary points to commits, tests, docs, artifacts, and unresolved limitations.

## Goal Dependency Graph

```text
Goal 1: Workstream identity/context
  ├─ Goal 2: TUI task worktrees
  ├─ Goal 3: execution/subagent progress
  └─ Goal 4: DAG orchestration

Goal 2 + Goal 3 + Goal 4
  └─ Goal 5: acceptance/tick/drift/stall

Goal 1 + Goal 3 + Goal 5
  └─ Goal 6: product experience

Goal 1–6
  └─ Goal 7: integration/release
```

## Hourly Supervision Policy

The hourly supervisor must:

1. inspect the root Goal and all child Goals/Tasks;
2. inspect worker, queue, repo locks, TUI sessions, structured progress, review packets, acceptance bundles, Git state, and required documentation;
3. compare actual state to this dependency graph and each Goal acceptance contract;
4. correct small deterministic drift directly through ChatGPT workspace tools when possible;
5. use recovery tools for stale queue, stale locks, and stalled worker state;
6. create a bounded repair Goal/Task when direct modification is unavailable, blocked, broad, or requires sustained execution;
7. never create duplicate repair Tasks for the same root Task, failure class, and attempt;
8. require documentation updates before marking any Task passed;
9. stop creating new work after the integration Goal is completed and report the final release evidence.

## Self-Review

All design requirements map to Goals 1–7. Interfaces are named consistently across producers and consumers. Each Goal owns exact source, test, and documentation paths, has an independent review boundary, and ends in a commit. No unresolved placeholders remain.