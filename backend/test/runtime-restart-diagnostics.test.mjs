import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateProposal } from "../src/workflow-state-service.mjs";
import { reconcilePendingRestartMarkers } from "../src/diagnostics-restart-markers.mjs";
import { collectRuntimeGitInfo } from "../src/diagnostics-runtime.mjs";

// =========================================================================
// C1: Runtime mismatch detection in generateProposal
// =========================================================================

function makeBaseDiagnostics(overrides = {}) {
  return {
    workflow_id: "test",
    latest_task: null,
    runtime: {
      running_commit: null,
      repo_head: null,
      remote_head: null,
      restart_required: false,
    },
    worktree: { dirty: false, dirty_paths: [] },
    repo_locks: { active: 0, stale: 0, details: [] },
    worker: {
      enabled: false,
      running: false,
      last_error: null,
      started_at: null,
      error_count: 0,
      consecutive_errors: 0,
      assignment_counter: 0,
      current_task_id: null,
      current_task_started_at: null,
      recovery_running: false,
    },
    queue: {
      assigned: 0,
      queued: 0,
      running: 0,
      waiting_for_lock: 0,
      waiting_for_review: 0,
      completed: 0,
      failed: 0,
      total: 0,
    },
    ...overrides,
  };
}

test("generateProposal: runtime mismatch blocks with runtime_restart_required reason", () => {
  const diagnostics = makeBaseDiagnostics({
    runtime: {
      running_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repo_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      remote_head: null,
      restart_required: true,
    },
  });
  const result = generateProposal({
    diagnostics,
    task: null,
    manualVerdict: null,
    manualNote: null,
  });
  assert.equal(result.next_action, "blocked");
  assert.ok(result.recommendation.includes("runtime restart required"), 
    `recommendation should mention runtime restart: ${result.recommendation}`);
  assert.ok(result.recommendation.includes("running_commit"),
    `recommendation should mention running_commit`);
  assert.ok(result.needs_gptchat_decision, true);
});

test("generateProposal: restart_required=false passes isSafe check", () => {
  const diagnostics = makeBaseDiagnostics({
    runtime: {
      running_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repo_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remote_head: null,
      restart_required: false,
    },
  });
  const result = generateProposal({
    diagnostics,
    task: null,
    manualVerdict: null,
    manualNote: null,
  });
  // No task + no runtime mismatch => needs_gptchat_decision
  assert.equal(result.next_action, "needs_gptchat_decision");
  assert.equal(result.needs_gptchat_decision, true);
});

test("generateProposal: runtime mismatch not flagged when commits match", () => {
  const diagnostics = makeBaseDiagnostics({
    runtime: {
      running_commit: "cccccccccccccccccccccccccccccccccccccccc",
      repo_head: "cccccccccccccccccccccccccccccccccccccccc",
      remote_head: null,
      restart_required: false,
    },
  });
  const result = generateProposal({
    diagnostics,
    task: null,
    manualVerdict: null,
    manualNote: null,
  });
  assert.equal(result.next_action, "needs_gptchat_decision");
  assert.ok(!result.recommendation.includes("runtime restart"));
});

test("generateProposal: runtime mismatch + worktree dirty shows both reasons", () => {
  const diagnostics = makeBaseDiagnostics({
    runtime: {
      running_commit: "aaa",
      repo_head: "bbb",
      restart_required: true,
    },
    worktree: { dirty: true, dirty_paths: ["file1.js"] },
  });
  const result = generateProposal({
    diagnostics,
    task: null,
    manualVerdict: null,
    manualNote: null,
  });
  assert.equal(result.next_action, "blocked");
  assert.ok(result.recommendation.includes("runtime restart"));
  assert.ok(result.recommendation.includes("dirty"));
});

// =========================================================================
// C2: collectRuntimeGitInfo — basic mismatch detection
// =========================================================================

test("collectRuntimeGitInfo returns running_commit and repo_head", () => {
  const info = collectRuntimeGitInfo(".");
  assert.ok(info.running_commit || info.repo_head, "should have at least one commit");
  assert.equal(typeof info.worktree_dirty, "boolean");
  assert.ok(Array.isArray(info.dirty_paths));
});

test("collectRuntimeGitInfo: null repoDir returns null values", () => {
  const info = collectRuntimeGitInfo(null);
  assert.equal(info.repo_head, null);
  assert.equal(info.running_commit, null);
  assert.equal(info.remote_head, null);
});

// =========================================================================
// C3: reconcilePendingRestartMarkers — basic behavior
// =========================================================================

test("reconcilePendingRestartMarkers: empty workspace returns zero counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-reconcile-"));
  try {
    const result = await reconcilePendingRestartMarkers(root, null);
    assert.equal(result.verified, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.active_after, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcilePendingRestartMarkers: non-existent workspace root handles gracefully", async () => {
  const result = await reconcilePendingRestartMarkers("/tmp/nonexistent-gptwork-reconcile-" + Date.now(), null);
  assert.equal(result.verified, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.active_after, 0);
});

// =========================================================================
// C4: Diagnostics classification mention in workflow_state
// =========================================================================

test("workflow diagnostics runtime.restart_required computed correctly", () => {
  const diag1 = makeBaseDiagnostics({
    runtime: { running_commit: "a1", repo_head: "a1", restart_required: false },
  });
  // When both equal, restart_required should be false
  assert.equal(diag1.runtime.restart_required, false);

  const diag2 = makeBaseDiagnostics({
    runtime: { running_commit: "a1", repo_head: "b2", restart_required: true },
  });
  // When different, restart_required should be true
  assert.equal(diag2.runtime.restart_required, true);
});

test("generateProposal: task with runtime restart blocks proposal", () => {
  // Completed task but runtime_restart_required = true
  const diagnostics = makeBaseDiagnostics({
    runtime: {
      running_commit: "old_commit",
      repo_head: "new_commit",
      restart_required: true,
    },
  });
  const task = {
    id: "test_task_1",
    title: "Test Task",
    status: "completed",
    result: {
      summary: "Task completed",
      commit: "new_commit",
      tests: "passed",
      verification: { passed: true, commands: [] },
      reviewer_decision: { passed: true },
      acceptance_findings: [],
    },
  };
  const result = generateProposal({
    diagnostics,
    task,
    manualVerdict: "passed",
    manualNote: null,
  });
  // Should be blocked because restart_required = true
  assert.equal(result.next_action, "blocked", 
    `restart_required should block even completed tasks, got: ${result.next_action}`);
  assert.ok(result.recommendation.includes("runtime restart") || result.needs_gptchat_decision,
    "recommendation should indicate restart needed");
});
