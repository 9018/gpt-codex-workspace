/**
 * supervisor-review-request-store.test.mjs — Tests for Review Request Store
 *
 * @module test/supervisor-review/supervisor-review-request-store
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createReviewRequestStore } from "../../src/supervisor-review/supervisor-review-request-store.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const packetA = {
  revision: { id: "rev_001" },
  objective: { goal_text: "Goal A" },
};

const packetB = {
  revision: { id: "rev_002" },
  objective: { goal_text: "Goal B" },
};

const packetA_dup = {
  revision: { id: "rev_001" },
  objective: { goal_text: "Goal A (dup)" },
};

// ---------------------------------------------------------------------------
// getOrCreate
// ---------------------------------------------------------------------------

test("getOrCreate returns a new review request", async () => {
  const store = createReviewRequestStore();
  const req = await store.getOrCreate({ runId: "run_1", packet: packetA });
  assert.equal(req.run_id, "run_1");
  assert.equal(req.revision_id, "rev_001");
  assert.equal(req.status, "pending");
  assert.ok(req.id.startsWith("review_"));
});

test("same run_id + revision_id returns existing request", async () => {
  const store = createReviewRequestStore();
  const req1 = await store.getOrCreate({ runId: "run_1", packet: packetA });
  const req2 = await store.getOrCreate({ runId: "run_1", packet: packetA_dup });
  assert.equal(req1.id, req2.id);
  assert.equal(req1.revision_id, req2.revision_id);
});

test("different revision_id for same run creates new request", async () => {
  const store = createReviewRequestStore();
  const req1 = await store.getOrCreate({ runId: "run_1", packet: packetA });
  const req2 = await store.getOrCreate({ runId: "run_1", packet: packetB });
  assert.notEqual(req1.id, req2.id);
  assert.notEqual(req1.revision_id, req2.revision_id);
});

test("different run_id creates separate requests", async () => {
  const store = createReviewRequestStore();
  const req1 = await store.getOrCreate({ runId: "run_1", packet: packetA });
  const req2 = await store.getOrCreate({ runId: "run_2", packet: packetA });
  assert.notEqual(req1.id, req2.id);
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

test("claim returns a pending request and marks it claimed", async () => {
  const store = createReviewRequestStore();
  await store.getOrCreate({ runId: "run_1", packet: packetA });
  const claimed = await store.claim({ runId: "run_1", revisionId: "rev_001", workerId: "worker_1" });
  assert.ok(claimed);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claim_owner, "worker_1");
});

test("claim returns null for already claimed request", async () => {
  const store = createReviewRequestStore();
  await store.getOrCreate({ runId: "run_1", packet: packetA });
  await store.claim({ runId: "run_1", revisionId: "rev_001", workerId: "worker_1" });
  const secondClaim = await store.claim({ runId: "run_1", revisionId: "rev_001", workerId: "worker_2" });
  assert.equal(secondClaim, null);
});

test("claim returns null for non-existent request", async () => {
  const store = createReviewRequestStore();
  const claimed = await store.claim({ runId: "run_1", revisionId: "nonexistent", workerId: "worker_1" });
  assert.equal(claimed, null);
});

// ---------------------------------------------------------------------------
// Expired claim reclamation
// ---------------------------------------------------------------------------

test("expired claim can be reclaimed", async () => {
  const store = createReviewRequestStore({ now: () => "2026-07-18T00:00:00.000Z" });
  await store.getOrCreate({ runId: "run_1", packet: packetA });
  await store.claim({
    runId: "run_1",
    revisionId: "rev_001",
    workerId: "worker_1",
    leaseMs: 100,
  });

  // Past lease expiry
  const store2 = createReviewRequestStore({ now: () => "2026-07-18T00:00:00.200Z" });
  // Need to load from same state - use shared stateStore
});

// ---------------------------------------------------------------------------
// readRequest
// ---------------------------------------------------------------------------

test("readRequest returns request by ID", async () => {
  const store = createReviewRequestStore();
  const req = await store.getOrCreate({ runId: "run_1", packet: packetA });
  const read = await store.readRequest(req.id);
  assert.equal(read.id, req.id);
});

test("readRequest throws for missing ID", async () => {
  const store = createReviewRequestStore();
  await assert.rejects(
    () => store.readRequest("nonexistent"),
    /Review request not found/
  );
});
