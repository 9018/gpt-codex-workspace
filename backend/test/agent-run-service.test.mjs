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

test("agent-run-service: rejects analyst instead of silently downgrading", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  await assert.rejects(
    () => createAgentRun(store, { role: "analyst", goal_id: "g1", task_id: "t1" }, {}),
    /unsupported agent role/i,
  );
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

test("agent-run-service: rejects unknown role instead of falling back to implementer", async () => {
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  await assert.rejects(
    () => createAgentRun(store, { role: "unknown_role_xyz", goal_id: "g1", task_id: "t1" }, {}),
    /unsupported agent role/i,
  );
});

// ===========================================================================
// Tests: runAgentPipeline with delivery roles
// ===========================================================================

test("agent-run-service: runAgentPipeline with repairer role creates agent_run correctly", async () => {
  const { runAgentPipeline } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await runAgentPipeline(store, {
    goal_id: "goal_pipeline_1",
    task_id: "task_pipeline_1",
    roles: ["planner", "repairer", "escalation_judge"],
  }, {});

  assert.equal(result.count, 3);
  assert.equal(result.agent_runs[0].role, "planner", "First pipeline role should be planner");
  assert.equal(result.agent_runs[1].role, "repairer", "Second pipeline role should be repairer");
  assert.equal(result.agent_runs[2].role, "escalation_judge", "Third pipeline role should be escalation_judge");
});

console.log("agent-run-service tests loaded");
