/**
 * supervisor-review-worker.test.mjs — Tests for Review Worker
 *
 * @module test/supervisor-review/supervisor-review-worker
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createReviewWorker } from "../../src/supervisor-review/supervisor-review-worker.mjs";

// ---------------------------------------------------------------------------
// Helpers: claimOnce creates a claimNext that returns command once, then null
// ---------------------------------------------------------------------------

function claimOnce(returnValue) {
  let called = false;
  return async () => {
    if (called) return null;
    called = true;
    return returnValue;
  };
}

// ---------------------------------------------------------------------------
// Tick: no commands
// ---------------------------------------------------------------------------

test("tick returns executed:0 when no commands pending", async () => {
  const worker = createReviewWorker({
    commandStore: {
      claimNext: async () => null,
      reclaimExpired: async () => [],
    },
    commandExecutor: { execute: async () => ({ ok: true }) },
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  const result = await worker.tick();
  assert.equal(result.executed, 0);
});

// ---------------------------------------------------------------------------
// Tick: claims and executes
// ---------------------------------------------------------------------------

test("tick claims next command and executes it", async () => {
  let executed = false;
  const worker = createReviewWorker({
    commandStore: {
      claimNext: claimOnce({
        id: "cmd_1",
        run_id: "run_1",
        review_revision_id: "rev_001",
        action: "send_correction",
        payload: {},
      }),
      reclaimExpired: async () => [],
    },
    commandExecutor: {
      execute: async (cmd) => {
        executed = true;
        assert.equal(cmd.id, "cmd_1");
      },
    },
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  const result = await worker.tick();
  assert.ok(executed);
  assert.equal(result.executed, 1);
});

// ---------------------------------------------------------------------------
// Reclaim expired
// ---------------------------------------------------------------------------

test("tick reclaims expired claims", async () => {
  let reclaimed = false;
  const worker = createReviewWorker({
    commandStore: {
      claimNext: async () => null,
      reclaimExpired: async () => {
        reclaimed = true;
        return [{ id: "expired_1" }];
      },
    },
    commandExecutor: { execute: async () => ({ ok: true }) },
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  await worker.tick();
  assert.ok(reclaimed);
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

test("tick error in one command does not block worker", async () => {
  const worker = createReviewWorker({
    commandStore: {
      claimNext: claimOnce({
        id: "cmd_1",
        run_id: "run_1",
        review_revision_id: "rev_001",
        action: "send_correction",
        payload: {},
      }),
      reclaimExpired: async () => [],
    },
    commandExecutor: {
      execute: async () => { throw new Error("Execution failure"); },
    },
    revisionReader: { current: async () => ({ id: "rev_001" }) },
  });
  const result = await worker.tick();
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes("cmd_1"));
});

// ---------------------------------------------------------------------------
// Stale command supersede
// ---------------------------------------------------------------------------

test("tick supersedes commands from stale revisions", async () => {
  let supersededId = null;
  const worker = createReviewWorker({
    commandStore: {
      claimNext: claimOnce({
        id: "cmd_stale",
        run_id: "run_1",
        review_revision_id: "rev_old",
        action: "send_correction",
        payload: {},
      }),
      reclaimExpired: async () => [],
      markSuperseded: async (cmdId, reason) => {
        supersededId = cmdId;
      },
    },
    revisionReader: { current: async () => ({ id: "rev_current" }) },
    commandExecutor: { execute: async () => { throw new Error("should not be called"); } },
  });
  const result = await worker.tick();
  assert.equal(supersededId, "cmd_stale");
  assert.equal(result.superseded, 1);
  assert.equal(result.executed, 0);
});
