# Architecture

> Source-backed as of 2026-07-22.

## Overview

GPTWork is a control-plane backend that coordinates:

1. MCP clients (ChatGPT / operators)
2. durable Goal/Task state
3. Codex execution providers
4. evidence-based acceptance and closure

```text
MCP Client
   |
   v
HTTP/SSE MCP Server (backend/src/gptwork-server.mjs)
   |
   +--> Tool Groups (server-tools.mjs)
   +--> StateStore (.gptwork/state.json)
   +--> Goal files (.gptwork/goals/<id>/)
   +--> Codex Worker Loop
           |
           v
       Task Execution Runner
           |
           +--> Provider (codex_tui / codex_exec)
           +--> Acceptance / Convergence
           +--> Repair / Integration
           +--> Pipeline Gates / Finalizer
```

## Process Model

### CLI / server process

Entry: `backend/src/cli.mjs`

- builds runtime config
- kills stale port holders best-effort
- writes `/tmp/gptwork-mcp.pid`
- creates server via `createGptWorkServer()`
- listens on `/mcp` and `/health`
- optionally starts Codex worker

### Plugin proxy process

Entry: `plugins/gpt-codex-workspace/mcp/server.mjs`

- speaks local MCP stdio frames
- forwards JSON-RPC to `GPTWORK_MCP_URL`
- attaches bearer token / session id

## State Architecture

### Structured state

`StateStore` persists:

- users / teams / projects / workspaces
- goals / tasks
- conversations / memories
- agent_runs
- goal_queue
- workstreams / context_links
- chatgpt_requests
- activities / audit
- progression_commands

Path default:

```text
${workspaceRoot}/.gptwork/state.json
```

Indexes exist for task/goal lookup and codex active/terminal queues.

### Goal workspace files

Each goal has a readable working package under:

```text
.gptwork/goals/<goal_id>/
```

Important files:

- `goal.md`, `context.json`, `transcript.md`
- `codex.entry.md`
- `result.md`, `result.json`
- `acceptance.contract.json`
- context/manifest/artifact files

Backend is source of truth for orchestration state; goal files are the human/agent-readable execution package and evidence surface.

## Request Path

```text
POST /mcp
  -> http-handler.mjs
  -> server.handleRpc()
  -> tools/list | tools/call | resources/*
  -> tool handler in a tool group
  -> StateStore / services / worker side effects
```

Auth:

- token list / token contexts
- optional path token
- scope and workspace/project checks inside tools

## Execution Path

Primary autonomous path:

```text
create_encoded_goal / create_goal / create_task
  -> ensureTaskGoal
  -> task assigned to codex
  -> worker tick
  -> runAssignedCodexTasks
  -> processGeneralTask
  -> runTaskExecution
```

`runTaskExecution` responsibilities:

1. mark running and ensure goal linkage
2. write planner/context agent_runs
3. ensure pipeline runs for non-legacy tasks
4. resolve repository plan
5. require hosted workspace
6. materialize worktree or use canonical path
7. acquire repo lock
8. prepare prompt/run artifacts
9. dispatch provider
10. normalize evidence/result
11. acceptance + convergence
12. repair or integration
13. pipeline gate
14. final writeback

### Providers

Provider selection policy:

- explicit provider if requested
- else prefer `codex_tui` when available
- else fall back to `codex_exec`

Normalized Codex provider IDs:

- `codex_tui_goal`
- `codex_exec`

Migration note:

- current default dispatch still uses the legacy orchestrator path in `task-provider-dispatcher.mjs`
- `execution-run-bridge.mjs` / `execution-core/` are newer abstractions and are not the unconditional default

## Lifecycle Subsystems

### Goal Queue

`goal-queue.mjs` manages ordered goal execution with:

- waiting / ready / running / blocked / completed / failed / cancelled
- dependency checks
- auto-start when worker has free slots
- auto-advance after task completion

### Pipeline

`pipeline-orchestration.mjs` and `agent-run-service.mjs` model multi-role work:

- context_curator
- planner
- builder
- verifier
- reviewer
- finalizer
- integrator

Gates can block closure for new tasks.

### Acceptance and finalization

- `acceptance-agent.mjs`
- `task-convergence.mjs`
- `repair-loop.mjs`
- `integration-queue.mjs`
- `task-finalizer.mjs`
- `task-final-writeback.mjs`

Closure is evidence-driven.

### Supervisor review

`supervisor-review/` is a separate control plane for:

- review packets
- decisions
- commands
- controller leases
- TUI corrections
- quiescence checks

It is intended to keep human/supervisor intervention bounded and auditable.

## Isolation

Default ordinary code tasks use git worktrees.

Supporting mechanisms:

- repo locks
- task worktree verification
- workstream identity fields
- per-goal artifact directories

Canonical execution is used for deploy/admin or when worktrees are disabled.

## Tool Surface

Tools are composed in `server-tools.mjs` from many groups:

- goals / tasks / queue
- workspace read/write/ops
- codex tui
- github sync
- browser
- review / recovery / retention
- workstream / planning / artifacts
- system diagnostics / doctor / product status

Visibility is filtered by `toolMode` and optional delayed discovery.

## Known Reality Gaps

Documented intentionally because the code currently reflects them:

1. Task processing pipeline stages are partially skeletal; business logic is concentrated in `task-execution-runner.mjs`.
2. Execution provider stack is mid-migration.
3. `GPTWORK_EXECUTE_PROVIDER` default (`claude_tui_goal`) is not the same concept as Codex task default provider (`codex_tui_goal`).
4. Worker ignores non-`full` task modes at execution time.
