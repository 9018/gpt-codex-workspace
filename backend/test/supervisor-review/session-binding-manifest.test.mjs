/**
 * session-binding-manifest.test.mjs — Tests for Session Binding Manifest
 *
 * @module test/supervisor-review/session-binding-manifest
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSessionBinding, assertSessionBinding } from "../../src/codex-tui/session-binding-manifest.mjs";

// ---------------------------------------------------------------------------
// createSessionBinding
// ---------------------------------------------------------------------------

test("creates a session binding with required fields", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    taskId: "task_1",
    goalId: "goal_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
    nativeSessionId: "ns_1",
  });

  assert.equal(binding.run_id, "run_1");
  assert.equal(binding.attempt_id, "attempt_1");
  assert.equal(binding.task_id, "task_1");
  assert.equal(binding.goal_id, "goal_1");
  assert.equal(binding.worktree_path, "/home/user/project");
  assert.equal(binding.control_session_id, "sess_1");
  assert.equal(binding.native_session_id, "ns_1");
  assert.equal(binding.resume_token, null);
  assert.equal(binding.codex_home, null);
  assert.equal(typeof binding.started_at, "string");
  assert.equal(typeof binding.last_bound_at, "string");
});

test("creates binding with optional fields", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
    resumeToken: "token_123",
    codexHome: "/home/user/.codex",
  });

  assert.equal(binding.resume_token, "token_123");
  assert.equal(binding.codex_home, "/home/user/.codex");
});

// ---------------------------------------------------------------------------
// assertSessionBinding
// ---------------------------------------------------------------------------

test("assertSessionBinding passes for matching binding and run", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
  });

  const run = {
    id: "run_1",
    active_attempt_id: "attempt_1",
    workspace_ref: { worktree_path: "/home/user/project" },
  };

  assertSessionBinding({ binding, run }); // should not throw
});

test("assertSessionBinding throws for run_id mismatch", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
  });

  const run = { id: "run_2", active_attempt_id: "attempt_1", workspace_ref: { worktree_path: "/home/user/project" } };

  assert.throws(() => assertSessionBinding({ binding, run }), /run_id/);
});

test("assertSessionBinding throws for worktree mismatch", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
  });

  const run = { id: "run_1", active_attempt_id: "attempt_1", workspace_ref: { worktree_path: "/home/user/other" } };

  assert.throws(() => assertSessionBinding({ binding, run }), /worktree/);
});

test("assertSessionBinding throws for attempt_id mismatch", () => {
  const binding = createSessionBinding({
    runId: "run_1",
    attemptId: "attempt_1",
    worktreePath: "/home/user/project",
    controlSessionId: "sess_1",
  });

  const run = { id: "run_1", active_attempt_id: "attempt_2", workspace_ref: { worktree_path: "/home/user/project" } };

  assert.throws(() => assertSessionBinding({ binding, run }), /attempt/);
});
