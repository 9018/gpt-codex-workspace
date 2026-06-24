import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for task-final-writeback.mjs statusLabel and result.md content.
 *
 * Verifies that:
 * 1. completed → "Completed"
 * 2. failed → "Failed" (not "Completed")
 * 3. timed_out → "Timed out"
 * 4. waiting_for_review → "Waiting for review" (not "Completed")
 */

import { finalizeCodexTaskRun } from "../src/task-final-writeback.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalArgs(taskStatus) {
  const goal = { id: "goal_label_test", workspace_id: "hosted-default" };
  const workspace = { root: "/tmp/test-workspace" };
  const workspaceFiles = {
    result_md: "/tmp/test-result.md",
    dir: "/tmp/test-dir",
  };
  let appendedMessage = null;

  return {
    store: {
      load: async () => ({ tasks: [], goals: [goal], activities: [] }),
      mutate: async (updater) => updater({ tasks: [{ id: "task_label_test", logs: [] }], goals: [goal], activities: [] }),
    },
    config: { defaultWorkspaceRoot: "/tmp" },
    task: { id: "task_label_test", logs: [] },
    taskStatus,
    taskResult: { kind: taskStatus === "timed_out" ? "codex_timeout" : "codex_executed", summary: "Test result", changed_files: [], warnings: [], followups: [] },
    doneAt: new Date().toISOString(),
    cr: { returncode: taskStatus === "completed" ? 0 : 1, timed_out: taskStatus === "timed_out" },
    workspace,
    goal,
    workspaceFiles,
    summary: "Test task result",
    context: {},
    runFilePath: null,
    repoLockPath: null,
    github: { syncTask: async () => {} },
    appendGoalMessageFn: async (store, config, msg) => { appendedMessage = msg; },
    updateGoalStatusFn: async () => {},
    loadRestartMarkerFn: async () => null,
    releaseRepoLockFn: async () => {},
    writeWorkspaceTextInternalFn: async () => {},
    fireHeartbeatFn: async () => {},
  };
}

// Wrapper to capture the writeWorkspaceTextInternal calls
function captureWriteCalls(args) {
  const captured = { mdContent: null, messageContent: null };
  args.writeWorkspaceTextInternalFn = async (store, config, workspaceId, path, content) => {
    captured.mdContent = content;
  };
  args.appendGoalMessageFn = async (store, config, msg) => {
    captured.messageContent = msg;
    args.summary = msg.content || args.summary;
  };
  return captured;
}

// ===========================================================================
// Test: statusLabel for completed
// ===========================================================================

test("task-final-writeback: completed status labels correctly", async () => {
  const args = makeMinimalArgs("completed");
  const captured = captureWriteCalls(args);

  await finalizeCodexTaskRun(args);

  // Goal message should say "Completed task"
  assert.ok(captured.messageContent, "Message should have been captured");
  if (captured.messageContent) {
    assert.match(captured.messageContent.content, /Completed/, "Should say Completed");
  }
});

// ===========================================================================
// Test: statusLabel for failed (must NOT say Completed)
// ===========================================================================

test("task-final-writeback: failed status labels correctly (not Completed)", async () => {
  const args = makeMinimalArgs("failed");
  const captured = captureWriteCalls(args);

  await finalizeCodexTaskRun(args);

  if (captured.messageContent) {
    assert.doesNotMatch(captured.messageContent.content, /Completed/, "Should NOT say Completed");
    assert.match(captured.messageContent.content, /[Ff]ail/, "Should say Failed or similar");
  }

  if (captured.mdContent) {
    assert.doesNotMatch(captured.mdContent, /Completed/, "result.md should NOT say Completed");
  }
});

// ===========================================================================
// Test: statusLabel for timed_out
// ===========================================================================

test("task-final-writeback: timed_out status labels correctly", async () => {
  const args = makeMinimalArgs("timed_out");
  const captured = captureWriteCalls(args);

  await finalizeCodexTaskRun(args);

  if (captured.messageContent) {
    assert.match(captured.messageContent.content, /Timed out/, "Should say Timed out");
  }

  if (captured.mdContent) {
    assert.match(captured.mdContent, /Timed out/, "result.md should say Timed out");
  }
});

// ===========================================================================
// Test: statusLabel for waiting_for_review (must NOT say Completed)
// ===========================================================================

test("task-final-writeback: waiting_for_review status labels correctly (not Completed)", async () => {
  const args = makeMinimalArgs("waiting_for_review");
  const captured = captureWriteCalls(args);

  await finalizeCodexTaskRun(args);

  if (captured.messageContent) {
    assert.doesNotMatch(captured.messageContent.content, /Completed/, "Should NOT say Completed");
    assert.match(captured.messageContent.content, /Waiting for review/, "Should say Waiting for review");
  }

  if (captured.mdContent) {
    assert.doesNotMatch(captured.mdContent, /Completed/, "result.md should NOT say Completed");
  }
});

// ===========================================================================
// Test: statusLabel for unknown status falls through
// ===========================================================================

test("task-final-writeback: unknown status passes through as-is", async () => {
  const args = makeMinimalArgs("some_unknown_status");
  const captured = captureWriteCalls(args);

  await finalizeCodexTaskRun(args);

  if (captured.messageContent) {
    assert.doesNotMatch(captured.messageContent.content, /Completed/, "Should not default to Completed");
  }
});

test("task-final-writeback: git worktree cleanup failure is fail-closed and recorded", async () => {
  let savedTask = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical-repo",
    task_worktree_path: "/tmp/worktrees/repo/task_label_test",
    worktree_lifecycle: { mode: "git_worktree", ok: true },
  };
  args.removeTaskWorktreeFn = async () => ({
    ok: false,
    removed: false,
    error: "worktree remove failed: dirty files",
    command: "git -C /tmp/canonical-repo worktree remove /tmp/worktrees/repo/task_label_test",
    worktree_path: "/tmp/worktrees/repo/task_label_test",
  });

  await finalizeCodexTaskRun(args);

  assert.equal(savedTask.status, "failed");
  assert.equal(savedTask.result.worktree_lifecycle.cleanup_supported, true);
  assert.equal(savedTask.result.worktree_lifecycle.cleanup.ok, false);
  assert.match(savedTask.result.worktree_lifecycle.cleanup.error, /dirty files/);
  assert.ok(savedTask.result.acceptance_findings.some((finding) => finding.code === "git_worktree_cleanup_failed"));
});

test("task-final-writeback: git worktree cleanup does not overwrite repo_resolution lifecycle with metadata-only data", async () => {
  let savedTask = null;
  let fallbackJson = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.workspace = { root: "/tmp/workspace-root" };
  args.taskResult.repo_resolution = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical-repo",
    lock_repo_path: "/tmp/worktrees/repo/task_label_test",
    task_worktree_path: "/tmp/worktrees/repo/task_label_test",
    worktree_lifecycle: {
      mode: "git_worktree",
      ok: true,
      git_worktree_created: true,
      cleanup_supported: true,
      created_during_run: true,
    },
  };
  args.taskResult.worktree_lifecycle = args.taskResult.repo_resolution.worktree_lifecycle;
  args.taskResult.execution_cwd = "/tmp/worktrees/repo/task_label_test";
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical-repo",
    task_worktree_path: "/tmp/worktrees/repo/task_label_test",
    worktree_lifecycle: args.taskResult.repo_resolution.worktree_lifecycle,
  };
  args.removeTaskWorktreeFn = async () => ({
    ok: true,
    removed: true,
    worktree_path: "/tmp/worktrees/repo/task_label_test",
  });
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  await finalizeCodexTaskRun(args);

  assert.equal(savedTask.status, "completed");
  assert.equal(savedTask.result.worktree_lifecycle.mode, "git_worktree");
  assert.equal(savedTask.result.worktree_lifecycle.ok, true);
  assert.equal(savedTask.result.worktree_lifecycle.cleanup_supported, true);
  assert.equal(savedTask.result.worktree_lifecycle.cleanup.ok, true);
  assert.equal(savedTask.result.repo_resolution.worktree_lifecycle.mode, "git_worktree");
  assert.equal(savedTask.result.repo_resolution.worktree_lifecycle.cleanup.ok, true);
  assert.equal(savedTask.result.repo_resolution.worktree_lifecycle.created_during_run, true);
  assert.equal(fallbackJson.repo_resolution.worktree_lifecycle.mode, "git_worktree");
  assert.equal(fallbackJson.repo_resolution.worktree_lifecycle.cleanup.ok, true);
  assert.equal(fallbackJson.execution_cwd_proof.used_task_worktree_path, true);
});

// ===========================================================================
// Test: resultJsonPath param overrides local derivation
// ===========================================================================

test("task-final-writeback: passed resultJsonPath used for fallback write", async () => {
  let fallbackPath = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      return updater(state);
    },
  };
  args.writeFileFn = async (path, content) => {
    fallbackPath = path;
  };
  // Pass a custom resultJsonPath
  args.resultJsonPath = "/custom/path/result.json";

  await finalizeCodexTaskRun(args);
  assert.equal(fallbackPath, "/custom/path/result.json", "should write to passed resultJsonPath");
});

test("task-final-writeback: passed resultJsonPath used in heartbeat", async () => {
  let heartbeatResultJsonPath = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      return updater(state);
    },
  };
  args.writeFileFn = async () => {};
  args.fireHeartbeatFn = async (runPath, status, meta) => {
    heartbeatResultJsonPath = meta.result_json_path;
  };
  args.runFilePath = "/some/run/file.json";
  args.resultJsonPath = "/custom/heartbeat/result.json";

  await finalizeCodexTaskRun(args);
  assert.equal(heartbeatResultJsonPath, "/custom/heartbeat/result.json", "heartbeat should use passed resultJsonPath");
});

test("task-final-writeback: evidence_paths included in fallback result.json", async () => {
  let savedData = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      return updater(state);
    },
  };
  args.writeFileFn = async (path, content) => {
    savedData = JSON.parse(content);
  };
  args.resultJsonPath = "/custom/result.json";
  args.taskResult.evidence_paths = {
    implementation_diff_patch: "/path/to/implementation-diff.patch",
    verification_log: "/path/to/verification.log",
    acceptance_evidence_json: "/path/to/acceptance.evidence.json",
  };

  await finalizeCodexTaskRun(args);
  assert.ok(savedData, "should have written result.json");
  assert.equal(savedData.evidence_paths.implementation_diff_patch, "/path/to/implementation-diff.patch");
  assert.equal(savedData.evidence_paths.verification_log, "/path/to/verification.log");
  assert.equal(savedData.evidence_paths.acceptance_evidence_json, "/path/to/acceptance.evidence.json");
});

console.log("task-final-writeback tests loaded");
