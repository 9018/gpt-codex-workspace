import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionPlan, createPlanNode, sortNodesTopologically, getRunnableNodes, PLAN_NODE_ROLES } from "../../src/execution-core/execution-plan-schema.mjs";

test("createExecutionPlan requires intent_id", () => {
  assert.throws(() => createExecutionPlan({}), /intent_id is required/);
});

test("createExecutionPlan creates plan with defaults", () => {
  const plan = createExecutionPlan({ intent_id: "intent_001" });
  assert.ok(plan.id.startsWith("plan_"));
  assert.equal(plan.intent_id, "intent_001");
  assert.deepEqual(plan.nodes, []);
});

test("createPlanNode requires operation_kind", () => {
  assert.throws(() => createPlanNode({}), /operation_kind is required/);
});

test("createPlanNode validates roles", () => {
  assert.throws(() => createPlanNode({ operation_kind: "code_change", role: "invalid" }), /Invalid role/);
  assert.doesNotThrow(() => createPlanNode({ operation_kind: "code_change", role: "architect" }));
});

test("createPlanNode creates node with defaults", () => {
  const node = createPlanNode({ operation_kind: "code_change" });
  assert.ok(node.id.startsWith("node_"));
  assert.equal(node.operation_kind, "code_change");
  assert.equal(node.role, "default");
  assert.equal(node.mutation_scope, "none");
  assert.equal(node.status, "pending");
  assert.equal(node.run_id, null);
  assert.deepEqual(node.depends_on, []);
});

// ---------------------------------------------------------------------------
// sortNodesTopologically
// ---------------------------------------------------------------------------

test("sorts simple dependency chain", () => {
  const a = createPlanNode({ id: "a", operation_kind: "planning" });
  const b = createPlanNode({ id: "b", operation_kind: "code_change", depends_on: ["a"] });
  const c = createPlanNode({ id: "c", operation_kind: "test_only", depends_on: ["b"] });

  const sorted = sortNodesTopologically([c, a, b]);
  assert.equal(sorted[0].id, "a");
  assert.equal(sorted[1].id, "b");
  assert.equal(sorted[2].id, "c");
});

test("throws on circular dependency", () => {
  const a = createPlanNode({ id: "a", operation_kind: "planning", depends_on: ["c"] });
  const b = createPlanNode({ id: "b", operation_kind: "code_change", depends_on: ["a"] });
  const c = createPlanNode({ id: "c", operation_kind: "test_only", depends_on: ["b"] });

  assert.throws(() => sortNodesTopologically([a, b, c]), /Circular dependency/);
});

// ---------------------------------------------------------------------------
// getRunnableNodes
// ---------------------------------------------------------------------------

test("getRunnableNodes returns nodes with dependencies satisfied", () => {
  const a = createPlanNode({ id: "a", operation_kind: "planning" });
  const b = createPlanNode({ id: "b", operation_kind: "code_change", depends_on: ["a"] });

  // Initially only 'a' is runnable
  let runnable = getRunnableNodes([a, b]);
  assert.equal(runnable.length, 1);
  assert.equal(runnable[0].id, "a");

  // After 'a' completes, 'b' becomes runnable
  a.status = "completed";
  runnable = getRunnableNodes([a, b]);
  assert.equal(runnable.length, 1);
  assert.equal(runnable[0].id, "b");
});

// ---------------------------------------------------------------------------
// Plan with nodes
// ---------------------------------------------------------------------------

test("createExecutionPlan with nodes", () => {
  const nodes = [
    createPlanNode({ operation_kind: "code_change", role: "builder" }),
    createPlanNode({ operation_kind: "test_only", role: "tester", depends_on: ["node_0"] }),
  ];
  // Force IDs for the test
  nodes[0].id = "node_0";
  nodes[1].id = "node_1";
  nodes[1].depends_on = ["node_0"];

  const plan = createExecutionPlan({ intent_id: "intent_001", nodes });
  assert.equal(plan.nodes.length, 2);
});
