// @ts-check
/**
 * task-join-service.mjs — Creates join/integration nodes for workstream DAGs.
 *
 * Join nodes wait for N predecessors to satisfy their join condition before
 * transitioning to "ready" for execution.
 *
 * Join condition types:
 *   - all_completed: All predecessors must complete (any terminal status)
 *   - all_passed: All predecessors must pass acceptance
 *   - any_passed: At least one predecessor must pass acceptance
 *   - manual_release: Must be explicitly released by a user
 *
 * Idempotency key: workstream_id + phase + shard_key + iteration
 */

import { createDagNode, addDagEdge, getDagNode, getPredecessors, updateDagNode, listDagNodes } from "./task-dag-service.mjs";
import { checkJoinCondition, JOIN_CONDITIONS } from "./dependency-resolver.mjs";

// ---------------------------------------------------------------------------
// Join node ID construction
// ---------------------------------------------------------------------------

/**
 * Build a join node ID.
 *
 * @param {object} identity
 * @param {string} identity.workstream_id
 * @param {string} identity.phase
 * @param {string} [identity.shard_key]
 * @param {number} [identity.iteration]
 * @returns {string}
 */
export function buildJoinNodeId(identity) {
  const parts = [
    identity.workstream_id,
    identity.phase || "default",
    identity.shard_key || "join",
    String(identity.iteration ?? 0),
  ];
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Join creation
// ---------------------------------------------------------------------------

/**
 * Create a join node that depends on predecessor nodes.
 *
 * Idempotent: if a join node already exists for the identity key, returns
 * the existing join node.
 *
 * @param {object} store - State store
 * @param {object} input
 * @param {string} input.workstream_id - Owning workstream
 * @param {string} input.phase - Execution phase
 * @param {string[]} input.predecessor_ids - Node IDs of predecessors
 * @param {string} [input.join_condition] - Join condition (default: all_completed)
 * @param {string} [input.shard_key] - Shard key for the join (default: "join")
 * @param {number} [input.iteration] - Iteration number (default: 0)
 * @param {object} [input.metadata] - Metadata
 * @returns {Promise<object>} - { join_node, edges }
 */
export async function createWorkstreamJoin(store, input = {}) {
  const {
    workstream_id,
    phase = "default",
    predecessor_ids = [],
    join_condition = JOIN_CONDITIONS.ALL_COMPLETED,
    shard_key = "join",
    iteration = 0,
    metadata = {},
  } = input;

  if (!workstream_id) throw new Error("workstream_id is required");
  if (predecessor_ids.length === 0) {
    throw new Error("predecessor_ids is required (at least one)");
  }

  const nodeId = buildJoinNodeId({
    workstream_id,
    phase,
    shard_key,
    iteration,
  });

  // Idempotency check
  try {
    const existingNode = await getDagNode(store, nodeId);
    if (existingNode) {
      const edges = predecessor_ids.map((pid) => ({
        from: pid,
        to: nodeId,
        condition: join_condition,
      }));
      return { join_node: existingNode, edges, idempotent: true };
    }
  } catch {
    // Does not exist — proceed
  }

  const nodeType = join_condition === JOIN_CONDITIONS.MANUAL_RELEASE
    ? "integration"
    : "join";

  // Create join node
  const joinNode = await createDagNode(store, {
    id: nodeId,
    workstream_id,
    phase,
    shard_key,
    iteration,
    node_type: nodeType,
    status: "waiting",
    join_condition,
    metadata: {
      predecessor_count: predecessor_ids.length,
      ...metadata,
    },
  });

  // Create edges from each predecessor to join node
  const edges = [];
  for (const pid of predecessor_ids) {
    try {
      const edge = await addDagEdge(store, pid, nodeId, join_condition);
      edges.push(edge);
    } catch {
      edges.push({ from: pid, to: nodeId, condition: join_condition });
    }
  }

  return { join_node: joinNode, edges, idempotent: false };
}

// ---------------------------------------------------------------------------
// Join evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a join node's condition is satisfied.
 *
 * @param {object} store - State store
 * @param {string} joinNodeId - ID of the join node
 * @param {function(string): object|null} [getNodeState] - Custom node state resolver
 * @param {object} [opts]
 * @param {boolean} [opts.manualReleaseTriggered]
 * @returns {Promise<object>} - { satisfied, reason, details }
 */
export async function evaluateJoinCondition(store, joinNodeId, getNodeState, opts = {}) {
  let joinNode;
  try {
    joinNode = await getDagNode(store, joinNodeId);
  } catch (err) {
    return { satisfied: false, reason: `Join node not found: ${err.message}`, details: [] };
  }

  const predecessors = await getPredecessors(store, joinNodeId);
  if (predecessors.length === 0) {
    return { satisfied: true, reason: "No predecessors", details: [] };
  }

  const condition = joinNode.join_condition || JOIN_CONDITIONS.ALL_COMPLETED;

  const defaultGetNodeState = (nodeId) => ({
    id: nodeId,
    status: null,
    terminal: null,
    acceptance_gate: null,
    passed: null,
  });

  const resolver = typeof getNodeState === "function" ? getNodeState : defaultGetNodeState;

  const result = checkJoinCondition(
    predecessors.map((p) => p.id),
    condition,
    resolver,
    { ...opts, manualReleaseTriggered: opts.manualReleaseTriggered }
  );

  return result;
}

// ---------------------------------------------------------------------------
// Manual release
// ---------------------------------------------------------------------------

/**
 * Trigger manual release for a join/integration node.
 * Once released, the node can be re-evaluated even if prior checks failed.
 *
 * @param {object} store - State store
 * @param {string} nodeId - DAG node ID
 * @returns {Promise<object>} - Updated node
 */
export async function manualReleaseJoin(store, nodeId) {
  const node = await getDagNode(store, nodeId);
  if (node.node_type !== "join" && node.node_type !== "integration") {
    throw new Error(`Node ${nodeId} is not a join/integration node`);
  }

  const meta = { ...node.metadata, manual_release_triggered: true, manual_release_at: new Date().toISOString() };
  const updated = await updateDagNode(store, nodeId, {
    metadata: meta,
    join_condition: JOIN_CONDITIONS.MANUAL_RELEASE,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Join status
// ---------------------------------------------------------------------------

/**
 * Get the join status summary for a workstream.
 *
 * @param {object} store - State store
 * @param {string} workstreamId
 * @returns {Promise<object>}
 */
export async function getJoinStatus(store, workstreamId) {
  const joinNodes = await listDagNodes(store, workstreamId, { node_type: "join" });
  const integrationNodes = await listDagNodes(store, workstreamId, { node_type: "integration" });
  const all = [...joinNodes, ...integrationNodes];

  const summary = {
    total: all.length,
    satisfied: 0,
    waiting: 0,
    by_condition: {},
  };

  for (const node of all) {
    const condition = node.join_condition || JOIN_CONDITIONS.ALL_COMPLETED;
    summary.by_condition[condition] = (summary.by_condition[condition] || 0) + 1;

    if (node.status === "completed" || node.status === "ready") {
      summary.satisfied++;
    } else {
      summary.waiting++;
    }
  }

  return summary;
}
