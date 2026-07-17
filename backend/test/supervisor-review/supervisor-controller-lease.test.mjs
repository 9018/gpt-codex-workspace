/**
 * supervisor-controller-lease.test.mjs — Tests for Controller Lease
 *
 * @module test/supervisor-review/supervisor-controller-lease
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createControllerLease } from "../../src/supervisor-review/supervisor-controller-lease.mjs";

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("creates initial lease with default owner", async () => {
  const lease = createControllerLease();
  const state = await lease.getLease("run_1");
  assert.equal(state.owner, "codex_active");
  assert.equal(state.run_id, "run_1");
  assert.equal(state.epoch, 0);
  assert.equal(state.holder_id, null);
});

test("getLease creates lease lazily", async () => {
  const lease = createControllerLease();
  const state = await lease.getLease("run_new");
  assert.equal(state.run_id, "run_new");
});

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

test("codex_active -> codex_quiescing is valid", async () => {
  const lease = createControllerLease();
  const result = await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "codex_active",
    nextOwner: "codex_quiescing",
  });
  assert.ok(result);
  const state = await lease.getLease("run_1");
  assert.equal(state.owner, "codex_quiescing");
  assert.equal(state.epoch, 1);
});

test("full takeover chain succeeds", async () => {
  const lease = createControllerLease();
  const chain = [
    "codex_active", "codex_quiescing",
    "codex_quiescing", "chatgpt_supervising",
    "chatgpt_supervising", "chatgpt_direct",
  ];
  for (let i = 0; i < chain.length; i += 2) {
    const ok = await lease.compareAndSetOwner({
      runId: "run_1",
      expectedOwner: chain[i],
      nextOwner: chain[i + 1],
    });
    assert.ok(ok, `${chain[i]} -> ${chain[i+1]} should succeed`);
  }
  const state = await lease.getLease("run_1");
  assert.equal(state.owner, "chatgpt_direct");
  assert.equal(state.epoch, 3);
});

test("handoff chain succeeds", async () => {
  const lease = createControllerLease();
  await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "codex_active", nextOwner: "codex_quiescing",
  });
  await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "codex_quiescing", nextOwner: "chatgpt_supervising",
  });
  await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "chatgpt_supervising", nextOwner: "chatgpt_direct",
  });
  // Handoff back
  const ok = await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "chatgpt_direct", nextOwner: "handoff_to_codex",
  });
  assert.ok(ok);
  const ok2 = await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "handoff_to_codex", nextOwner: "codex_active",
  });
  assert.ok(ok2);
  const state = await lease.getLease("run_1");
  assert.equal(state.owner, "codex_active");
  assert.equal(state.epoch, 5);
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

test("codex_active -> chatgpt_direct is rejected", async () => {
  const lease = createControllerLease();
  const result = await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "codex_active",
    nextOwner: "chatgpt_direct",
  });
  assert.equal(result, false);
});

test("epoch mismatch is rejected", async () => {
  const lease = createControllerLease();
  // First transition changes epoch to 1
  await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "codex_active", nextOwner: "codex_quiescing",
  });
  // Try with wrong epoch
  const result = await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "codex_quiescing",
    expectedEpoch: 0, // wrong, should be 1
    nextOwner: "chatgpt_supervising",
  });
  assert.equal(result, false);
});

test("wrong expectedOwner is rejected", async () => {
  const lease = createControllerLease();
  const result = await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "chatgpt_direct", // wrong, actual is codex_active
    nextOwner: "codex_quiescing",
  });
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// holder_id
// ---------------------------------------------------------------------------

test("compareAndSetOwner updates holder_id and worktree info", async () => {
  const lease = createControllerLease();
  await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "codex_active",
    nextOwner: "codex_quiescing",
    holderId: "worker_1",
    worktreePath: "/home/user/project",
  });
  const state = await lease.getLease("run_1");
  assert.equal(state.holder_id, "worker_1");
  assert.equal(state.worktree_path, "/home/user/project");
});

// ---------------------------------------------------------------------------
// Any -> none
// ---------------------------------------------------------------------------

test("any owner can transition to none", async () => {
  const lease = createControllerLease();
  const ok = await lease.compareAndSetOwner({
    runId: "run_1",
    expectedOwner: "codex_active",
    nextOwner: "none",
  });
  assert.ok(ok);
  const state = await lease.getLease("run_1");
  assert.equal(state.owner, "none");
});

// ---------------------------------------------------------------------------
// read / list
// ---------------------------------------------------------------------------

test("listActiveLeases returns non-none leases", async () => {
  const lease = createControllerLease();
  await lease.compareAndSetOwner({
    runId: "run_1", expectedOwner: "codex_active", nextOwner: "codex_quiescing",
  });
  const state1 = await lease.getLease("run_2"); // default codex_active
  const active = await lease.listActiveLeases();
  assert.ok(active.length >= 1);
  const owners = active.map((l) => l.owner);
  assert.ok(owners.includes("codex_quiescing"));
});
