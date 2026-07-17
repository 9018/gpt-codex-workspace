import test from "node:test";
import assert from "node:assert/strict";

import { compilePlan } from "../../src/execution-core/execution-plan-compiler.mjs";
import { normalizeExecutionIntent } from "../../src/execution-core/execution-intent-schema.mjs";

test("compilePlan requires intent", () => {
  assert.throws(() => compilePlan(), /intent is required/);
});

test("compilePlan creates single-node plan for simple intent", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Fix login bug",
    operation_kind: "code_change",
  });

  const plan = compilePlan(intent);
  assert.equal(plan.intent_id, intent.id);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].operation_kind, "code_change");
  assert.equal(plan.nodes[0].role, "default");
});

test("compilePlan creates single-node for non-code operations", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Run tests",
    operation_kind: "test_only",
  });

  const plan = compilePlan(intent);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].operation_kind, "test_only");
});

test("compilePlan creates multi-agent DAG when requested", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Implement complex feature",
    operation_kind: "code_change",
  });

  const plan = compilePlan(intent, { multiAgent: true });

  // Should have architect -> builder -> tester -> reviewer -> integrator
  assert.ok(plan.nodes.length >= 5, `Expected at least 5 nodes, got ${plan.nodes.length}`);

  const roles = plan.nodes.map((n) => n.role);
  assert.ok(roles.includes("architect"));
  assert.ok(roles.includes("builder"));
  assert.ok(roles.includes("tester"));
  assert.ok(roles.includes("reviewer"));
  assert.ok(roles.includes("integrator"));
});

test("multi-agent DAG has correct dependency chains", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Build feature",
    operation_kind: "code_change",
  });

  const plan = compilePlan(intent, { multiAgent: true });

  // Builder depends on architect
  const builder = plan.nodes.find((n) => n.role === "builder");
  const architect = plan.nodes.find((n) => n.role === "architect");
  assert.ok(builder.depends_on.includes(architect.id), "Builder should depend on architect");

  // Tester depends on builder
  const tester = plan.nodes.find((n) => n.role === "tester");
  assert.ok(tester.depends_on.includes(builder.id), "Tester should depend on builder");

  // Integrator depends on tester + reviewer
  const integrator = plan.nodes.find((n) => n.role === "integrator");
  const reviewer = plan.nodes.find((n) => n.role === "reviewer");
  assert.ok(integrator.depends_on.includes(tester.id), "Integrator should depend on tester");
  assert.ok(integrator.depends_on.includes(reviewer.id), "Integrator should depend on reviewer");
});

test("single-node plan does not need multiAgent flag", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Test something",
    operation_kind: "test_only",
  });

  const plan = compilePlan(intent);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].role, "default");
});
