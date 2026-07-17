/**
 * execution-plan-compiler.mjs — Compiles an ExecutionIntent into an ExecutionPlan.
 *
 * For simple intents (single operation_kind), this produces a single-node plan.
 * For complex intents that need multi-agent DAG, the compiler creates
 * architect → builder → tester → reviewer → integrator nodes.
 *
 * @module execution-plan-compiler
 */

import { createExecutionPlan, createPlanNode } from "./execution-plan-schema.mjs";

/**
 * Compile an ExecutionIntent into an ExecutionPlan.
 *
 * @param {object} intent - Normalized ExecutionIntent
 * @param {object} [options]
 * @param {boolean} [options.multiAgent=false] - Whether to generate multi-agent DAG
 * @returns {object} ExecutionPlan
 */
export function compilePlan(intent, options = {}) {
  if (!intent) throw new Error("intent is required");
  if (!intent.id) throw new Error("intent.id is required");

  // Check whether this intent needs a multi-agent DAG
  const needsMultiAgent = options.multiAgent === true &&
    intent.operation_kind === "code_change" &&
    intent.execution_policy?.interaction_mode !== "interactive";

  if (needsMultiAgent) {
    return compileMultiAgentPlan(intent);
  }

  // Single-node plan for simple operations
  return createExecutionPlan({
    intent_id: intent.id,
    goal_id: intent.goal_id,
    workstream_id: intent.workstream_id,
    nodes: [
      createPlanNode({
        operation_kind: intent.operation_kind,
        role: "default",
        mutation_scope: intent.mutation_scope,
        acceptance_profile: intent.acceptance_profile || intent.operation_kind,
        expected_evidence: intent.expected_outputs || [],
      }),
    ],
  });
}

/**
 * Compile a multi-agent DAG plan for complex code changes.
 * Produces: architect → builder → tester → reviewer → integrator
 *
 * @param {object} intent
 * @returns {object} ExecutionPlan
 */
function compileMultiAgentPlan(intent) {
  const nodes = [];

  // 1. Architect — produces design artifact
  const architect = createPlanNode({
    id: `${intent.id}:architect`,
    operation_kind: "planning",
    role: "architect",
    mutation_scope: "none",
    acceptance_profile: "planning",
    expected_evidence: ["design_artifact", "file_list"],
  });
  nodes.push(architect);

  // 2. Builder — implements based on architect's output
  const builder = createPlanNode({
    id: `${intent.id}:builder`,
    operation_kind: "code_change",
    role: "builder",
    mutation_scope: "repo",
    acceptance_profile: "code_change",
    depends_on: [architect.id],
    expected_evidence: ["changed_files", "commit_sha", "commands"],
  });
  nodes.push(builder);

  // 3. Tester — runs tests on builder's changes
  const tester = createPlanNode({
    id: `${intent.id}:tester`,
    operation_kind: "test_only",
    role: "tester",
    mutation_scope: "none",
    acceptance_profile: "test_only",
    depends_on: [builder.id],
    expected_evidence: ["test_results", "commands"],
  });
  nodes.push(tester);

  // 4. Reviewer — reviews builder's code (read-only)
  const reviewer = createPlanNode({
    id: `${intent.id}:reviewer`,
    operation_kind: "code_review",
    role: "reviewer",
    mutation_scope: "none",
    acceptance_profile: "code_review",
    depends_on: [builder.id],
    expected_evidence: ["review_findings", "review_scope"],
  });
  nodes.push(reviewer);

  // 5. Integrator — merges if all prior steps pass
  const integrator = createPlanNode({
    id: `${intent.id}:integrator`,
    operation_kind: "code_change",
    role: "integrator",
    mutation_scope: "repo",
    acceptance_profile: "code_change",
    depends_on: [tester.id, reviewer.id],
    expected_evidence: ["integration_sha", "commands"],
  });
  nodes.push(integrator);

  return createExecutionPlan({
    id: `${intent.id}:plan`,
    intent_id: intent.id,
    goal_id: intent.goal_id,
    workstream_id: intent.workstream_id,
    nodes,
  });
}

/**
 * Load a previously compiled plan (in-memory lookup).
 * For now, returns null if no matching plan is found in a registry.
 *
 * @param {string} planId
 * @param {object} [planRegistry] - Optional map of planId -> plan
 * @returns {object|null}
 */
export function loadPlan(planId, planRegistry = {}) {
  if (planRegistry[planId]) return planRegistry[planId];
  return null;
}
