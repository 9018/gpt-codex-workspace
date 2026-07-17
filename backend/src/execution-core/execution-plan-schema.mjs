/**
 * execution-plan-schema.mjs — ExecutionPlan schema.
 *
 * An ExecutionPlan decomposes an ExecutionIntent into ordered (or DAG)
 * steps.  Each step is a PlanNode that maps to one or more provider
 * attempts.  The plan drives what ExecutionRunService's advanceRun does.
 *
 * @module execution-plan-schema
 */

import { randomUUID } from "node:crypto";

/** Node roles for multi-agent DAG scenarios. */
export const PLAN_NODE_ROLES = Object.freeze([
  "architect",
  "builder",
  "tester",
  "reviewer",
  "integrator",
  "default",
]);

/**
 * Create an execution plan.
 *
 * @param {object} input
 * @param {string} [input.id]
 * @param {string} input.intent_id
 * @param {string} [input.goal_id]
 * @param {string} [input.workstream_id]
 * @param {Array} [input.nodes=[]]
 * @returns {object} ExecutionPlan
 */
export function createExecutionPlan(input = {}) {
  if (!input.intent_id) {
    throw new Error("intent_id is required");
  }

  return {
    id: input.id || `plan_${randomUUID()}`,
    intent_id: input.intent_id,
    goal_id: input.goal_id || null,
    workstream_id: input.workstream_id || null,
    nodes: Array.isArray(input.nodes) ? input.nodes.map(createPlanNode) : [],
    created_at: input.created_at || new Date().toISOString(),
  };
}

/**
 * Create a plan node.
 *
 * @param {object} input
 * @param {string} [input.id]
 * @param {string} input.operation_kind
 * @param {string} [input.role="default"]
 * @param {string} [input.mutation_scope="none"]
 * @param {string} [input.acceptance_profile]
 * @param {string[]} [input.depends_on=[]]
 * @returns {object} PlanNode
 */
export function createPlanNode(input = {}) {
  if (!input.operation_kind) {
    throw new Error("operation_kind is required for a plan node");
  }

  const role = input.role || "default";
  if (!PLAN_NODE_ROLES.includes(role)) {
    throw new Error(`Invalid role "${role}". Must be one of: ${PLAN_NODE_ROLES.join(", ")}`);
  }

  return {
    id: input.id || `node_${randomUUID()}`,
    operation_kind: input.operation_kind,
    role,
    mutation_scope: input.mutation_scope || "none",
    acceptance_profile: input.acceptance_profile || input.operation_kind,
    depends_on: Array.isArray(input.depends_on) ? [...input.depends_on] : [],
    run_id: null, // Set when the node is dispatched to a run
    expected_evidence: Array.isArray(input.expected_evidence) ? [...input.expected_evidence] : [],
    concurrency_group: input.concurrency_group || null,
    status: "pending", // pending, running, completed, failed
    created_at: input.created_at || new Date().toISOString(),
  };
}

/**
 * Topological sort of plan nodes based on depends_on.
 *
 * @param {object[]} nodes
 * @returns {object[]} Nodes in execution order
 */
export function sortNodesTopologically(nodes) {
  const visited = new Set();
  const result = [];

  function visit(nodeId, ancestors) {
    if (ancestors.has(nodeId)) {
      throw new Error(`Circular dependency detected involving node "${nodeId}"`);
    }
    if (visited.has(nodeId)) return;

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    ancestors.add(nodeId);
    for (const depId of node.depends_on) {
      visit(depId, ancestors);
    }
    ancestors.delete(nodeId);

    visited.add(nodeId);
    result.push(node);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      visit(node.id, new Set());
    }
  }

  return result;
}

/**
 * Find nodes that are ready to execute (all dependencies completed).
 *
 * @param {object[]} nodes
 * @returns {object[]} Runnable nodes
 */
export function getRunnableNodes(nodes) {
  const completedIds = new Set(
    nodes.filter((n) => n.status === "completed").map((n) => n.id)
  );

  return nodes.filter(
    (n) =>
      n.status === "pending" &&
      n.depends_on.every((depId) => completedIds.has(depId))
  );
}
