// @ts-check
/**
 * task-dag-service.mjs — Durable DAG storage and CRUD for workstream task graphs.
 *
 * DAG nodes and edges are stored in state.json under the "workstream_dag" key:
 *   workstream_dag.nodes: Map of node_id -> DAG node metadata
 *   workstream_dag.edges: Array of { from, to, condition }
 *
 * Each node carries:
 *   - id: unique node identifier (e.g., "ws_xxx:phase:shard:iteration")
 *   - workstream_id: owning workstream
 *   - phase: execution phase label
 *   - shard_key: shard identifier
 *   - iteration: numeric iteration
 *   - node_type: "task" | "fanout" | "join" | "integration"
 *   - status: "pending" | "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled"
 *   - metadata: arbitrary key-value data
 *   - join_condition: optional join condition for join nodes
 *   - created_at, updated_at: timestamps
 */

import { detectCycle, stableTopologicalSort, validateDependencyGraph } from "./dependency-resolver.mjs";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function ensureDagState(state) {
  if (!state.workstream_dag) {
    state.workstream_dag = { nodes: {}, edges: [] };
  }
  if (!state.workstream_dag.nodes) state.workstream_dag.nodes = {};
  if (!Array.isArray(state.workstream_dag.edges)) state.workstream_dag.edges = [];
  return state.workstream_dag;
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

/**
 * Create a DAG node.
 *
 * @param {object} store - State store
 * @param {object} input
 * @param {string} input.id - Unique node identifier
 * @param {string} input.workstream_id - Owning workstream ID
 * @param {string} [input.phase] - Execution phase
 * @param {string} [input.shard_key] - Shard identifier
 * @param {number} [input.iteration] - Numeric iteration
 * @param {string} [input.node_type] - "task" | "fanout" | "join" | "integration"
 * @param {string} [input.status] - Initial status
 * @param {object} [input.metadata] - Arbitrary metadata
 * @param {string} [input.join_condition] - Join condition for join nodes
 * @param {string} [input.goal_id] - Linked goal ID
 * @param {string} [input.task_id] - Linked task ID
 * @returns {Promise<object>} - Created node
 */
export async function createDagNode(store, input) {
  const ts = now();

  const node = {
    id: String(input.id),
    workstream_id: String(input.workstream_id || ""),
    phase: input.phase || null,
    shard_key: input.shard_key || null,
    iteration: typeof input.iteration === "number" ? input.iteration : 0,
    node_type: input.node_type || "task",
    status: input.status || "pending",
    metadata: input.metadata ? { ...input.metadata } : {},
    join_condition: input.join_condition || null,
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    created_at: ts,
    updated_at: ts,
  };

  return store.mutate((state) => {
    const dag = ensureDagState(state);
    if (dag.nodes[node.id]) {
      throw new Error(`DAG node already exists: ${node.id}`);
    }
    dag.nodes[node.id] = node;
    state.activities ||= [];
    state.activities.push({
      time: ts,
      type: "workstream_dag.node_created",
      node_id: node.id,
      workstream_id: node.workstream_id,
    });
    return { ...node };
  });
}

/**
 * Get a DAG node by id.
 */
export async function getDagNode(store, nodeId) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const node = dag.nodes[nodeId];
    if (!node) throw new Error(`DAG node not found: ${nodeId}`);
    return { ...node };
  });
}

/**
 * Update a DAG node's mutable fields.
 */
export async function updateDagNode(store, nodeId, patch) {
  const ts = now();
  const mutableFields = new Set([
    "status", "phase", "shard_key", "iteration", "node_type",
    "metadata", "join_condition", "goal_id", "task_id",
  ]);

  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const node = dag.nodes[nodeId];
    if (!node) throw new Error(`DAG node not found: ${nodeId}`);

    for (const [key, value] of Object.entries(patch)) {
      if (mutableFields.has(key)) {
        node[key] = value;
      }
    }
    node.updated_at = ts;
    state.activities ||= [];
    state.activities.push({
      time: ts,
      type: "workstream_dag.node_updated",
      node_id: nodeId,
      patch: Object.keys(patch).filter((k) => mutableFields.has(k)).join(","),
    });
    return { ...node };
  });
}

/**
 * List DAG nodes for a workstream, optionally filtered by phase or status.
 */
export async function listDagNodes(store, workstreamId, filters = {}) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    let nodes = Object.values(dag.nodes).filter((n) => n.workstream_id === workstreamId);

    if (filters.phase) nodes = nodes.filter((n) => n.phase === filters.phase);
    if (filters.status) nodes = nodes.filter((n) => n.status === filters.status);
    if (filters.node_type) nodes = nodes.filter((n) => n.node_type === filters.node_type);

    return nodes.sort((a, b) => String(a.id).localeCompare(b.id));
  });
}

// ---------------------------------------------------------------------------
// Edge CRUD
// ---------------------------------------------------------------------------

/**
 * Add a directed edge between two DAG nodes.
 * Automatically checks for cycles.
 *
 * @param {object} store - State store
 * @param {string} from - Source node ID
 * @param {string} to - Target node ID
 * @param {string} [condition] - Edge condition (default: all_completed)
 * @returns {Promise<object>} - The created edge
 */
export async function addDagEdge(store, from, to, condition = "all_completed") {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    if (!dag.nodes[from]) throw new Error(`Source node not found: ${from}`);
    if (!dag.nodes[to]) throw new Error(`Target node not found: ${to}`);

    // Check for duplicate edge
    const duplicate = dag.edges.find((e) => e.from === from && e.to === to);
    if (duplicate) {
      return { ...duplicate };
    }

    // Temporarily add edge and check for cycles
    const testEdges = [...dag.edges, { from, to, condition: condition || "all_completed" }];
    const adjacency = buildAdjacency(dag.nodes, testEdges);
    const cycle = detectCycle(adjacency);
    if (cycle) {
      throw new Error(`Adding edge ${from} → ${to} would create a cycle: ${cycle.join(" → ")}`);
    }

    const edge = {
      from,
      to,
      condition: condition || "all_completed",
      created_at: now(),
    };
    dag.edges.push(edge);

    state.activities ||= [];
    state.activities.push({
      time: edge.created_at,
      type: "workstream_dag.edge_added",
      from,
      to,
      condition: edge.condition,
    });

    return { ...edge };
  });
}

/**
 * Remove a directed edge.
 */
export async function removeDagEdge(store, from, to) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const index = dag.edges.findIndex((e) => e.from === from && e.to === to);
    if (index === -1) throw new Error(`Edge not found: ${from} → ${to}`);
    const removed = dag.edges.splice(index, 1)[0];

    state.activities ||= [];
    state.activities.push({
      time: now(),
      type: "workstream_dag.edge_removed",
      from,
      to,
    });

    return { ...removed };
  });
}

// ---------------------------------------------------------------------------
// Graph Queries
// ---------------------------------------------------------------------------

/**
 * Build an adjacency map from DAG nodes and edges.
 *
 * @param {object} nodes - Map of node id -> node object
 * @param {Array} edges - Array of { from, to }
 * @returns {Map<string, string[]>}
 */
export function buildAdjacency(nodes, edges) {
  const adjacency = new Map();
  for (const nodeId of Object.keys(nodes)) {
    adjacency.set(nodeId, []);
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  return adjacency;
}

/**
 * Get the full execution graph for a workstream.
 * Returns nodes, edges, topological order, and cycle info.
 *
 * @param {object} store - State store
 * @param {string} workstreamId
 * @returns {Promise<object>}
 */
export async function getExecutionGraph(store, workstreamId) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const nodes = Object.values(dag.nodes).filter((n) => n.workstream_id === workstreamId);
    const nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;

    const edges = dag.edges.filter(
      (e) => nodeMap[e.from] && nodeMap[e.to]
    );

    const adjacency = buildAdjacency(nodeMap, edges);
    const allNodeIds = Object.keys(nodeMap);
    const validation = validateDependencyGraph(adjacency, allNodeIds, nodeMap);

    let topologicalOrder = [];
    if (validation.valid) {
      topologicalOrder = stableTopologicalSort(adjacency, allNodeIds);
    }

    return {
      workstream_id: workstreamId,
      nodes: nodes.map((n) => ({ ...n })),
      edges: edges.map((e) => ({ ...e })),
      topological_order: topologicalOrder,
      node_count: nodes.length,
      edge_count: edges.length,
      validation,
    };
  });
}

/**
 * Get predecessor node IDs for a given node.
 */
export async function getPredecessors(store, nodeId) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const predecessors = dag.edges
      .filter((e) => e.to === nodeId)
      .map((e) => ({ id: e.from, condition: e.condition }));
    return predecessors;
  });
}

/**
 * Get successor node IDs for a given node.
 */
export async function getSuccessors(store, nodeId) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const successors = dag.edges
      .filter((e) => e.from === nodeId)
      .map((e) => ({ id: e.to, condition: e.condition }));
    return successors;
  });
}

/**
 * Get nodes that are ready to execute (all dependencies satisfied).
 *
 * @param {object} store - State store
 * @param {string} workstreamId
 * @returns {Promise<string[]>} - Array of node IDs ready for execution
 */
export async function getReadyNodes(store, workstreamId) {
  return store.mutate((state) => {
    const dag = ensureDagState(state);
    const nodes = Object.values(dag.nodes).filter((n) => n.workstream_id === workstreamId);
    const nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;

    const edges = dag.edges.filter(
      (e) => nodeMap[e.from] && nodeMap[e.to]
    );

    const ready = [];

    for (const node of nodes) {
      if (node.status !== "pending" && node.status !== "waiting") continue;

      // Find incoming edges (dependencies)
      const incomingEdges = edges.filter((e) => e.to === node.id);

      if (incomingEdges.length === 0) {
        // No dependencies — ready if pending
        if (node.status === "pending") {
          ready.push(node.id);
        }
        continue;
      }

      // For join nodes, check join condition
      if (node.node_type === "join" || node.node_type === "integration") {
        const allPredecessorsTerminal = incomingEdges.every((e) => {
          const pred = nodeMap[e.from];
          if (!pred) return false;
          return pred.status === "completed" || pred.status === "failed" ||
                 pred.status === "cancelled" || pred.terminal === true;
        });
        if (allPredecessorsTerminal && node.status === "waiting") {
          ready.push(node.id);
        }
        continue;
      }

      // For regular task nodes: all predecessors must be completed
      const allDone = incomingEdges.every((e) => {
        const pred = nodeMap[e.from];
        if (!pred) return false;
        return pred.status === "completed";
      });

      if (allDone && (node.status === "pending" || node.status === "waiting")) {
        ready.push(node.id);
      }
    }

    return ready.sort();
  });
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

/**
 * Create a batch of DAG nodes and edges atomically.
 */
export async function createDagBatch(store, workstreamId, { nodes, edges }) {
  const ts = now();
  return store.mutate((state) => {
    const dag = ensureDagState(state);

    const createdNodes = [];
    for (const nodeInput of nodes) {
      const nodeId = String(nodeInput.id);
      if (dag.nodes[nodeId]) {
        throw new Error(`DAG node already exists in batch: ${nodeId}`);
      }
      const node = {
        id: nodeId,
        workstream_id: workstreamId,
        phase: nodeInput.phase || null,
        shard_key: nodeInput.shard_key || null,
        iteration: typeof nodeInput.iteration === "number" ? nodeInput.iteration : 0,
        node_type: nodeInput.node_type || "task",
        status: nodeInput.status || "pending",
        metadata: nodeInput.metadata ? { ...nodeInput.metadata } : {},
        join_condition: nodeInput.join_condition || null,
        goal_id: nodeInput.goal_id || null,
        task_id: nodeInput.task_id || null,
        created_at: ts,
        updated_at: ts,
      };
      dag.nodes[nodeId] = node;
      createdNodes.push(node);
    }

    const createdEdges = [];
    for (const edgeInput of edges) {
      if (!dag.nodes[edgeInput.from]) {
        throw new Error(`Batch edge source not found: ${edgeInput.from}`);
      }
      if (!dag.nodes[edgeInput.to]) {
        throw new Error(`Batch edge target not found: ${edgeInput.to}`);
      }
      const duplicate = dag.edges.find(
        (e) => e.from === edgeInput.from && e.to === edgeInput.to
      );
      if (duplicate) continue;

      const edge = {
        from: edgeInput.from,
        to: edgeInput.to,
        condition: edgeInput.condition || "all_completed",
        created_at: ts,
      };
      dag.edges.push(edge);
      createdEdges.push(edge);
    }

    // Validate the full graph after batch creation
    const adjacency = buildAdjacency(dag.nodes, dag.edges);
    const allNodeIds = Object.keys(dag.nodes);
    const validation = validateDependencyGraph(adjacency, allNodeIds, dag.nodes);
    if (!validation.valid) {
      // Rollback by removing created nodes and edges
      for (const n of createdNodes) delete dag.nodes[n.id];
      for (const e of createdEdges) {
        const idx = dag.edges.findIndex((de) => de.from === e.from && de.to === e.to);
        if (idx >= 0) dag.edges.splice(idx, 1);
      }
      throw new Error(`Batch validation failed: ${validation.errors.join("; ")}`);
    }

    state.activities ||= [];
    state.activities.push({
      time: ts,
      type: "workstream_dag.batch_created",
      workstream_id: workstreamId,
      node_count: createdNodes.length,
      edge_count: createdEdges.length,
    });

    return { nodes: createdNodes.map((n) => ({ ...n })), edges: createdEdges.map((e) => ({ ...e })) };
  });
}
