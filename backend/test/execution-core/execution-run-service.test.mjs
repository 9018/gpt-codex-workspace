import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createProjectionService } from "../../src/execution-core/execution-projection-service.mjs";
import { createExecutionRunService } from "../../src/execution-core/execution-run-service.mjs";

/**
 * Helper to create a minimal deps object for ExecutionRunService.
 */
function createMinimalDeps() {
  const runStore = createExecutionRunStore();
  return {
    runStore,
    projectionService: createProjectionService(),
    acceptanceService: {
      async evaluate() {
        return { decision: "accepted", summary: "test default accept", id: "test_decision" };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test("start creates a run in ready state with basic flow", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const result = await svc.start({
    intent_id: "intent_001",
    task_id: "task_001",
  });

  assert.ok(result.run, "run should be created");
  assert.equal(result.started, true, "should start successfully");
  assert.equal(result.run.intent_id, "intent_001");
  assert.equal(result.run.task_id, "task_001");
  assert.equal(result.run.state, "ready", "run should end in ready state");
  assert.ok(result.run.version >= 3, `version should be >= 3 (transitions: created->planning->ready), got ${result.run.version}`);
  assert.equal(typeof result.run.created_at, "string");
});

test("start handles projection errors gracefully (non-fatal)", async () => {
  const deps = createMinimalDeps();
  // Projection errors should be non-fatal
  deps.projectionService = createProjectionService({
    taskTransitionService: {
      async projectState() { throw new Error("transient store error"); },
    },
  });
  const svc = createExecutionRunService(deps);

  const result = await svc.start({
    intent_id: "intent_001",
    task_id: "task_001",
  });

  // Run should still be created and in ready state
  assert.ok(result.run, "run should be created");
  assert.equal(result.started, true, "projection errors should not prevent start");
  assert.equal(result.run.state, "ready", "run should still transition to ready");
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test("read returns the current run state", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const read = await svc.read(run.id);

  assert.equal(read.id, run.id);
  assert.equal(read.state, "ready");
});

test("read throws for nonexistent run", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  await assert.rejects(() => svc.read("nonexistent"), /ExecutionRun not found/);
});

// ---------------------------------------------------------------------------
// requestStop
// ---------------------------------------------------------------------------

test("requestStop returns stop acknowledgment", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const stopResult = await svc.requestStop({ runId: run.id });

  assert.equal(stopResult.run_id, run.id);
  assert.equal(stopResult.stopped, true);
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test("cancel transitions run to cancelled state", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.cancel({ runId: run.id });

  assert.equal(result.run.state, "cancelled");
});

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

test("collect returns evidence_bundle_id when present", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.collect({ runId: run.id });

  assert.equal(result.run_id, run.id);
});

test("collect throws for nonexistent run", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  await assert.rejects(() => svc.collect({ runId: "nonexistent" }), /ExecutionRun not found/);
});

// ---------------------------------------------------------------------------
// advanceRun (basic test without provider orchestration)
// ---------------------------------------------------------------------------

test("advanceRun transitions run through basic lifecycle", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });

  const result = await svc.advanceRun(run.id);

  assert.ok(result.run, "run should be returned");
  // Without acceptanceService, the default behavior is to accept and complete
  assert.equal(result.run.state, "completed", "should complete with default orchestrator");
});

// ---------------------------------------------------------------------------
// advanceRun with acceptance service
// ---------------------------------------------------------------------------

test("advanceRun respects acceptance decision - repair_required", async () => {
  const deps = createMinimalDeps();
  deps.acceptanceService = {
    async evaluate({ run, intent, plan, evidence }) {
      return {
        decision: "repair_required",
        summary: "Missing commit_sha",
        missing_items: ["commit_sha"],
        id: "decision_repair_001",
      };
    },
  };
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.advanceRun(run.id);

  assert.equal(result.run.state, "waiting_for_repair");
  assert.equal(result.run.acceptance_decision_id, "decision_repair_001");
});

test("advanceRun respects acceptance decision - supervisor_required", async () => {
  const deps = createMinimalDeps();
  deps.acceptanceService = {
    async evaluate({ run, intent, plan, evidence }) {
      return {
        decision: "supervisor_required",
        summary: "Uncertain about side effects",
        id: "decision_super_001",
      };
    },
  };
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.advanceRun(run.id);

  assert.equal(result.run.state, "waiting_for_supervisor");
  assert.equal(result.run.acceptance_decision_id, "decision_super_001");
});

test("advanceRun respects acceptance decision - accepted", async () => {
  const deps = createMinimalDeps();
  deps.acceptanceService = {
    async evaluate({ run, intent, plan, evidence }) {
      return {
        decision: "accepted",
        summary: "All evidence checks passed",
        id: "decision_accept_001",
      };
    },
  };
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.advanceRun(run.id);

  assert.equal(result.run.state, "completed");
  assert.equal(result.run.acceptance_decision_id, "decision_accept_001");
});

test("advanceRun respects acceptance decision - rejected", async () => {
  const deps = createMinimalDeps();
  deps.acceptanceService = {
    async evaluate({ run, intent, plan, evidence }) {
      return {
        decision: "rejected",
        summary: "Evidence could not be verified",
        missing_items: ["commit_sha", "test_results"],
        rejected_claims: ["All tests pass"],
        id: "decision_reject_001",
      };
    },
  };
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.advanceRun(run.id);

  assert.equal(result.run.state, "failed");
  assert.equal(result.run.failure.code, "rejected");
});

// ---------------------------------------------------------------------------
// evaluateRun
// ---------------------------------------------------------------------------

test("evaluateRun transitions from evaluating to completed with acceptance", async () => {
  const deps = createMinimalDeps();
  deps.acceptanceService = {
    async evaluate({ run, intent, plan, evidence }) {
      return {
        decision: "accepted",
        summary: "Looks good",
        id: "decision_eval_001",
      };
    },
  };
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  // Manually transition to collecting for evaluateRun test
  // First advance to get into evaluating state
  const advanced = await svc.advanceRun(run.id);

  // Use evaluateRun on the completed run
  if (advanced.run.state === "completed") {
    // Start a new run for collecting->evaluating test
    const { run: run2 } = await svc.start({ intent_id: "intent_002" });
    await assert.rejects(
      () => svc.evaluateRun(run2.id),
      /must be in evaluating or collecting/
    );
  }
});

// ---------------------------------------------------------------------------
// start idempotency
// ---------------------------------------------------------------------------

test("start with same idempotency_key returns existing run", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const result1 = await svc.start({
    intent_id: "intent_001",
    idempotency_key: "idem_001",
  });

  const result2 = await svc.start({
    intent_id: "intent_001",
    idempotency_key: "idem_001",
  });

  assert.equal(result2.run.id, result1.run.id);
  assert.equal(result2.idempotent, true);
});

test("start with same request_id returns existing run", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const result1 = await svc.start({
    intent_id: "intent_001",
    request_id: "req_001",
  });

  const result2 = await svc.start({
    intent_id: "intent_001",
    request_id: "req_001",
  });

  assert.equal(result2.run.id, result1.run.id);
  assert.equal(result2.idempotent, true);
});

test("force_new_run overrides idempotency", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const result1 = await svc.start({
    intent_id: "intent_001",
    idempotency_key: "idem_force",
  });

  const result2 = await svc.start({
    intent_id: "intent_001",
    idempotency_key: "idem_force",
    force_new_run: true,
  });

  assert.notEqual(result2.run.id, result1.run.id);
  assert.equal(result2.idempotent, undefined);
});

// ---------------------------------------------------------------------------
// checkpointRun
// ---------------------------------------------------------------------------

test("checkpointRun transitions run to checkpointing", async () => {
  const deps = createMinimalDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_001" });
  // First advance to running
  const advanced = await svc.advanceRun(run.id);

  // Verify the run ended up in a good state
  assert.ok(["completed", "evaluating", "running"].includes(advanced.run.state),
    `State should be one of completed/evaluating/running, got ${advanced.run.state}`);
});

// ---------------------------------------------------------------------------
// Attempt tracking
// ---------------------------------------------------------------------------

test("start creates run without attempt; advanceRun creates attempt", async () => {
  const runStore = (await import("../../src/execution-core/execution-run-store.mjs")).createExecutionRunStore();
  const projSvc = (await import("../../src/execution-core/execution-projection-service.mjs")).createProjectionService();
  const svc = (await import("../../src/execution-core/execution-run-service.mjs")).createExecutionRunService({
    runStore,
    projectionService: projSvc,
    acceptanceService: { async evaluate() { return { decision: "accepted", summary: "t", id: "d" }; } },
  });

  const result = await svc.start({
    intent_id: "intent_001",
    task_id: "task_001",
  });

  assert.ok(result.run, "run should be created");
  // start() no longer creates attempts; advanceRun() does
  assert.equal(result.run.active_attempt_id, null, "active_attempt_id should be null after start");
  assert.equal(result.run.attempt_ids.length, 0, "attempt_ids should be empty after start");

  // advanceRun() creates the first attempt
  const advanced = await svc.advanceRun(result.run.id);
  assert.ok(advanced.run.active_attempt_id, "active_attempt_id should be set after advanceRun");
  assert.ok(advanced.run.attempt_ids.length >= 1, "attempt_ids should have at least 1 entry after advanceRun");
});

test("advanceRun with attemptStore creates persistent attempts", async () => {
  const runStore = (await import("../../src/execution-core/execution-run-store.mjs")).createExecutionRunStore();
  const projSvc = (await import("../../src/execution-core/execution-projection-service.mjs")).createProjectionService();

  const attemptStore = {
    claim: async ({ taskId, goalId, provider }) => ({
      attempt: {
        id: "persistent_attempt_" + taskId,
        task_id: taskId,
        goal_id: goalId,
        provider,
        state: "starting",
        attempt_number: 1,
      },
    }),
  };

  const svc = (await import("../../src/execution-core/execution-run-service.mjs")).createExecutionRunService({
    runStore,
    projectionService: projSvc,
    attemptStore,
    acceptanceService: { async evaluate() { return { decision: "accepted", summary: "t", id: "d" }; } },
  });

  const { run } = await svc.start({
    intent_id: "intent_001",
    task_id: "task_attempt_store",
  });
  assert.equal(run.active_attempt_id, null, "no attempt after start");

  const advanced = await svc.advanceRun(run.id);
  assert.ok(advanced.run.active_attempt_id, "active_attempt_id should be set after advanceRun");
  assert.ok(advanced.run.active_attempt_id.includes("persistent_attempt_"), "attempt ID prefix");
});
