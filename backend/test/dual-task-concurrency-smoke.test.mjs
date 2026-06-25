/**
 * dual-task-concurrency-smoke.test.mjs — Minimal static smoke test for
 * dual-task concurrency validation (Task B).
 *
 * Purpose: verify that a non-conflicting, lightweight test file can coexist
 * in the same repository alongside Task A during concurrent GPTWork execution.
 * Uses only static assertions — no network, no business logic mutation.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Static structure assertions
// ---------------------------------------------------------------------------

test("static: expected object structure", () => {
  const dualTaskManifest = {
    task: "B",
    label: "test-path-lightweight-change",
    type: "smoke",
    constraints: {
      noNetwork: true,
      noBusinessLogicMutation: true,
      noDocsOperationsEdit: true,
    },
  };

  assert.equal(dualTaskManifest.task, "B");
  assert.equal(dualTaskManifest.type, "smoke");
  assert.ok(dualTaskManifest.constraints.noNetwork);
  assert.ok(dualTaskManifest.constraints.noBusinessLogicMutation);
  assert.ok(dualTaskManifest.constraints.noDocsOperationsEdit);
});

test("static: string equality and expected values", () => {
  const expectedLabel = "dual-task-concurrency-smoke";
  const label = "dual-task-concurrency-smoke";
  assert.equal(label, expectedLabel);

  const version = "1.0.0";
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
