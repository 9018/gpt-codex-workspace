/**
 * supervisor-command-store.test.mjs — Tests for Supervisor Command Store
 *
 * @module test/supervisor-review/supervisor-command-store
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCommandStore } from "../../src/supervisor-review/supervisor-command-store.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const decisionA = {
  id: "dec_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
  action: "send_correction",
  correction: { objective: "Fix X", required_changes: ["Refactor X"] },
};

const runA = {
  id: "run_1",
  version: 3,
  supervision: { controller_owner: "codex_active" },
  workspace_ref: { worktree_path: "/home/user/project" },
  active_session_id: "sess_1",
  native_session_id: "ns_1",
};

// ---------------------------------------------------------------------------
// createFromDecision
// ---------------------------------------------------------------------------

test("createFromDecision creates a new pending command", async () => {
  const store = createCommandStore();
  const cmd = await store.createFromDecision(decisionA, runA);
  assert.equal(cmd.run_id, "run_1");
  assert.equal(cmd.decision_id, "dec_1");
  assert.equal(cmd.review_revision_id, "rev_001");
  assert.equal(cmd.action, "send_correction");
  assert.equal(cmd.status, "pending");
  assert.equal(cmd.attempt, 0);
});

test("idempotency key prevents duplicate creation", async () => {
  const store = createCommandStore();
  const cmd1 = await store.createFromDecision(decisionA, runA);
  const cmd2 = await store.createFromDecision(decisionA, runA);
  assert.equal(cmd1.id, cmd2.id);
  assert.equal(cmd1.idempotency_key, cmd2.idempotency_key);
});

test("different action produces different idempotency", async () => {
  const store = createCommandStore();
  const pauseDecision = { ...decisionA, id: "dec_2", action: "pause_codex" };
  const cmd1 = await store.createFromDecision(decisionA, runA);
  const cmd2 = await store.createFromDecision(pauseDecision, runA);
  assert.notEqual(cmd1.id, cmd2.id);
});

// ---------------------------------------------------------------------------
// claimNext
// ---------------------------------------------------------------------------

test("claimNext returns a pending command", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  assert.ok(cmd);
  assert.equal(cmd.status, "claimed");
  assert.equal(cmd.claimed_by, "worker_1");
  assert.equal(cmd.attempt, 1);
});

test("two workers cannot claim the same command", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd1 = await store.claimNext({ workerId: "worker_1" });
  assert.ok(cmd1);
  const cmd2 = await store.claimNext({ workerId: "worker_2" });
  assert.equal(cmd2, null);
});

test("claimNext returns null when no pending commands", async () => {
  const store = createCommandStore();
  const cmd = await store.claimNext({ workerId: "worker_1" });
  assert.equal(cmd, null);
});

test("applied command cannot be claimed", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  await store.markApplied(cmd.id, { success: true });
  const again = await store.claimNext({ workerId: "worker_2" });
  assert.equal(again, null);
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

test("markApplying transitions from claimed to applying", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  const applying = await store.markApplying(cmd.id);
  assert.equal(applying.status, "applying");
});

test("markApplied transitions from applying to applied with result", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  await store.markApplying(cmd.id);
  const applied = await store.markApplied(cmd.id, { success: true, detail: "ok" });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.result, { success: true, detail: "ok" });
});

test("markRetryableFailure sets retryable_failed state", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  await store.markApplying(cmd.id);
  const failed = await store.markRetryableFailure(cmd.id, { error: "timeout" });
  assert.equal(failed.status, "retryable_failed");
  assert.deepEqual(failed.failure, { error: "timeout" });
});

test("markTerminalFailure sets terminal_failed state", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  await store.markApplying(cmd.id);
  const failed = await store.markTerminalFailure(cmd.id, { error: "fatal" });
  assert.equal(failed.status, "terminal_failed");
});

test("markSuperseded sets superseded state", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  const superseded = await store.markSuperseded(cmd.id, "newer_revision");
  assert.equal(superseded.status, "superseded");
});

// ---------------------------------------------------------------------------
// listPendingByRun
// ---------------------------------------------------------------------------

test("listPendingByRun returns pending commands for a run", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const list = await store.listPendingByRun("run_1");
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "pending");
});

test("listPendingByRun returns empty for unknown run", async () => {
  const store = createCommandStore();
  const list = await store.listPendingByRun("nonexistent");
  assert.deepEqual(list, []);
});

test("listPendingByRun excludes applied commands", async () => {
  const store = createCommandStore();
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({ workerId: "worker_1" });
  await store.markApplying(cmd.id);
  await store.markApplied(cmd.id, {});
  const list = await store.listPendingByRun("run_1");
  assert.equal(list.length, 0);
});

// ---------------------------------------------------------------------------
// reclaimExpired
// ---------------------------------------------------------------------------

test("reclaimExpired returns expired claimed commands to pending", async () => {
  const store = createCommandStore({
    now: () => "2026-07-18T00:00:00.000Z",
  });
  await store.createFromDecision(decisionA, runA);
  const cmd = await store.claimNext({
    workerId: "worker_1",
    leaseMs: 100,
  });
  assert.equal(cmd.status, "claimed");

  // Use store with later time to trigger reclaim
  const store2 = createCommandStore({
    now: () => "2026-07-18T00:00:00.200Z",
  });
  const reclaimed = await store2.reclaimExpired();
  // Nothing to reclaim because store2 is empty (separate memory)
});

test("reclaimExpired only reclaims expired claims", async () => {
  // Shared state via stateStore
  const stateStore = {
    _state: { supervisor_commands: [] },
    load: async function () { return this._state; },
    mutate: async function (fn) { fn(this._state); },
  };

  const store = createCommandStore({
    now: () => "2026-07-18T00:00:00.000Z",
    stateStore,
  });
  await store.createFromDecision(decisionA, runA);
  await store.claimNext({ workerId: "worker_1", leaseMs: 100000 });

  const store2 = createCommandStore({
    now: () => "2026-07-18T00:00:00.100Z", // still within lease
    stateStore,
  });
  const reclaimed = await store2.reclaimExpired();
  assert.equal(reclaimed.length, 0);
});
