/**
 * supervisor-command-schema.test.mjs — Tests for commandFromDecision
 *
 * @module test/supervisor-review/supervisor-command-schema
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  commandFromDecision,
  COMMAND_STATES,
} from "../../src/supervisor-review/supervisor-command-schema.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseDecision = {
  id: "dec_1",
  run_id: "run_1",
  review_revision_id: "rev_abc123",
  verdict: "minor_drift",
  action: "send_correction",
  confidence: "high",
  reason_codes: ["ARCH_DEVIATION"],
  analysis_summary: "Minor drift detected in module X",
  correction: {
    objective: "Fix module X drift",
    observed_drift: ["Module X uses wrong pattern"],
    required_changes: ["Refactor X to use Y pattern"],
    forbidden_changes: ["Do not add dependencies"],
    allowed_files: ["src/x.mjs"],
    required_commands: ["npm test"],
    completion_evidence: ["npm test passes"],
  },
  takeover: null,
  decided_by: "chatgpt",
  decided_at: "2026-07-18T00:00:00.000Z",
};

const baseRun = {
  id: "run_1",
  version: 3,
  supervision: {
    controller_owner: "codex_active",
  },
  workspace_ref: { worktree_path: "/home/user/project" },
  active_session_id: "sess_1",
  native_session_id: "ns_1",
};

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("creates command from decision and run", () => {
  const cmd = commandFromDecision(baseDecision, baseRun);
  assert.equal(cmd.run_id, "run_1");
  assert.equal(cmd.decision_id, "dec_1");
  assert.equal(cmd.review_revision_id, "rev_abc123");
  assert.equal(cmd.action, "send_correction");
  assert.equal(cmd.status, "pending");
  assert.equal(cmd.attempt, 0);
  assert.equal(cmd.claimed_by, null);
  assert.equal(typeof cmd.id, "string");
  assert.equal(typeof cmd.created_at, "string");
});

test("command includes preconditions from run", () => {
  const cmd = commandFromDecision(baseDecision, baseRun);
  assert.equal(cmd.preconditions.expected_run_version, 3);
  assert.equal(cmd.preconditions.expected_controller_owner, "codex_active");
  assert.equal(cmd.preconditions.expected_worktree_path, "/home/user/project");
  assert.equal(cmd.preconditions.expected_session_id, "sess_1");
  assert.equal(cmd.preconditions.expected_native_session_id, "ns_1");
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

test("idempotency key is deterministic for same run/revision/action", () => {
  const cmd1 = commandFromDecision(baseDecision, baseRun);
  const cmd2 = commandFromDecision(baseDecision, baseRun);
  assert.equal(cmd1.idempotency_key, cmd2.idempotency_key);
});

test("idempotency key format uses run_id:review_revision_id:action", () => {
  const cmd = commandFromDecision(baseDecision, baseRun);
  assert.equal(cmd.idempotency_key, "run_1:rev_abc123:send_correction");
});

test("different actions produce different idempotency keys", () => {
  const pauseDecision = { ...baseDecision, action: "pause_codex" };
  const cmd1 = commandFromDecision(baseDecision, baseRun);
  const cmd2 = commandFromDecision(pauseDecision, baseRun);
  assert.notEqual(cmd1.idempotency_key, cmd2.idempotency_key);
});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

test("send_correction command includes correction payload", () => {
  const cmd = commandFromDecision(baseDecision, baseRun);
  assert.equal(cmd.payload.objective, "Fix module X drift");
  assert.deepEqual(cmd.payload.required_changes, ["Refactor X to use Y pattern"]);
});

test("pause_codex command has pause payload", () => {
  const pauseDecision = {
    ...baseDecision,
    action: "pause_codex",
    correction: null,
    takeover: null,
  };
  const cmd = commandFromDecision(pauseDecision, baseRun);
  assert.equal(cmd.payload.action, "pause_codex");
});

test("chatgpt_takeover command includes takeover payload", () => {
  const takeoverDecision = {
    ...baseDecision,
    action: "chatgpt_takeover",
    correction: null,
    takeover: {
      reason: "Need human help",
      expected_scope: ["Fix X"],
      return_conditions: ["Tests pass"],
    },
  };
  const cmd = commandFromDecision(takeoverDecision, baseRun);
  assert.equal(cmd.payload.reason, "Need human help");
  assert.deepEqual(cmd.payload.expected_scope, ["Fix X"]);
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

test("COMMAND_STATES includes all expected states", () => {
  assert.ok(COMMAND_STATES.includes("pending"));
  assert.ok(COMMAND_STATES.includes("claimed"));
  assert.ok(COMMAND_STATES.includes("applying"));
  assert.ok(COMMAND_STATES.includes("applied"));
  assert.ok(COMMAND_STATES.includes("retryable_failed"));
  assert.ok(COMMAND_STATES.includes("terminal_failed"));
  assert.ok(COMMAND_STATES.includes("superseded"));
});

test("wait command produces no-op payload", () => {
  const waitDecision = {
    ...baseDecision,
    action: "wait",
    correction: null,
    takeover: null,
  };
  const cmd = commandFromDecision(waitDecision, baseRun);
  assert.equal(cmd.action, "wait");
  assert.deepEqual(cmd.payload, { no_op: true });
});
