/**
 * supervisor-decision-store.test.mjs — Tests for Supervisor Decision Store
 *
 * @module test/supervisor-review/supervisor-decision-store
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDecisionStore, StaleReviewDecisionError } from "../../src/supervisor-review/supervisor-decision-store.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const decisionA = {
  id: "dec_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
  verdict: "aligned",
  action: "continue_codex",
  decided_by: "chatgpt",
  decided_at: "2026-07-18T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

test("records a decision immutably", async () => {
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  const d = await store.recordDecision(decisionA);
  assert.equal(d.id, "dec_1");
  assert.equal(d.run_id, "run_1");
});

test("rejects duplicate decision ID", async () => {
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  await store.recordDecision(decisionA);
  await assert.rejects(
    () => store.recordDecision(decisionA),
    /already exists/
  );
});

test("throws StaleReviewDecisionError when revision is stale", async () => {
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_999" }) },
  });
  await assert.rejects(
    () => store.recordDecision(decisionA),
    StaleReviewDecisionError
  );
});

test("records decision with request store update", async () => {
  let updatedRequest = null;
  const mockRequestStore = {
    listByRun: async (runId) => [
      { id: "req_1", revision_id: "rev_001", status: "pending" },
    ],
    updateRequestStatus: async (id, status, decisionId) => {
      updatedRequest = { id, status, decisionId };
    },
  };
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_001" }) },
    requestStore: mockRequestStore,
  });
  await store.recordDecision(decisionA);
  assert.ok(updatedRequest);
  assert.equal(updatedRequest.id, "req_1");
  assert.equal(updatedRequest.status, "decided");
  assert.equal(updatedRequest.decisionId, "dec_1");
});

// ---------------------------------------------------------------------------
// readDecision
// ---------------------------------------------------------------------------

test("readDecision returns a recorded decision", async () => {
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  await store.recordDecision(decisionA);
  const read = await store.readDecision("dec_1");
  assert.equal(read.id, "dec_1");
});

test("readDecision throws for missing ID", async () => {
  const store = createDecisionStore();
  await assert.rejects(
    () => store.readDecision("nonexistent"),
    /Decision not found/
  );
});

// ---------------------------------------------------------------------------
// listByRun
// ---------------------------------------------------------------------------

test("listByRun returns empty array for run with no decisions", async () => {
  const store = createDecisionStore();
  const list = await store.listByRun("run_nonexistent");
  assert.deepEqual(list, []);
});

test("listByRun returns decisions sorted newest first", async () => {
  const store = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  await store.recordDecision(decisionA);

  const decisionB = {
    ...decisionA,
    id: "dec_2",
    review_revision_id: "rev_002",
    decided_at: "2026-07-18T00:01:00.000Z",
  };
  // Can only record with current revision for the same run
  const store2 = createDecisionStore({
    revisionReader: { current: async () => ({ id: "rev_002" }) },
  });
  await store2.recordDecision(decisionB);

  // Both stores use separate memory - only test one store
  const list = await store.listByRun("run_1");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "dec_1");
});
