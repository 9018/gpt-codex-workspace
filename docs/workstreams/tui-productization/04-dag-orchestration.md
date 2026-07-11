# Workstream DAG Orchestration

## Overview

Workstream DAG (Directed Acyclic Graph) orchestration provides declarative dependency
management, parallel fan-out, and join/integration nodes for workstream execution.

### Architecture

```
workstream-dag-service  ──  dependency-resolver  ──  task-fanout-service
                                                      task-join-service
                                                      execution-capacity
```

All state is stored in-state via `task-dag-service.mjs`, which persists DAG nodes
and edges in `state.workstream_dag`.

## New Modules

| File | Purpose |
|------|---------|
| `orchestration/dependency-resolver.mjs` | Cycle detection, stable topological sort, join condition evaluation |
| `orchestration/task-dag-service.mjs` | Durable DAG node and edge CRUD, execution graph queries, ready-node detection |
| `orchestration/task-fanout-service.mjs` | Creates parallel shard nodes with idempotent workstream+phase+shard+iteration key |
| `orchestration/task-join-service.mjs` | Creates join/integration nodes, evaluates join conditions, manual release |
| `orchestration/execution-capacity.mjs` | Global, per-repo, per-workstream, per-TUI capacity enforcement |
| `orchestration/workstream-orchestration-tools-group.mjs` | MCP tools: create_workstream_fanout, get_workstream_execution_graph, start_workstream_ready_tasks, create_workstream_join |

## Join Conditions

| Condition | Behavior |
|-----------|----------|
| `all_completed` | All predecessors must reach a terminal status (completed/failed/cancelled) |
| `all_passed` | All predecessors must complete with acceptance gate passed |
| `any_passed` | At least one predecessor must pass acceptance (early completion) |
| `manual_release` | Never auto-advances; must be explicitly released via manual_release_workstream_join tool |

## Cycle Detection

Cycles are rejected at two levels:
1. **Edge creation**: `addDagEdge()` checks for cycles before committing
2. **Batch validation**: `createDagBatch()` validates the entire graph after creation and rolls back on cycle detection

The detection algorithm uses DFS with ancestor tracking (`detectCycle()`).

## Topological Sort

`stableTopologicalSort()` uses Kahn's algorithm with deterministic tie-breaking
(alphabetical ordering of nodes with equal priority). This ensures reproducible
execution graphs across invocations.

## Fan-Out

Fan-out creates N parallel shard nodes from a parent "fanout" node. The parent
node is immediately set to "completed" status as its purpose is purely structural.

**Idempotency key**: `workstream_id + ":" + phase + ":" + "fanout" + ":" + iteration`

Each shard node gets a unique ID:
`workstream_id + ":" + phase + ":" + shard_prefix_N + ":" + iteration`

## Join Nodes

Join nodes wait for all predecessors to complete before transitioning to "ready".

**Idempotency key**: `workstream_id + ":" + phase + ":" + shard_key + ":" + iteration`

## Capacity Limits

| Level | Default Max | Controlled By |
|-------|-------------|---------------|
| Global | 10 | `execution-capacity.mjs` DEFAULT_CAPACITY_LIMITS |
| Per-repo | 3 | `checkExecutionCapacity()` |
| Per-workstream | 5 | `checkExecutionCapacity()` |
| TUI global | 20 | `checkTuiCapacity()` |
| TUI per-workstream | 3 | `checkTuiCapacity()` |

## Task Graph State Extensions

Two new graph nodes have been added to `task-graph-state.mjs`:

- `fanout_waiting`: Task is waiting for fan-out parallelism to complete
- `join_waiting`: Task is waiting at a join node for its dependencies

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_workstream_fanout` | Create parallel shards for a workstream phase |
| `get_workstream_execution_graph` | Get the full DAG with topological order |
| `start_workstream_ready_tasks` | Start all DAG-ready workstream tasks |
| `create_workstream_join` | Create a join/integration node |
| `evaluate_workstream_join` | Check if a join condition is met (read-only) |
| `manual_release_workstream_join` | Trigger manual release for a join node |
| `get_workstream_capacity` | Get execution capacity status |

## Compatibility

Existing queue and task graph behavior is fully preserved. Non-workstream items
continue to use the simple `depends_on_goal_id`/`depends_on_task_id` dependency
model with no DAG overhead. The DAG orchestration is an optional layer that only
engages when workstream_id is set on queue items.

## Test Coverage

- `test/workstream-dag.test.mjs` — Cycle detection, topological sort, DAG CRUD, validation
- `test/workstream-fanout-join.test.mjs` — Fan-out creation, join creation, idempotency, manual release
- `test/workstream-capacity.test.mjs` — Capacity counting, limit enforcement, status reports
