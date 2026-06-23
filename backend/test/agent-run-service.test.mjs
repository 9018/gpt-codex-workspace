import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "agent-run-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();
  return store;
}

// ===========================================================================
// Tests: normalizeRole in agent-run-service.mjs
// ===========================================================================

test("agent-run-service: normalizeRole preserves analyst as analyst", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  // analyst is now a recognized role, not downgraded to implementer
  const result = await createAgentRun(store, { role: "analyst", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "analyst", "analyst role should be preserved, not downgraded to implementer");
});

test("agent-run-service: normalizeRole preserves escalation_judge", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createAgentRun(store, { role: "escalation_judge", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "escalation_judge", "escalation_judge should be a recognized role");
});

test("agent-run-service: normalizeRole preserves planner (backward compat)", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createAgentRun(store, { role: "planner", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "planner", "planner role should be preserved");
});

test("agent-run-service: normalizeRole preserves finalizer (backward compat)", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createAgentRun(store, { role: "finalizer", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "finalizer", "finalizer role should be preserved");
});

test("agent-run-service: normalizeRole preserves architect", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createAgentRun(store, { role: "architect", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "architect", "architect role should be preserved");
});

test("agent-run-service: normalizeRole falls back to implementer for unknown role", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createAgentRun(store, { role: "unknown_role_xyz", goal_id: "g1", task_id: "t1" }, {});
  assert.equal(result.agent_run.role, "implementer", "unknown role should fall back to implementer");
});

// ===========================================================================
// Tests: runAgentPipeline with analyst/escalation_judge roles
// ===========================================================================

test("agent-run-service: runAgentPipeline with analyst role creates agent_run correctly", async () => {
  const { createAgentRun, runAgentPipeline } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await runAgentPipeline(store, {
    goal_id: "goal_pipeline_1",
    task_id: "task_pipeline_1",
    roles: ["analyst", "architect", "implementer"],
  }, {});

  assert.equal(result.count, 3);
  assert.equal(result.agent_runs[0].role, "analyst", "First pipeline role should be analyst");
  assert.equal(result.agent_runs[1].role, "architect", "Second pipeline role should be architect");
  assert.equal(result.agent_runs[2].role, "implementer", "Third pipeline role should be implementer");
});

console.log("agent-run-service tests loaded");
