// @ts-check
/**
 * task-fanout-service.mjs — Creates parallel fan-out shards for workstream tasks.
 *
 * Fan-out creates N child DAG nodes that can execute in parallel.
 * Idempotency is guaranteed by the composite key:
 *   workstream_id + phase + shard_key + iteration
 *
 * Each shard automatically links to the parent node via DAG edges.
 * Shards inherit the parent's workstream, phase, and iteration metadata.
 */

import {
  createDagNode,
  addDagEdge,
  getDagNode,
  updateDagNode,
  listDagNodes,
  buildAdjacency,
} from "./task-dag-service.mjs";
import { detectCycle } from "./dependency-resolver.mjs";

// ---------------------------------------------------------------------------
// Fanout key construction
// ---------------------------------------------------------------------------

/**
 * Build an idempotent fan-out shard key.
 *
 * @param {object} identity
 * @param {string} identity.workstream_id
 * @param {string} identity.phase
 * @param {string} identity.shard_key
 * @param {number} [identity.iteration]
 * @returns {string}
 */
export function buildShardNodeId(identity) {
  const parts = [
    identity.workstream_id,
    identity.phase || "default",
    identity.shard_key,
    String(identity.iteration ?? 0),
  ];
  return parts.join(":");
}

/**
 * Build a fan-out parent node ID.
 *
 * @param {object} identity
 * @param {string} identity.workstream_id
 * @param {string} identity.phase
 * @param {number} [identity.iteration]
 * @returns {string}
 */
export function buildFanoutParentNodeId(identity) {
  const parts = [
    identity.workstream_id,
    identity.phase || "default",
    "fanout",
    String(identity.iteration ?? 0),
  ];
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Fan-out creation
// ---------------------------------------------------------------------------

/**
 * Create a fan-out for a workstream task.
 *
 * Creates a parent fan-out node and N child shard nodes, each connected
 * to the parent via a DAG edge.
 *
 * Idempotent: if the parent fan-out node already exists for the given
 * identity key, returns the existing fan-out structure.
 *
 * @param {object} store - State store
 * @param {object} input
 * @param {string} input.workstream_id - Owning workstream
 * @param {string} input.phase - Execution phase
 * @param {number} input.shard_count - Number of parallel shards
 * @param {string} [input.shard_prefix] - Prefix for shard keys (default: "shard")
 * @param {number} [input.iteration] - Iteration number (default: 0)
 * @param {object} [input.metadata] - Metadata to attach to shards
 * @returns {Promise<object>} - { parent_node, shard_nodes, edges }
 */
export async function createWorkstreamFanout(store, input = {}) {
  const {
    workstream_id,
    phase = "default",
    shard_count = 2,
    shard_prefix = "shard",
    iteration = 0,
    metadata = {},
  } = input;

  if (!workstream_id) throw new Error("workstream_id is required");
  if (shard_count < 1 || shard_count > 100) {
    throw new Error("shard_count must be between 1 and 100");
  }

  const parentId = buildFanoutParentNodeId({ workstream_id, phase, iteration });

  // Idempotency check — if parent exists, return existing fan-out
  try {
    const existingParent = await getDagNode(store, parentId);
    if (existingParent) {
      const shards = await listDagNodes(store, workstream_id, { phase, node_type: "task" });
      const shardNodes = shards.filter((s) => {
        return s.metadata?.fanout_parent_id === parentId;
      });
      return {
        parent_node: existingParent,
        shard_nodes: shardNodes,
        edges: shardNodes.map((s) => ({
          from: parentId,
          to: s.id,
          condition: "all_completed",
        })),
        idempotent: true,
      };
    }
  } catch {
    // Node doesn't exist yet — proceed
  }

  // Create parent fan-out node
  const parentNode = await createDagNode(store, {
    id: parentId,
    workstream_id,
    phase,
    shard_key: "fanout",
    iteration,
    node_type: "fanout",
    status: "completed", // Fanout is immediately "complete" — it fans out at creation time
    metadata: {
      shard_count,
      shard_prefix,
      ...metadata,
    },
  });

  // Create shard nodes
  const shardNodes = [];
  for (let i = 0; i < shard_count; i++) {
    const shardKey = `${shard_prefix}_${i}`;
    const shardId = buildShardNodeId({
      workstream_id,
      phase,
      shard_key: shardKey,
      iteration,
    });

    try {
      const existingShard = await getDagNode(store, shardId);
      shardNodes.push(existingShard);
    } catch {
      const shardNode = await createDagNode(store, {
        id: shardId,
        workstream_id,
        phase,
        shard_key: shardKey,
        iteration,
        node_type: "task",
        status: "pending",
        metadata: {
          ...metadata,
          fanout_parent_id: parentId,
          shard_index: i,
          shard_count,
        },
      });
      shardNodes.push(shardNode);
    }
  }

  // Create edges from parent to each shard
  const edges = [];
  for (const shard of shardNodes) {
    try {
      const edge = await addDagEdge(store, parentId, shard.id, "all_completed");
      edges.push(edge);
    } catch {
      // Edge may already exist
      edges.push({ from: parentId, to: shard.id, condition: "all_completed" });
    }
  }

  return {
    parent_node: parentNode,
    shard_nodes: shardNodes,
    edges,
    idempotent: false,
  };
}
