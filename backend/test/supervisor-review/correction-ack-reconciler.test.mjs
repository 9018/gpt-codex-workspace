/**
 * correction-ack-reconciler.test.mjs — Tests for Correction Ack Reconciler
 *
 * @module test/supervisor-review/correction-ack-reconciler
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCorrectionAckReconciler, CorrectionNotAcknowledgedError } from "../../src/supervisor-review/correction-ack-reconciler.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCommand = {
  id: "cmd_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
};

const baseRun = {
  id: "run_1",
  version: 3,
  supervision: {
    correction_cycles: 2,
    awaiting_progress_after_correction: true,
    last_correction_id: "cmd_1",
    last_correction_revision: "rev_001",
    correction_sent_at: "2026-07-18T00:00:00.000Z",
  },
};

// ---------------------------------------------------------------------------
// Explicit ack
// ---------------------------------------------------------------------------

test("explicit ack resolves reconciliation", async () => {
  const reconciler = createCorrectionAckReconciler({
    observationService: {
      observe: async () => ({
        ack_command_id: "cmd_1",
        ack_revision_id: "rev_001",
        diff_digest: null,
        progress_revision: 0,
      }),
    },
  });
  const result = await reconciler.reconcile(baseCommand, baseRun);
  assert.equal(result.status, "acknowledged");
});

// ---------------------------------------------------------------------------
// Implicit ack via progress
// ---------------------------------------------------------------------------

test("progress change implies acknowledgment", async () => {
  const reconciler = createCorrectionAckReconciler({
    observationService: {
      observe: async () => ({
        ack_command_id: null,
        ack_revision_id: null,
        diff_digest: "diff_new",
        progress_revision: 5,
      }),
    },
  });
  const result = await reconciler.reconcile(baseCommand, baseRun);
  assert.equal(result.status, "implicitly_acknowledged");
});

// ---------------------------------------------------------------------------
// Still waiting
// ---------------------------------------------------------------------------

test("no change returns waiting status", async () => {
  const reconciler = createCorrectionAckReconciler({
    observationService: {
      observe: async () => ({
        ack_command_id: null,
        ack_revision_id: null,
        diff_digest: null,
        progress_revision: 0,
      }),
    },
    ackTimeoutMs: 3600000, // 1 hour — avoids clock-dependent failure
    now: () => new Date("2026-07-18T00:01:00.000Z").toISOString(),
  });
  const result = await reconciler.reconcile(baseCommand, baseRun);
  assert.equal(result.status, "waiting");
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

test("timeout throws CorrectionNotAcknowledgedError", async () => {
  const reconciler = createCorrectionAckReconciler({
    observationService: {
      observe: async () => ({
        ack_command_id: null,
        ack_revision_id: null,
        diff_digest: null,
        progress_revision: 0,
      }),
    },
    ackTimeoutMs: 1,
    now: () => new Date("2026-07-18T00:05:00.000Z"), // 5 min later
  });
  await assert.rejects(
    () => reconciler.reconcile(baseCommand, baseRun),
    CorrectionNotAcknowledgedError
  );
});

// ---------------------------------------------------------------------------
// Already acknowledged
// ---------------------------------------------------------------------------

test("already acknowledged returns immediately", async () => {
  const run = {
    ...baseRun,
    supervision: {
      ...baseRun.supervision,
      correction_acknowledged_at: "2026-07-18T00:01:00.000Z",
    },
  };
  const reconciler = createCorrectionAckReconciler();
  const result = await reconciler.reconcile(baseCommand, run);
  assert.equal(result.status, "already_acknowledged");
});
