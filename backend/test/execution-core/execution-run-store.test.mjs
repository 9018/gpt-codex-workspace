import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionRunStore, StateConflictError } from "../../src/execution-core/execution-run-store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunInput(overrides = {}) {
  return { intent_id: "intent_abc", ...overrides };
}

// ---------------------------------------------------------------------------
// createRun / readRun
// ---------------------------------------------------------------------------

test("createRun creates a run and readRun retrieves it", async () => {
  const store = createExecutionRunStore();

  const run = await store.createRun(makeRunInput());
  assert.ok(run.id.startsWith("run_"));
  assert.equal(run.state, "created");

  const read = await store.readRun(run.id);
  assert.deepEqual(read, run);
});

test("readRun throws for nonexistent run", async () => {
  const store = createExecutionRunStore();
  await assert.rejects(() => store.readRun("nonexistent"), /ExecutionRun not found/);
});

// ---------------------------------------------------------------------------
// updateRun
// ---------------------------------------------------------------------------

test("updateRun patches fields and increments version", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  assert.equal(run.version, 1);

  const updated = await store.updateRun(run.id, {
    goal_id: "goal_xyz",
    plan_id: "plan_123",
  });

  assert.equal(updated.goal_id, "goal_xyz");
  assert.equal(updated.plan_id, "plan_123");
  assert.equal(updated.version, 2);

  // Original fields preserved
  assert.equal(updated.intent_id, "intent_abc");
  assert.equal(updated.state, "created");

  // updated_at should have changed
  assert.ok(updated.updated_at >= run.updated_at);
});

test("updateRun does not overwrite immutable fields", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput({ id: "run_fixed" }));

  const updated = await store.updateRun(run.id, { id: "run_new", intent_id: "intent_new", state: "running" });
  assert.equal(updated.id, "run_fixed");
  assert.equal(updated.intent_id, "intent_abc");
  assert.equal(updated.state, "created"); // state protected
});

test("updateRun throws for nonexistent run", async () => {
  const store = createExecutionRunStore();
  await assert.rejects(() => store.updateRun("nonexistent", {}), /ExecutionRun not found/);
});

// ---------------------------------------------------------------------------
// appendAttempt
// ---------------------------------------------------------------------------

test("appendAttempt adds attempt to run", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  const updated1 = await store.appendAttempt(run.id, "attempt_001");
  assert.deepEqual(updated1.attempt_ids, ["attempt_001"]);
  assert.equal(updated1.version, 2);

  const updated2 = await store.appendAttempt(run.id, "attempt_002");
  assert.deepEqual(updated2.attempt_ids, ["attempt_001", "attempt_002"]);
  assert.equal(updated2.version, 3);
});

test("appendAttempt is idempotent for the same attempt_id", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  await store.appendAttempt(run.id, "attempt_001");
  const afterDup = await store.appendAttempt(run.id, "attempt_001");
  assert.deepEqual(afterDup.attempt_ids, ["attempt_001"]);
  assert.equal(afterDup.version, 2); // version incremented only on first add
});

test("appendAttempt throws for nonexistent run", async () => {
  const store = createExecutionRunStore();
  await assert.rejects(() => store.appendAttempt("nonexistent", "attempt_001"), /ExecutionRun not found/);
});

// ---------------------------------------------------------------------------
// compareAndSetState
// ---------------------------------------------------------------------------

test("compareAndSetState transitions state when expected matches", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  const updated = await store.compareAndSetState({
    runId: run.id,
    expectedState: "created",
    nextState: "planning",
  });

  assert.equal(updated.state, "planning");
  assert.equal(updated.version, 2);

  const read = await store.readRun(run.id);
  assert.equal(read.state, "planning");
});

test("compareAndSetState applies additional patch fields", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  const updated = await store.compareAndSetState({
    runId: run.id,
    expectedState: "created",
    nextState: "planning",
    patch: { plan_id: "plan_001" },
  });

  assert.equal(updated.state, "planning");
  assert.equal(updated.plan_id, "plan_001");
});

test("compareAndSetState throws StateConflictError when state doesn't match", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  await store.compareAndSetState({
    runId: run.id,
    expectedState: "created",
    nextState: "planning",
  });

  // Now try to transition from "created" again
  await assert.rejects(
    () =>
      store.compareAndSetState({
        runId: run.id,
        expectedState: "created",
        nextState: "ready",
      }),
    (err) => {
      assert.ok(err instanceof StateConflictError);
      assert.equal(err.runId, run.id);
      assert.equal(err.expectedState, "created");
      assert.equal(err.actualState, "planning");
      return true;
    }
  );
});

test("compareAndSetState throws for nonexistent run", async () => {
  const store = createExecutionRunStore();
  await assert.rejects(
    () =>
      store.compareAndSetState({
        runId: "nonexistent",
        expectedState: "created",
        nextState: "planning",
      }),
    /ExecutionRun not found/
  );
});

// ---------------------------------------------------------------------------
// CAS prevents concurrent workers from double-advancing
// ---------------------------------------------------------------------------

test("CAS prevents two workers from advancing the same run concurrently", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  // Worker 1 advances created -> planning
  const w1 = store.compareAndSetState({
    runId: run.id,
    expectedState: "created",
    nextState: "planning",
  });

  // Worker 2 also tries created -> planning (should fail after w1)
  const w2 = store.compareAndSetState({
    runId: run.id,
    expectedState: "created",
    nextState: "planning",
  });

  const [r1, r2Err] = await Promise.allSettled([w1, w2]);

  assert.equal(r1.status, "fulfilled");
  assert.equal(r1.value.state, "planning");

  assert.equal(r2Err.status, "rejected");
  assert.ok(r2Err.reason instanceof StateConflictError);
  assert.equal(r2Err.reason.actualState, "planning");
});

// ---------------------------------------------------------------------------
// Idempotency lookups
// ---------------------------------------------------------------------------

test("findRunByIdempotencyKey returns null for unknown key", async () => {
  const store = createExecutionRunStore();
  const result = await store.findRunByIdempotencyKey("nonexistent");
  assert.equal(result, null);
});

test("findRunByRequestId returns null for unknown request", async () => {
  const store = createExecutionRunStore();
  const result = await store.findRunByRequestId("nonexistent");
  assert.equal(result, null);
});

test("createRun with idempotency_key can be found by key", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput({ idempotency_key: "idem_001" }));
  assert.equal(run.idempotency_key, "idem_001");

  const found = await store.findRunByIdempotencyKey("idem_001");
  assert.notEqual(found, null);
  assert.equal(found.id, run.id);
});

test("createRun with request_id can be found by request_id", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput({ request_id: "req_001" }));
  assert.equal(run.request_id, "req_001");

  const found = await store.findRunByRequestId("req_001");
  assert.notEqual(found, null);
  assert.equal(found.id, run.id);
});

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

test("listRuns returns all runs without filters", async () => {
  const store = createExecutionRunStore();
  await store.createRun(makeRunInput({ intent_id: "intent_a" }));
  await store.createRun(makeRunInput({ intent_id: "intent_b" }));

  const all = await store.listRuns();
  assert.equal(all.length, 2);
});

test("listRuns filters by state", async () => {
  const store = createExecutionRunStore();
  const r1 = await store.createRun(makeRunInput({ intent_id: "intent_a" }));
  const r2 = await store.createRun(makeRunInput({ intent_id: "intent_b" }));

  await store.compareAndSetState({ runId: r1.id, expectedState: "created", nextState: "planning" });

  const created = await store.listRuns({ state: "created" });
  assert.equal(created.length, 1);
  assert.equal(created[0].id, r2.id);

  const planning = await store.listRuns({ state: ["created", "planning"] });
  assert.equal(planning.length, 2);
});

test("listRuns filters by intent_id, goal_id, task_id", async () => {
  const store = createExecutionRunStore();
  await store.createRun(makeRunInput({ intent_id: "intent_a" }));
  await store.createRun(makeRunInput({ intent_id: "intent_b", goal_id: "goal_1" }));
  await store.createRun(makeRunInput({ intent_id: "intent_a", goal_id: "goal_1", task_id: "task_x" }));

  assert.equal((await store.listRuns({ intent_id: "intent_a" })).length, 2);
  assert.equal((await store.listRuns({ goal_id: "goal_1" })).length, 2);
  assert.equal((await store.listRuns({ task_id: "task_x" })).length, 1);
});

test("listRuns filters by request_id", async () => {
  const store = createExecutionRunStore();
  await store.createRun(makeRunInput({ request_id: "req_a" }));
  await store.createRun(makeRunInput({ request_id: "req_b" }));

  assert.equal((await store.listRuns({ request_id: "req_a" })).length, 1);
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

test("count returns correct number of runs", async () => {
  const store = createExecutionRunStore();
  assert.equal(await store.count(), 0);
  await store.createRun(makeRunInput());
  assert.equal(await store.count(), 1);
  await store.createRun(makeRunInput());
  assert.equal(await store.count(), 2);
});

// ---------------------------------------------------------------------------
// Immutability / cloning
// ---------------------------------------------------------------------------

test("runs returned from store are immutable copies", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  // Mutating the returned object should not affect the store
  run.state = "cancelled";

  const read = await store.readRun(run.id);
  assert.equal(read.state, "created");
});

// ---------------------------------------------------------------------------
// Now function override
// ---------------------------------------------------------------------------

test("store respects custom now function", async () => {
  const fixed = "2026-07-18T12:00:00.000Z";
  const store = createExecutionRunStore({ now: () => fixed });

  const run = await store.createRun(makeRunInput());
  assert.equal(run.created_at, fixed);
  assert.equal(run.updated_at, fixed);
});

// ---------------------------------------------------------------------------
// Supervision field persistence
// ---------------------------------------------------------------------------

test("updateRun preserves supervision fields", async () => {
  const store = createExecutionRunStore();
  const run = await store.createRun(makeRunInput());

  const updated = await store.updateRun(run.id, {
    supervision: {
      controller_owner: "chatgpt_supervising",
      execution_mode: "native_tui",
      correction_cycles: 2,
      same_failure_retries: 0,
      native_resume_count: 1,
      chatgpt_takeover_count: 0,
      last_failure_signature: "attempt_failed",
      waiting_reason: "supervisor intervention required",
      takeover_reason: null,
      last_instruction_digest: null,
    },
  });

  assert.equal(updated.supervision.controller_owner, "chatgpt_supervising");
  assert.equal(updated.supervision.correction_cycles, 2);
  assert.equal(updated.supervision.native_resume_count, 1);
  assert.equal(updated.supervision.last_failure_signature, "attempt_failed");
});
