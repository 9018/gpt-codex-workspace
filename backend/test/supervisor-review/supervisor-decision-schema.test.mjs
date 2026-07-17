/**
 * supervisor-decision-schema.test.mjs — Tests for normalizeSupervisorDecision
 *
 * @module test/supervisor-review/supervisor-decision-schema
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSupervisorDecision,
  DECISION_ACTIONS,
} from "../../src/supervisor-review/supervisor-decision-schema.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseDecision = {
  run_id: "run_1",
  review_revision_id: "rev_abc123",
  verdict: "aligned",
  action: "continue_codex",
};

// Action-specific fixtures for valid-action test
const actionFixtures = {
  continue_codex: {},
  send_correction: {
    correction: { objective: "Fix drift", required_changes: ["Refactor X"] },
  },
  pause_codex: {},
  chatgpt_takeover: {
    takeover: { reason: "Need human help" },
  },
  wait: {},
  evaluate_terminal: {},
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("requires review_revision_id", () => {
  assert.throws(
    () => normalizeSupervisorDecision({ ...baseDecision, review_revision_id: undefined }),
    /review_revision_id is required/
  );
});

test("rejects invalid action", () => {
  assert.throws(
    () => normalizeSupervisorDecision({ ...baseDecision, action: "invalid_action" }),
    /invalid action/
  );
});

test("accepts all valid actions", () => {
  for (const action of DECISION_ACTIONS) {
    const extra = actionFixtures[action] || {};
    const d = normalizeSupervisorDecision({ ...baseDecision, action, ...extra });
    assert.equal(d.action, action, `action ${action} should be accepted`);
  }
});

// ---------------------------------------------------------------------------
// send_correction validation
// ---------------------------------------------------------------------------

test("send_correction requires correction.objective", () => {
  assert.throws(
    () => normalizeSupervisorDecision({
      ...baseDecision,
      action: "send_correction",
      correction: { required_changes: ["fix X"] },
    }),
    /send_correction requires correction\.objective/
  );
});

test("send_correction requires at least one required_change", () => {
  assert.throws(
    () => normalizeSupervisorDecision({
      ...baseDecision,
      action: "send_correction",
      correction: { objective: "Fix drift" },
    }),
    /send_correction requires at least one required_change/
  );
});

test("send_correction accepts valid correction payload", () => {
  const d = normalizeSupervisorDecision({
    ...baseDecision,
    action: "send_correction",
    correction: {
      objective: "Fix architecture drift",
      required_changes: ["Refactor X into Y"],
      observed_drift: ["X should not own Y"],
      forbidden_changes: ["Do not add Z module"],
      allowed_files: ["src/x.mjs"],
      required_commands: ["npm test"],
      completion_evidence: ["All tests pass"],
    },
  });
  assert.equal(d.action, "send_correction");
  assert.equal(d.correction.objective, "Fix architecture drift");
  assert.deepEqual(d.correction.required_changes, ["Refactor X into Y"]);
  assert.deepEqual(d.correction.observed_drift, ["X should not own Y"]);
});

// ---------------------------------------------------------------------------
// takeover validation
// ---------------------------------------------------------------------------

test("chatgpt_takeover requires takeover.reason", () => {
  assert.throws(
    () => normalizeSupervisorDecision({
      ...baseDecision,
      action: "chatgpt_takeover",
      takeover: {},
    }),
    /chatgpt_takeover requires takeover\.reason/
  );
});

test("chatgpt_takeover accepts valid takeover payload", () => {
  const d = normalizeSupervisorDecision({
    ...baseDecision,
    action: "chatgpt_takeover",
    takeover: {
      reason: "Codex stuck on design decision",
      expected_scope: ["Refactor X module"],
      return_conditions: ["All tests pass"],
    },
  });
  assert.equal(d.action, "chatgpt_takeover");
  assert.equal(d.takeover.reason, "Codex stuck on design decision");
  assert.deepEqual(d.takeover.expected_scope, ["Refactor X module"]);
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("normalized decision has required fields", () => {
  const d = normalizeSupervisorDecision(baseDecision);
  assert.equal(d.schema_version, 1);
  assert.equal(d.run_id, "run_1");
  assert.equal(d.review_revision_id, "rev_abc123");
  assert.equal(d.verdict, "aligned");
  assert.equal(typeof d.id, "string");
  assert.equal(typeof d.decided_at, "string");
  assert.equal(d.decided_by, "chatgpt");
});

test("default confidence is medium", () => {
  const d = normalizeSupervisorDecision(baseDecision);
  assert.equal(d.confidence, "medium");
});

test("continue_codex has null correction and takeover", () => {
  const d = normalizeSupervisorDecision(baseDecision);
  assert.equal(d.correction, null);
  assert.equal(d.takeover, null);
});

test("non-correction actions ignore correction fields", () => {
  const d = normalizeSupervisorDecision({
    ...baseDecision,
    correction: { objective: "should be ignored", required_changes: ["X"] },
  });
  assert.equal(d.correction, null);
});
