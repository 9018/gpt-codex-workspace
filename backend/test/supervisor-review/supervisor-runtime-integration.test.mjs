/**
 * supervisor-runtime-integration.test.mjs — Tests the supervisor runtime
 * singleton wiring: ensureSupervisorRuntime → getReviewTools/getDecisionTools
 * and that startReviewWorker can be called safely.
 *
 * @module test/supervisor-review/supervisor-runtime-integration
 */

import test from "node:test";
import assert from "node:assert/strict";

import { StateStore } from "../../src/state-store.mjs";
import {
  ensureSupervisorRuntime,
  getRunStore,
  getCommandStore,
  getReviewTools,
  getDecisionTools,
  getReviewWorker,
  getReviewCoordinator,
  getCheckpointStore,
  getLeaseManager,
  startReviewWorker,
  stopReviewWorker,
} from "../../src/supervisor-review/supervisor-runtime.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStateStore() {
  const store = new StateStore({
    statePath: "/tmp/.gptwork-test-state.jsonl",
    defaultWorkspaceRoot: "/tmp",
  });
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("ensureSupervisorRuntime lazily initializes all stores and services", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();

  ensureSupervisorRuntime(stateStore);

  assert.ok(getRunStore(), "runStore should be initialized");
  assert.ok(getCommandStore(), "commandStore should be initialized");
  assert.ok(getReviewTools(), "reviewTools should be initialized");
  assert.ok(getDecisionTools(), "decisionTools should be initialized");
  assert.ok(getReviewWorker(), "reviewWorker should be initialized");
  assert.ok(getReviewCoordinator(), "reviewCoordinator should be initialized");
  assert.ok(getCheckpointStore(), "checkpointStore should be initialized");
  assert.ok(getLeaseManager(), "leaseManager should be initialized");
});

test("ensureSupervisorRuntime is idempotent — second call does not throw", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();

  ensureSupervisorRuntime(stateStore);
  ensureSupervisorRuntime(stateStore);

  assert.ok(getRunStore(), "Run store accessible after second initialization");
});

test("getReviewTools returns supervisor_review_active_runs tool with handler", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();
  ensureSupervisorRuntime(stateStore);

  const tools = getReviewTools();
  assert.ok(tools, "reviewTools should exist");
  assert.ok(tools.supervisor_review_active_runs, "should have supervisor_review_active_runs");
  assert.equal(typeof tools.supervisor_review_active_runs.handler, "function",
    "supervisor_review_active_runs should have a handler function");
});

test("getDecisionTools returns supervisor_submit_decisions tool with handler", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();
  ensureSupervisorRuntime(stateStore);

  const tools = getDecisionTools();
  assert.ok(tools, "decisionTools should exist");
  assert.ok(tools.supervisor_submit_decisions, "should have supervisor_submit_decisions");
  assert.equal(typeof tools.supervisor_submit_decisions.handler, "function",
    "supervisor_submit_decisions should have a handler function");
});

test("start/stopReviewWorker is safe to call and idempotent", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();
  ensureSupervisorRuntime(stateStore);

  // Start the worker with a long interval so it doesn't actually poll
  startReviewWorker(60000);
  // Second call should be no-op (already running)
  startReviewWorker(60000);

  // Stop cleanup
  stopReviewWorker();
  // Second stop should be no-op
  stopReviewWorker();

  assert.ok(true, "start/stop cycle completed without throwing");
});

test("reviewWorker tick is functional after runtime init", async (t) => {
  const stateStore = createTestStateStore();
  await stateStore.load();
  ensureSupervisorRuntime(stateStore);

  const worker = getReviewWorker();
  assert.ok(worker, "reviewWorker instance exists");
  assert.equal(typeof worker.tick, "function", "reviewWorker has tick() method");

  // A no-command tick should not throw even with empty command store
  const result = await worker.tick();
  assert.ok(result, "tick result should be returned");
  assert.equal(typeof result.executed, "number", "tick should have executed count");
  assert.ok(Array.isArray(result.errors), "tick should have errors array");
});
