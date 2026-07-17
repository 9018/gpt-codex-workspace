/**
 * review-coordinator.test.mjs — Tests for Review Coordinator
 *
 * @module test/supervisor-review/review-coordinator
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createReviewCoordinator } from "../../src/supervisor-review/review-coordinator.mjs";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  let requestCount = 0;
  return {
    reviewPacketBuilder: {
      build: async ({ runId }) => ({
        id: `review_packet_rev_001`,
        schema_version: 1,
        revision: { id: "rev_001", run_id: runId },
        execution: { run_id: runId },
        repository: {},
        objective: {},
        architecture_baseline: {},
        verification: { evidence_gaps: [] },
        tui: {},
        review_questions: [],
        limits: { allowed_actions: ["continue_codex"] },
        created_at: "2026-07-18T00:00:00.000Z",
      }),
    },
    reviewRequestStore: {
      getOrCreate: async ({ runId, packet }) => {
        requestCount++;
        return {
          id: `review_run_1_rev_001`,
          run_id: runId,
          revision_id: packet.revision.id,
          status: "pending",
        };
      },
      listByRun: async () => [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

test("tick returns review_required true for new revision", async () => {
  const coordinator = createReviewCoordinator(createMockDeps());
  const result = await coordinator.tick("run_1");

  assert.equal(result.review_required, true);
  assert.ok(result.request);
  assert.equal(result.request.revision_id, "rev_001");
});

test("tick creates only one request per tick", async () => {
  let callCount = 0;
  const deps = createMockDeps({
    reviewRequestStore: {
      getOrCreate: async () => {
        callCount++;
        return { id: "req_1", revision_id: "rev_001", status: "pending" };
      },
    },
  });
  const coordinator = createReviewCoordinator(deps);
  await coordinator.tick("run_1");
  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// Dedup test: same revision doesn't re-review
// ---------------------------------------------------------------------------

test("tick returns review_required false for already-decided revision", async () => {
  const deps = createMockDeps({
    reviewRequestStore: {
      getOrCreate: async () => ({
        id: "req_1",
        revision_id: "rev_001",
        status: "decided",
      }),
    },
  });
  const coordinator = createReviewCoordinator(deps);
  const result = await coordinator.tick("run_1");

  assert.equal(result.review_required, false);
  assert.ok(result.request);
  assert.equal(result.request.status, "decided");
});

// ---------------------------------------------------------------------------
// Skipped reason
// ---------------------------------------------------------------------------

test("tick provides skipped_reason when review not required", async () => {
  const deps = createMockDeps({
    reviewRequestStore: {
      getOrCreate: async () => ({
        id: "req_1",
        revision_id: "rev_001",
        status: "decided",
      }),
    },
  });
  const coordinator = createReviewCoordinator(deps);
  const result = await coordinator.tick("run_1");

  assert.equal(result.review_required, false);
  assert.ok(result.skipped_reason);
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

test("tick propagates errors from packet builder", async () => {
  const deps = createMockDeps({
    reviewPacketBuilder: {
      build: async () => { throw new Error("Builder failure"); },
    },
  });
  const coordinator = createReviewCoordinator(deps);
  await assert.rejects(() => coordinator.tick("run_1"), /Builder failure/);
});
