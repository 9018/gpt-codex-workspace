import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorPlanStore } from "../../src/supervisor/supervisor-plan-store.mjs";
import { SupervisorPlanNotFoundError } from "../../src/supervisor/supervisor-errors.mjs";

test("createPlan creates and readPlan retrieves", async () => {
  const store = createSupervisorPlanStore();
  const plan = await store.createPlan({ run_id: "run_001", user_goal: "Fix bug" });
  assert.ok(plan.id.startsWith("sp_"));
  assert.equal(plan.run_id, "run_001");

  const read = await store.readPlan(plan.id);
  assert.deepEqual(read, plan);
});

test("readPlan throws for nonexistent plan", async () => {
  const store = createSupervisorPlanStore();
  await assert.rejects(() => store.readPlan("nonexistent"), SupervisorPlanNotFoundError);
});

test("findPlanByRunId returns null for unknown run", async () => {
  const store = createSupervisorPlanStore();
  const result = await store.findPlanByRunId("run_unknown");
  assert.equal(result, null);
});

test("findPlanByRunId finds plan created for a run", async () => {
  const store = createSupervisorPlanStore();
  await store.createPlan({ run_id: "run_002" });
  const found = await store.findPlanByRunId("run_002");
  assert.notEqual(found, null);
  assert.equal(found.run_id, "run_002");
});

test("count returns correct number", async () => {
  const store = createSupervisorPlanStore();
  assert.equal(store.count(), 0);
  await store.createPlan({ run_id: "r1" });
  assert.equal(store.count(), 1);
  await store.createPlan({ run_id: "r2" });
  assert.equal(store.count(), 2);
});
