// @ts-check
/**
 * workstream-orchestration-tools-group.mjs — MCP tool registrations
 * for workstream DAG orchestration: fan-out, graph queries,
 * ready-task start, and join creation.
 *
 * Exposes the 4 required tools:
 *   create_workstream_fanout      - Create parallel shard nodes
 *   get_workstream_execution_graph - Get the full DAG with topo order
 *   start_workstream_ready_tasks  - Start all DAG-ready workstream tasks
 *   create_workstream_join        - Create a join/integration node
 *
 * Tool mode exposure: standard, codex, full
 */

import { createWorkstreamFanout } from "./task-fanout-service.mjs";
import { getExecutionGraph, getReadyNodes, updateDagNode, buildAdjacency } from "./task-dag-service.mjs";
import { createWorkstreamJoin, evaluateJoinCondition, manualReleaseJoin } from "./task-join-service.mjs";
import { getCapacityStatus, checkExecutionCapacity, checkTuiCapacity } from "./execution-capacity.mjs";
import { checkJoinCondition, JOIN_CONDITIONS, validateDependencyGraph, detectCycle, stableTopologicalSort } from "./dependency-resolver.mjs";

export function createWorkstreamOrchestrationToolsGroup({ tool, schema, store }) {
  const common = {
    audience: ["chatgpt", "codex"],
    modes: ["standard", "codex", "full"],
    tags: ["workstream", "orchestration", "dag"],
    outputTemplate: "ui://widget/gptwork-card-v2.html",
    resourceUri: "ui://widget/gptwork-card-v2.html",
  };

  return {
    // -----------------------------------------------------------------------
    // create_workstream_fanout
    // -----------------------------------------------------------------------
    create_workstream_fanout: tool({
      name: "create_workstream_fanout",
      description: "Create parallel fan-out shards for a workstream phase. Generates N child DAG nodes that can execute in parallel. Idempotent: re-invocation with the same workstream_id+phase+iteration key returns the existing fan-out structure.",
      inputSchema: schema({
        workstream_id: {
          type: "string",
          description: "Owning workstream ID (ws_*)",
          examples: ["ws_a1b2c3"],
        },
        phase: {
          type: "string",
          description: "Execution phase label (e.g. 'backend', 'frontend', 'test')",
          default: "default",
        },
        shard_count: {
          type: "integer",
          description: "Number of parallel shards to create (1-100)",
          minimum: 1,
          maximum: 100,
          default: 2,
        },
        shard_prefix: {
          type: "string",
          description: "Prefix for shard keys",
          default: "shard",
        },
        iteration: {
          type: "integer",
          description: "Iteration number for idempotency",
          default: 0,
        },
        metadata: {
          type: "object",
          description: "Optional metadata to attach to each shard",
        },
      }, ["workstream_id"]),
      ...common,
      handler: async (args, context) => {
        const result = await createWorkstreamFanout(store, {
          workstream_id: args.workstream_id,
          phase: args.phase,
          shard_count: args.shard_count ? Number(args.shard_count) : 2,
          shard_prefix: args.shard_prefix || "shard",
          iteration: args.iteration !== undefined ? Number(args.iteration) : 0,
          metadata: args.metadata || {},
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // get_workstream_execution_graph
    // -----------------------------------------------------------------------
    get_workstream_execution_graph: tool({
      name: "get_workstream_execution_graph",
      description: "Get the full execution graph for a workstream. Returns all DAG nodes, edges, topological order, and validation results including cycle detection and orphan checks.",
      inputSchema: schema({
        workstream_id: {
          type: "string",
          description: "Workstream ID (ws_*)",
          examples: ["ws_a1b2c3"],
        },
      }, ["workstream_id"]),
      ...common,
      handler: async (args, context) => {
        const graph = await getExecutionGraph(store, args.workstream_id);
        return graph;
      },
    }),

    // -----------------------------------------------------------------------
    // start_workstream_ready_tasks
    // -----------------------------------------------------------------------
    start_workstream_ready_tasks: tool({
      name: "start_workstream_ready_tasks",
      description: "Find and start all DAG-ready workstream tasks whose dependencies are satisfied. Returns list of started node IDs and any nodes that were blocked by capacity limits.",
      inputSchema: schema({
        workstream_id: {
          type: "string",
          description: "Workstream ID (ws_*)",
          examples: ["ws_a1b2c3"],
        },
        dry_run: {
          type: "boolean",
          description: "If true, report what would be started without actually starting",
          default: false,
        },
        goal_id: {
          type: "string",
          description: "Optional goal ID to enqueue for each ready node",
        },
      }, ["workstream_id"]),
      ...common,
      handler: async (args, context) => {
        const { workstream_id, dry_run, goal_id } = args;
        const state = store._state || await store.load();

        // Get ready nodes from DAG
        const readyNodeIds = await getReadyNodes(store, workstream_id);

        if (readyNodeIds.length === 0) {
          return { started: [], blocked: [], reason: "No ready nodes" };
        }

        // Check capacity
        const capacityResult = checkExecutionCapacity(state, { workstream_id });
        const started = [];
        const blocked = [];

        for (const nodeId of readyNodeIds) {
          if (!capacityResult.allowed && started.length === 0) {
            blocked.push({ node_id: nodeId, reason: capacityResult.reason });
            continue;
          }

          if (dry_run) {
            started.push({ node_id: nodeId, status: "would_start", dry_run: true });
            continue;
          }

          // Update node status to running
          try {
            const updated = await updateDagNode(store, nodeId, { status: "ready" });
            started.push({ node_id: nodeId, status: "ready" });
          } catch (err) {
            blocked.push({ node_id: nodeId, reason: err.message });
          }
        }

        return {
          started,
          blocked,
          capacity: capacityResult,
          total_ready: readyNodeIds.length,
        };
      },
    }),

    // -----------------------------------------------------------------------
    // create_workstream_join
    // -----------------------------------------------------------------------
    create_workstream_join: tool({
      name: "create_workstream_join",
      description: "Create a join/integration node that waits for predecessors to complete. Supports join conditions: all_completed (all predecessors reach any terminal status), all_passed (all predecessors pass acceptance), any_passed (first passing predecessor triggers join), manual_release (must be manually released). Idempotent using workstream_id+phase+shard_key+iteration.",
      inputSchema: schema({
        workstream_id: {
          type: "string",
          description: "Owning workstream ID (ws_*)",
          examples: ["ws_a1b2c3"],
        },
        phase: {
          type: "string",
          description: "Execution phase for the join node",
          default: "default",
        },
        predecessor_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of predecessor DAG node IDs that the join waits for",
          examples: [["ws_a1b2c3:backend:shard_0:0", "ws_a1b2c3:backend:shard_1:0"]],
        },
        join_condition: {
          type: "string",
          description: "Join condition: all_completed, all_passed, any_passed, or manual_release",
          default: "all_completed",
          enum: Object.values(JOIN_CONDITIONS),
        },
        shard_key: {
          type: "string",
          description: "Shard key for the join node",
          default: "join",
        },
        iteration: {
          type: "integer",
          description: "Iteration number for idempotency",
          default: 0,
        },
        metadata: {
          type: "object",
          description: "Optional metadata",
        },
      }, ["workstream_id", "predecessor_ids"]),
      ...common,
      handler: async (args, context) => {
        const result = await createWorkstreamJoin(store, {
          workstream_id: args.workstream_id,
          phase: args.phase,
          predecessor_ids: args.predecessor_ids,
          join_condition: args.join_condition || JOIN_CONDITIONS.ALL_COMPLETED,
          shard_key: args.shard_key || "join",
          iteration: args.iteration !== undefined ? Number(args.iteration) : 0,
          metadata: args.metadata || {},
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // evaluate_workstream_join (auxiliary but useful)
    // -----------------------------------------------------------------------
    evaluate_workstream_join: tool({
      name: "evaluate_workstream_join",
      description: "Evaluate whether a join node's condition is satisfied. Returns satisfied/reason/details without mutating state.",
      inputSchema: schema({
        node_id: {
          type: "string",
          description: "DAG node ID of the join node",
        },
        manual_release_triggered: {
          type: "boolean",
          description: "Whether manual release has been triggered (for manual_release joins)",
          default: false,
        },
      }, ["node_id"]),
      ...common,
      handler: async (args, context) => {
        const state = store._state || await store.load();
        const getNodeState = (nodeId) => {
          const nodes = state.workstream_dag?.nodes || {};
          return nodes[nodeId] || null;
        };
        const result = await evaluateJoinCondition(store, args.node_id, getNodeState, {
          manualReleaseTriggered: args.manual_release_triggered === true,
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // manual_release_workstream_join
    // -----------------------------------------------------------------------
    manual_release_workstream_join: tool({
      name: "manual_release_workstream_join",
      description: "Trigger manual release for a join/integration node. Sets manual_release_triggered=true in metadata so the join can be re-evaluated.",
      inputSchema: schema({
        node_id: {
          type: "string",
          description: "DAG node ID of the join/integration node",
        },
      }, ["node_id"]),
      ...common,
      handler: async (args, context) => {
        const result = await manualReleaseJoin(store, args.node_id);
        return { join_node: result };
      },
    }),

    // -----------------------------------------------------------------------
    // get_workstream_capacity
    // -----------------------------------------------------------------------
    get_workstream_capacity: tool({
      name: "get_workstream_capacity",
      description: "Get execution capacity status for a workstream (or globally). Returns active/max counts for global, TUI, per-repo, and per-workstream levels.",
      inputSchema: schema({
        workstream_id: {
          type: "string",
          description: "Optional workstream ID to filter capacity status",
        },
      }),
      ...common,
      handler: async (args, context) => {
        const state = store._state || await store.load();
        const status = getCapacityStatus(state, { workstream_id: args.workstream_id });
        return status;
      },
    }),
  };
}
