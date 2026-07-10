# GPTWork TUI Workstream Productization Design

## Product Goal

Build a product-grade orchestration layer in GPTWork where a durable Workstream groups multiple ChatGPT conversations, GPTWork conversations, Goals, Tasks, Codex TUI sessions, native Codex threads, Git worktrees, subagent runs, acceptance runs, repairs, and integration outcomes. GPTWork owns worktree lifecycle; Codex TUI runs inside the task worktree; ChatGPT coordinates, reviews, repairs, and advances the Workstream.

## Product Principles

1. `workstream_id` is the durable business identity. ChatGPT conversation IDs, GPTWork `conv_*` IDs, Goal IDs, Task IDs, TUI session IDs, Codex thread IDs, branches, and commits are linked contexts rather than the root identity.
2. GPTWork internal conversations remain authoritative local execution context. ChatGPT conversation IDs are external many-to-many links and must never replace internal conversation IDs.
3. Every code-writing Task gets one isolated Git worktree, one branch, one execution record, and one parent Codex TUI session.
4. Parallel code writing happens across Tasks/worktrees. Within one TUI, parallel subagents are read-oriented by default and one implementer owns writes.
5. The controller advances by bounded idempotent ticks. It never creates an unbounded internal loop.
6. Every completed Goal/Task must update a task-specific product document and include that document in `changed_files` and completion evidence.
7. ChatGPT is the preferred repair executor. When direct ChatGPT workspace mutation is unavailable or blocked, the controller creates a bounded repair Goal/Task for Codex.

## Architecture

### Durable Identity Layer

Add first-class Workstream and context-link records. A Workstream owns a root Goal, workflow ID, repository binding, status, execution policy, acceptance policy, and summary. Context links connect external and internal identifiers through typed relations.

Required record families:

- `workstreams`
- `context_links`
- `executions`
- existing `goals`, `tasks`, `conversations`, `memories`, `agent_runs`

### Execution Layer

Task repository resolution remains two-phase:

1. `resolveTaskRepositoryPlan()` calculates canonical repository, branch, and task worktree path without mutation.
2. `materializeTaskWorktree()` creates or reuses the task worktree.

Codex TUI startup must call both phases and launch with `cwd = task_worktree_path`. Session records persist `workstream_id`, `execution_id`, worktree path, branch, base/head commits, GPTWork conversation ID, optional ChatGPT conversation IDs, and optional Codex native thread ID.

### Subagent Layer

The parent TUI runs a fixed product pipeline:

1. context curator
2. explorer/architect/test analyst in parallel where supported
3. planner
4. one builder/implementer
5. verifier
6. reviewer
7. bounded repairer
8. finalizer

The parent writes structured progress to `.gptwork/goals/<goal_id>/progress.json` and `.gptwork/goals/<goal_id>/subagents.json`. ChatGPT and the controller consume these files instead of parsing ANSI screen state.

### Orchestration Layer

A Workstream graph contains Goals, Tasks, dependencies, parallel groups, and join/integration nodes. Ready Tasks are selected only when dependency policy is satisfied and execution capacity is available. The integration Task consumes accepted child branches and produces one integrated head plus full verification.

### Acceptance and Repair Layer

Each Task has an acceptance contract. Acceptance collects result artifacts, Git evidence, test evidence, worktree state, changed-file scope, and reviewer findings. Verdicts are `passed`, `failed`, `partial`, or `blocked`.

- `passed`: release dependencies.
- `failed`: ChatGPT attempts a direct bounded fix first; if unavailable, create a repair Task.
- `partial`: create a convergence Task scoped to unmet criteria.
- `blocked`: record a ChatGPT coordination request or dependency wait.

Maximum automatic repair iterations: 2. Maximum automatic advance depth per controller tick: 5. Default Workstream parallel Task limit: 3.

### Product UI Layer

Extend the Apps SDK widget/card surface with:

- Workstream list summary
- Workstream DAG/status view
- Task execution detail
- TUI/subagent progress
- acceptance and repair state
- ChatGPT decision requests

Product Design work must first capture the current card/widget behavior, define the intended user outcome, present three visual directions, select one direction, then implement and compare the rendered result with the selected source visual.

## State Model

### Workstream

```json
{
  "id": "ws_gptwork_tui_productization_20260711",
  "title": "GPTWork TUI Workstream Productization",
  "project_id": "default",
  "workspace_id": "hosted-default",
  "repo_id": "default",
  "root_goal_id": "goal_xxx",
  "workflow_id": "wf_gptwork_tui_productization_20260711",
  "status": "planned",
  "execution_policy": {
    "max_parallel_tasks": 3,
    "max_tui_sessions": 3,
    "max_subagents_per_task": 4,
    "max_subagent_depth": 1,
    "max_repair_iterations": 2
  },
  "acceptance_policy": {
    "require_clean_worktree": true,
    "require_commit": true,
    "require_tests": true,
    "require_documentation_update": true
  }
}
```

### Context Link

```json
{
  "id": "link_xxx",
  "workstream_id": "ws_gptwork_tui_productization_20260711",
  "kind": "chatgpt_conversation",
  "external_id": "conversation-id",
  "relation": "originates",
  "goal_id": "goal_xxx",
  "task_id": null,
  "metadata": {},
  "first_seen_at": "ISO-8601",
  "last_seen_at": "ISO-8601"
}
```

### Execution

```json
{
  "id": "exec_xxx",
  "workstream_id": "ws_gptwork_tui_productization_20260711",
  "goal_id": "goal_xxx",
  "task_id": "task_xxx",
  "provider": "codex_tui_goal",
  "session_id": "tui_xxx",
  "status": "running",
  "worktree_path": "/absolute/path",
  "branch": "gptwork/ws/task",
  "base_commit": "sha",
  "head_commit": null,
  "codex_thread_id": null
}
```

## Controller Contract

`workstream_tick(workstream_id)` performs one bounded reconciliation pass:

1. load Workstream and graph;
2. reconcile Goal, Task, execution, TUI, queue, lock, and worktree state;
3. detect drift from declared scope, phase, dependencies, and acceptance contract;
4. detect stalled work using missing progress, inactive TUI, stale worker state, or unchanged artifacts;
5. attempt direct ChatGPT correction where a small deterministic repository edit is sufficient;
6. create a repair Goal/Task when direct mutation is unavailable, blocked, too broad, or requires sustained execution;
7. collect and accept terminal Tasks;
8. release dependencies and start ready Tasks within capacity;
9. create or advance the integration Task;
10. update Workstream summary and task-specific documentation evidence.

Repeated ticks over identical state must not create duplicate Tasks, repairs, executions, or proposals.

## Documentation Contract

Each child Goal owns one document under `docs/workstreams/tui-productization/`:

- `01-workstream-context.md`
- `02-tui-worktree-execution.md`
- `03-execution-subagents.md`
- `04-dag-orchestration.md`
- `05-acceptance-controller.md`
- `06-product-experience.md`
- `07-integration-release.md`

A Task cannot be accepted unless its owned document contains:

- delivered behavior;
- affected interfaces and files;
- tests and exact commands;
- migration/compatibility notes;
- known limitations;
- next integration dependency;
- completion commit.

The integration Goal updates `docs/workstreams/tui-productization/README.md`, `docs/current-status.md`, `README.md`, and `README.zh-CN.md`.

## Verification

Focused tests are added per subsystem, followed by:

```bash
npm --prefix backend run check:syntax
npm --prefix backend test
```

Release verification additionally runs the existing TUI, worktree, queue, acceptance, repair, workflow, Apps SDK card, and end-to-end convergence tests. The final result must include exact commands, pass/fail counts, commit SHAs, changed files, documentation files, and unresolved blockers.

## Compatibility

Existing Goal, Task, workflow, TUI, worker, queue, GitHub sync, and result APIs remain valid. Legacy records without `workstream_id` are read through a compatibility resolver and may be migrated lazily. Existing internal `conv_*` identifiers are preserved.

## Self-Review

The design has no unresolved placeholders. Each product requirement maps to a subsystem, a durable record, a tool/API surface, an acceptance path, and an owned documentation artifact. The design deliberately postpones database migration; the current JSON state store remains the initial persistence layer.