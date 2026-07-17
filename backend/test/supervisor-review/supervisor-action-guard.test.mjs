/**
 * supervisor-action-guard.test.mjs — Tests for Action Guard
 *
 * @module test/supervisor-review/supervisor-action-guard
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createActionGuard } from "../../src/supervisor-review/supervisor-action-guard.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCommand = {
  id: "cmd_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
  action: "send_correction",
  preconditions: {
    expected_run_version: 3,
    expected_controller_owner: "codex_active",
    expected_worktree_path: "/home/user/project",
    expected_session_id: "sess_1",
    expected_native_session_id: "ns_1",
  },
};

const run = {
  id: "run_1",
  version: 3,
  state: "running",
  supervision: {
    controller_owner: "codex_active",
    correction_cycles: 1,
    same_failure_retries: 0,
    chatgpt_takeover_count: 0,
  },
};

const lease = {
  owner: "codex_active",
  epoch: 0,
};

const currentRevision = {
  id: "rev_001",
  run_id: "run_1",
};

const plan = {
  autonomy_budget: {
    max_corrections: 5,
    max_attempts: 3,
  },
};

// ---------------------------------------------------------------------------
// Valid command
// ---------------------------------------------------------------------------

test("passes valid send_correction command", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: validCommand,
    run,
    lease,
    currentRevision,
    plan,
  });
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// Stale revision
// ---------------------------------------------------------------------------

test("rejects command with stale revision", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: { ...validCommand, review_revision_id: "rev_old" },
    run,
    lease,
    currentRevision: { id: "rev_current" },
    plan,
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Run version
// ---------------------------------------------------------------------------

test("rejects command when run version is outdated", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: {
      ...validCommand,
      preconditions: { ...validCommand.preconditions, expected_run_version: 5 },
    },
    run,
    lease,
    currentRevision,
    plan,
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Controller ownership
// ---------------------------------------------------------------------------

test("rejects command when controller owner mismatch", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: {
      ...validCommand,
      preconditions: { ...validCommand.preconditions, expected_controller_owner: "chatgpt_direct" },
    },
    run,
    lease: { owner: "codex_active", epoch: 0 },
    currentRevision,
    plan,
  });
  assert.equal(result.valid, false);
});

test("rejects command when controller owner changed via transition", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: validCommand,
    run: { ...run, supervision: { ...run.supervision, controller_owner: "codex_quiescing" } },
    lease: { owner: "codex_quiescing", epoch: 1 },
    currentRevision,
    plan,
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test("rejects command when correction budget exhausted", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: validCommand,
    run: {
      ...run,
      supervision: { ...run.supervision, correction_cycles: 5 },
    },
    lease,
    currentRevision,
    plan: {
      autonomy_budget: { max_corrections: 5, max_attempts: 3 },
    },
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Action allowed for run state
// ---------------------------------------------------------------------------

test("rejects send_correction when run is in terminal state", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: validCommand,
    run: { ...run, state: "completed" },
    lease,
    currentRevision,
    plan,
  });
  assert.equal(result.valid, false);
});

test("rejects send_correction when run is in waiting_for_review state", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: validCommand,
    run: { ...run, state: "waiting_for_review" },
    lease,
    currentRevision,
    plan,
  });
  assert.equal(result.valid, false);
});
