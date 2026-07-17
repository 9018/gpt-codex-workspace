import test from "node:test";
import assert from "node:assert/strict";

import { createProjectionService, mapRunStateToTaskState } from "../../src/execution-core/execution-projection-service.mjs";

// ---------------------------------------------------------------------------
// mapRunStateToTaskState (pure function)
// ---------------------------------------------------------------------------

test("mapRunStateToTaskState maps all run states correctly", () => {
  const { EXECUTION_RUN_STATES } = { EXECUTION_RUN_STATES: [
    "created", "planning", "ready", "running", "collecting",
    "evaluating", "waiting_for_repair", "waiting_for_review",
    "waiting_for_integration", "completed", "failed", "cancelled",
  ]};

  const expected = {
    "created": "starting",
    "planning": "starting",
    "ready": "starting",
    "running": "running",
    "collecting": "collecting",
    "evaluating": "collecting",
    "waiting_for_repair": "waiting_for_repair",
    "waiting_for_review": "waiting_for_review",
    "waiting_for_integration": "waiting_for_integration",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
  };

  for (const state of EXECUTION_RUN_STATES) {
    const projected = mapRunStateToTaskState({ state });
    assert.equal(projected, expected[state],
      `Run state "${state}" should project to "${expected[state]}", got "${projected}"`);
  }
});

test("mapRunStateToTaskState returns null for null/undefined", () => {
  assert.equal(mapRunStateToTaskState(null), null);
  assert.equal(mapRunStateToTaskState(), null);
});

test("mapRunStateToTaskState returns null for unknown state", () => {
  assert.equal(mapRunStateToTaskState({ state: "unknown_state" }), null);
});

// ---------------------------------------------------------------------------
// createProjectionService
// ---------------------------------------------------------------------------

test("project does nothing when no deps provided", async () => {
  const service = createProjectionService();
  const run = { id: "run_001", state: "running", version: 1 };
  const result = await service.project(run);
  assert.deepEqual(result, {
    task_projected: false,
    goal_projected: false,
    workstream_projected: false,
  });
});

test("project calls taskTransitionService when task_id present", async () => {
  let called = false;
  const service = createProjectionService({
    taskTransitionService: {
      async projectState({ task_id, execution_run_id, target_status, idempotency_key }) {
        called = true;
        assert.equal(task_id, "task_001");
        assert.equal(execution_run_id, "run_001");
        assert.equal(target_status, "running");
        assert.ok(idempotency_key.includes("run:run_001:version:1"));
      },
    },
  });

  const run = { id: "run_001", task_id: "task_001", state: "running", version: 1 };
  const result = await service.project(run);

  assert.equal(called, true);
  assert.equal(result.task_projected, true);
});

test("project calls goalLifecycleService when goal_id present", async () => {
  let called = false;
  const service = createProjectionService({
    goalLifecycleService: {
      async projectExecutionRun(run) {
        called = true;
        assert.equal(run.goal_id, "goal_001");
      },
    },
  });

  const run = { id: "run_001", goal_id: "goal_001", task_id: "task_001", state: "running", version: 1 };
  const result = await service.project(run);

  assert.equal(called, true);
  assert.equal(result.goal_projected, true);
});

test("project calls workstreamService when workstream_id present", async () => {
  let called = false;
  const service = createProjectionService({
    workstreamService: {
      async projectExecutionRun(run) {
        called = true;
        assert.equal(run.workstream_id, "ws_001");
      },
    },
  });

  const run = { id: "run_001", workstream_id: "ws_001", state: "running", version: 1 };
  const result = await service.project(run);

  assert.equal(called, true);
  assert.equal(result.workstream_projected, true);
});
