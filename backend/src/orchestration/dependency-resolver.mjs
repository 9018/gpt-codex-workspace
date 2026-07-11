// @ts-check
/**
 * dependency-resolver.mjs — Cycle-safe DAG dependency resolver
 * for workstream task orchestration.
 *
 * Provides:
 * 1. Cycle detection (DFS-based, returns the cycle path)
 * 2. Stable topological sort (Kahn's algorithm with deterministic tie-breaking)
 * 3. Dependency satisfaction checks per node
 *
 * Join condition types:
 *   - all_completed: All predecessor tasks have finished (any terminal status)
 *   - all_passed: All predecessor tasks have a passing/accepted result
 *   - any_passed: At least one predecessor task has a passing/accepted result
 *   - manual_release: A manual release signal is required (never auto-satisfied)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const JOIN_CONDITIONS = Object.freeze({
  ALL_COMPLETED: "all_completed",
  ALL_PASSED: "all_passed",
  ANY_PASSED: "any_passed",
  MANUAL_RELEASE: "manual_release",
});

const VALID_JOIN_CONDITIONS = new Set(Object.values(JOIN_CONDITIONS));

export function isValidJoinCondition(condition) {
  return VALID_JOIN_CONDITIONS.has(condition);
}

// ---------------------------------------------------------------------------
// Cycle Detection
// ---------------------------------------------------------------------------

/**
 * Detect a cycle in a directed graph.
 * Uses DFS with ancestor tracking.
 *
 * @param {Map<string, string[]>} adjacency - Map of node -> list of successor node ids
 * @returns {string[]|null} - The cycle path if found, or null
 */
export function detectCycle(adjacency) {
  const WHITE = 0; // unvisited
  const GRAY = 1; // in current DFS path
  const BLACK = 2; // fully explored

  const color = new Map();
  const parent = new Map();

  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  function dfs(node) {
    color.set(node, GRAY);

    const successors = adjacency.get(node) || [];
    for (const succ of successors) {
      if (!adjacency.has(succ)) continue;
      if (color.get(succ) === GRAY) {
        // Found a cycle — reconstruct path
        const path = [succ, node];
        let cur = node;
        while (cur !== succ) {
          cur = parent.get(cur);
          if (!cur) break;
          path.push(cur);
        }
        path.reverse();
        return path;
      }
      if (color.get(succ) === WHITE) {
        parent.set(succ, node);
        const found = dfs(succ);
        if (found) return found;
      }
    }

    color.set(node, BLACK);
    return null;
  }

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      const found = dfs(node);
      if (found) return found;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stable Topological Sort
// ---------------------------------------------------------------------------

/**
 * Perform a stable topological sort on a directed graph.
 * Uses Kahn's algorithm with deterministic tie-breaking.
 *
 * @param {Map<string, string[]>} adjacency - Map of node -> list of successor node ids
 * @param {string[]} allNodes - Complete list of all nodes in the graph
 * @returns {string[]} - Nodes in topological order (stable)
 * @throws {Error} - If a cycle is detected
 */
export function stableTopologicalSort(adjacency, allNodes) {
  // Build in-degree map
  const inDegree = new Map();
  for (const node of allNodes) {
    inDegree.set(node, 0);
  }

  for (const [node, successors] of adjacency.entries()) {
    for (const succ of successors) {
      if (inDegree.has(succ)) {
        inDegree.set(succ, inDegree.get(succ) + 1);
      }
    }
  }

  // Initialize queue with nodes that have no dependencies (in-degree = 0)
  const queue = allNodes
    .filter((node) => (inDegree.get(node) || 0) === 0)
    .sort();

  const result = [];

  while (queue.length > 0) {
    const node = queue.shift();
    result.push(node);

    const successors = adjacency.get(node) || [];
    for (const succ of successors) {
      const currentDeg = inDegree.get(succ);
      if (currentDeg !== undefined && currentDeg > 0) {
        inDegree.set(succ, currentDeg - 1);
        if (inDegree.get(succ) === 0) {
          const insertIndex = queue.findIndex((q) => q > succ);
          if (insertIndex === -1) {
            queue.push(succ);
          } else {
            queue.splice(insertIndex, 0, succ);
          }
        }
      }
    }
  }

  // Check if all nodes were processed (if not, there's a cycle)
  if (result.length < allNodes.length) {
    const unprocessed = allNodes.filter((n) => !result.includes(n));
    const adj = new Map();
    for (const node of allNodes) adj.set(node, adjacency.get(node) || []);
    const cycle = detectCycle(adj);
    throw new Error(
      `Cycle detected in graph. Unprocessed nodes: ${unprocessed.join(", ")}. Cycle: ${cycle ? cycle.join(" → ") : "unknown"}`
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency Satisfaction Checks
// ---------------------------------------------------------------------------

/**
 * Check if a join node's dependencies are satisfied.
 *
 * @param {string[]} predecessorIds - IDs of predecessor nodes
 * @param {string} joinCondition - Join condition type
 * @param {function(string): object|null} getNodeState - Function resolving node ID to its state object
 * @param {object} [opts]
 * @param {boolean} [opts.manualReleaseTriggered] - Whether manual release has been triggered
 * @returns {{ satisfied: boolean, reason: string, details: object[] }}
 */
export function checkJoinCondition(
  predecessorIds,
  joinCondition,
  getNodeState,
  opts = {}
) {
  if (!isValidJoinCondition(joinCondition)) {
    return { satisfied: false, reason: `Invalid join condition: ${joinCondition}`, details: [] };
  }

  if (joinCondition === JOIN_CONDITIONS.MANUAL_RELEASE) {
    const released = opts.manualReleaseTriggered === true;
    return {
      satisfied: released,
      reason: released ? "Manual release triggered" : "Waiting for manual release",
      details: [{ condition: "manual_release", released }],
    };
  }

  if (predecessorIds.length === 0) {
    return { satisfied: true, reason: "No predecessors", details: [] };
  }

  const details = [];
  let satisfied = false;

  switch (joinCondition) {
    case JOIN_CONDITIONS.ALL_COMPLETED: {
      const allCompleted = predecessorIds.every((id) => {
        const node = getNodeState(id);
        const completed = node && (node.status === "completed" || node.status === "failed" ||
          node.status === "cancelled" || node.terminal === true);
        if (!completed) details.push({ id, status: node?.status || "unknown", reason: "not terminal" });
        return completed;
      });
      satisfied = allCompleted;
      break;
    }
    case JOIN_CONDITIONS.ALL_PASSED: {
      const allPassed = predecessorIds.every((id) => {
        const node = getNodeState(id);
        const passed = node && (node.status === "completed") &&
          (node.acceptance_gate?.passed === true || node.passed === true);
        if (!passed) details.push({ id, status: node?.status || "unknown", reason: "not passed" });
        return passed;
      });
      satisfied = allPassed;
      break;
    }
    case JOIN_CONDITIONS.ANY_PASSED: {
      const anyPassed = predecessorIds.some((id) => {
        const node = getNodeState(id);
        const passed = node && (node.status === "completed") &&
          (node.acceptance_gate?.passed === true || node.passed === true);
        if (passed) details.push({ id, status: node.status, reason: "passed" });
        return passed;
      });
      satisfied = anyPassed;
      break;
    }
  }

  return {
    satisfied,
    reason: satisfied
      ? `Join condition "${joinCondition}" met (${predecessorIds.length} predecessors)`
      : `Join condition "${joinCondition}" not yet met: ${details.length} predecessor(s) not satisfied`,
    details,
  };
}

// ---------------------------------------------------------------------------
// Dependency Graph Validation
// ---------------------------------------------------------------------------

/**
 * Validate a full dependency graph for correctness.
 *
 * @param {Map<string, string[]>} adjacency - Map of node -> list of successor node ids
 * @param {string[]} allNodes - Complete list of all nodes in the graph
 * @param {object} nodeMetadata - Map of node id -> { join_condition?: string }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateDependencyGraph(adjacency, allNodes, nodeMetadata = {}) {
  const errors = [];
  const warnings = [];

  // Check for cycles
  const cycle = detectCycle(adjacency);
  if (cycle) {
    errors.push(`Cycle detected: ${cycle.join(" → ")}`);
  }

  // Check that all nodes referenced in adjacency are in allNodes
  for (const [node, successors] of adjacency.entries()) {
    if (!allNodes.includes(node)) {
      warnings.push(`Node "${node}" has edges but is not in allNodes list`);
    }
    for (const succ of successors) {
      if (!allNodes.includes(succ)) {
        errors.push(`Edge from "${node}" points to unknown node "${succ}"`);
      }
    }
  }

  // Check for valid join conditions
  for (const node of allNodes) {
    const meta = nodeMetadata[node] || {};
    if (meta.join_condition && !isValidJoinCondition(meta.join_condition)) {
      errors.push(`Node "${node}" has invalid join_condition: "${meta.join_condition}"`);
    }
  }

  // Warn about disconnected nodes
  const nodesWithEdges = new Set();
  for (const [node, successors] of adjacency.entries()) {
    nodesWithEdges.add(node);
    for (const succ of successors) {
      nodesWithEdges.add(succ);
    }
  }
  for (const node of allNodes) {
    if (!nodesWithEdges.has(node)) {
      warnings.push(`Node "${node}" is disconnected (no edges)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
