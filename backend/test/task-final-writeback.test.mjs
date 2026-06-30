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
    verifyTaskCompletionFn: async () => ({
      passed: true,
      status: "completed",
      commands: [],
      changed_files: [],
      reason_no_tests: null,
      failure_class: null,
      requires_review: false,
      findings: [],
    }),
    autoStartNextOnTaskCompletedFn: async () => ({ auto_started: false, details: [] }),
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
    task_worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    worktree_lifecycle: { mode: "git_worktree", ok: true },
  };
  args.removeTaskWorktreeFn = async () => ({
    ok: false,
    removed: false,
    error: "worktree remove failed: dirty files",
    command: "git -C /tmp/canonical-repo worktree remove /tmp/.gptwork/worktrees/repo/task_label_test",
    worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
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
    lock_repo_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    task_worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    worktree_lifecycle: {
      mode: "git_worktree",
      ok: true,
      git_worktree_created: true,
      cleanup_supported: true,
      created_during_run: true,
    },
  };
  args.taskResult.worktree_lifecycle = args.taskResult.repo_resolution.worktree_lifecycle;
  args.taskResult.execution_cwd = "/tmp/.gptwork/worktrees/repo/task_label_test";
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical-repo",
    task_worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    worktree_lifecycle: args.taskResult.repo_resolution.worktree_lifecycle,
  };
  args.removeTaskWorktreeFn = async () => ({
    ok: true,
    removed: true,
    worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
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

test("task-final-writeback: persists spec-shaped task.worktree record", async () => {
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
  args.taskResult.repo_resolution = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical-repo",
    lock_repo_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    task_worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    worktree_lifecycle: {
      mode: "git_worktree",
      ok: true,
      worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test",
      branch_name: "gptwork/task/task_label_test",
      base_ref: "main",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
    },
  };
  args.taskResult.worktree_lifecycle = args.taskResult.repo_resolution.worktree_lifecycle;
  args.resolvedRepo = args.taskResult.repo_resolution;
  args.removeTaskWorktreeFn = async () => ({ ok: true, removed: true, worktree_path: "/tmp/.gptwork/worktrees/repo/task_label_test" });

  await finalizeCodexTaskRun(args);

  assert.deepEqual(savedTask.worktree, {
    enabled: true,
    path: "/tmp/.gptwork/worktrees/repo/task_label_test",
    branch: "gptwork/task/task_label_test",
    base_ref: "main",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    status: "removed",
  });
  assert.equal(savedTask.execution_mode, "worktree");
  assert.equal(savedTask.attempt, 0);
  assert.equal(savedTask.max_attempts, 2);
});

test("task-final-writeback: completed integrated task normalizes stale restart and integration flags", async () => {
  let savedTask = null;
  let fallbackJson = null;
  const head = "95577ea08ae68c1cf2234f220099ed2b8865ae84";
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_fa4ac8ee", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.task = { id: "task_fa4ac8ee", logs: [], title: "P0 completed integrated task" };
  args.taskResult = {
    kind: "codex_executed",
    status: "completed",
    summary: "Completed and integrated",
    changed_files: ["backend/src/example.mjs"],
    tests: "node --test backend/test/example.test.mjs: passed",
    commit: head,
    local_head: head,
    remote_head: head,
    running_commit: head,
    repo_head: head,
    restart_verified_at: "2026-06-27T20:00:00.000Z",
    restart_state: "verified",
    post_restart_verified: true,
    integration: { status: "merged", merged: true, commit: head },
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    warnings: [
      "Worktree retained: /tmp/worktree (status=waiting_for_review)",
      "ordinary warning",
    ],
    acceptance_findings: [],
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [{ cmd: "node --test", exit_code: 0 }],
    changed_files: ["backend/src/example.mjs"],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
  });
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  await finalizeCodexTaskRun(args);

  assert.equal(savedTask.status, "completed");
  assert.equal(savedTask.result.needs_integration, false);
  assert.equal(savedTask.result.needs_restart_check, false);
  assert.equal(savedTask.result.delivery_state_normalized, true);
  assert.equal(savedTask.result.closure_path, "complete");
  assert.equal(savedTask.result.closure_summary.includes("Restart check: not required"), true);
  assert.deepEqual(savedTask.result.warnings, ["ordinary warning"]);
  assert.equal(fallbackJson.needs_integration, false);
  assert.equal(fallbackJson.needs_restart_check, false);
  assert.deepEqual(fallbackJson.warnings, ["ordinary warning"]);
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

test("task-final-writeback: independent verifier can demote completed task before persistence", async () => {
  let savedTask = null;
  let verificationJson = null;
  const args = makeMinimalArgs("completed");
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.taskResult.verification = { passed: false, commands: [] };
  args.resultJsonPath = "/tmp/test-workspace/.gptwork/goals/goal_label_test/result.json";
  args.verifyTaskCompletionFn = async ({ resultJson, repoPath }) => {
    assert.equal(resultJson.status, "completed");
    assert.equal(repoPath, "/tmp/test-workspace");
    return {
      passed: false,
      status: "waiting_for_review",
      commands: [],
      changed_files: [],
      reason_no_tests: null,
      failure_class: "verification_failed",
      requires_review: true,
      findings: [{ severity: "blocker", code: "verification_failed", message: "failed", source: "test" }],
    };
  };
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/verification.json")) verificationJson = JSON.parse(content);
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "waiting_for_review");
  assert.equal(savedTask.status, "waiting_for_review");
  assert.equal(savedTask.result.verification.passed, false);
  assert.ok(savedTask.result.acceptance_findings.some((finding) => finding.code === "verification_failed"));
  assert.equal(verificationJson.passed, false);
});

test("task-final-writeback: completed task triggers queue autostart hook", async () => {
  const args = makeMinimalArgs("completed");
  let autoStartedTask = null;
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_label_test", logs: [] }], goals: [args.goal], activities: [] };
      return updater(state);
    },
  };
  args.taskResult.verification = { passed: true, commands: [] };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [],
    changed_files: [],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
  });
  args.autoStartNextOnTaskCompletedFn = async (store, config, completedTask) => {
    autoStartedTask = completedTask;
    return { auto_started: true, details: [{ type: "auto_start_next", started: true }] };
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(autoStartedTask.id, "task_label_test");
  assert.equal(result.auto_start.auto_started, true);
});

test("task-final-writeback: quality notes produce completed closure with next_tasks", async () => {
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
  args.goal.acceptance_contract = {
    intent: { operation_kind: "diagnostic", semantic_confidence: "high" },
    requirements: { requires_commit: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "Diagnostic completed",
    operation_kind: "diagnostic",
    diagnostic_evidence: { summary: "No mutation", repo_mutated: false },
    repo_mutated: false,
    changed_files: [],
    warnings: [],
    followups: [],
    verification: { passed: true, commands: [] },
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [{ cmd: "diagnostic-check", exit_code: 0 }],
    changed_files: [],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
    contract_verification: {
      contract_valid: true,
      blocking_passed: true,
      acceptance_status: "satisfied",
      completion_eligible: true,
      blockers: [],
      non_blocking_followups: [],
      quality_notes: ["Add more diagnostic fixture coverage."],
      state_assertions: { passed: true, failures: [] },
    },
  });
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(savedTask.status, "completed");
  assert.equal(savedTask.result.closure_decision.status, "auto_completed_with_followups");
  assert.equal(savedTask.result.requires_review, false);
  assert.equal(savedTask.result.next_tasks.length, 1);
  assert.equal(savedTask.result.next_tasks[0].severity, "non_blocking");
  assert.equal(savedTask.result.next_tasks[0].auto_enqueue, false);
  assert.equal(fallbackJson.closure_decision.status, "auto_completed_with_followups");
  assert.equal(fallbackJson.next_tasks.length, 1);
});

test("task-final-writeback: semantic ambiguity remains waiting_for_review", async () => {
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
  args.goal.acceptance_contract = {
    intent: { operation_kind: "code_change", semantic_confidence: "low" },
    requirements: { requires_commit: true },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "Needs semantic review",
    operation_kind: "code_change",
    changed_files: ["src/app.mjs"],
    commit: "abc123",
    warnings: [],
    followups: [],
    verification: { passed: true, commands: [] },
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [{ cmd: "check", exit_code: 0 }],
    changed_files: ["src/app.mjs"],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
    contract_verification: {
      contract_valid: true,
      blocking_passed: true,
      acceptance_status: "indeterminate",
      completion_eligible: true,
      blockers: [],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, failures: [] },
    },
  });

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "waiting_for_review");
  assert.equal(savedTask.status, "waiting_for_review");
  assert.equal(savedTask.result.closure_decision.status, "requires_review");
  assert.equal(savedTask.result.requires_review, true);
});

test("task-final-writeback: waiting_for_integration branch_pushed does NOT mark completed", async () => {
  // P0: When finalizer runs integration and gets branch_pushed (NOT merged),
  // taskStatus must NOT become "completed"
  let savedTask = null;
  const args = makeMinimalArgs("waiting_for_integration");
  args.task = { id: "task_wfi_branch_pushed", logs: [] };
  args.goal = { id: "goal_wfi_branch_pushed", workspace_id: "hosted-default" };
  // Override store to capture saved task
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_wfi_branch_pushed", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { mode: "git_worktree", ok: true, branch_name: "gptwork/task/test" },
  };
  args.runIntegrationQueueFn = async () => {
    // Simulate push_branch mode: NOT merged
    return { ok: true, status: "branch_pushed", merged: false, pushed: true, pr_opened: false };
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true, status: "completed", commands: [], changed_files: [], reason_no_tests: null,
    failure_class: null, requires_review: false, findings: [],
  });
  args.autoStartNextOnTaskCompletedFn = async () => ({ auto_started: false, details: [] });
  args.github = { syncTask: async () => {} };
  args.workspaceFiles = { result_md: "/tmp/test.md", dir: "/tmp/test" };

  await finalizeCodexTaskRun(args);

  // Branch pushed with merged:false should NOT set task completed
  assert.notEqual(savedTask.status, "completed", "branch_pushed finalizer should NOT set completed");
  assert.equal(savedTask.status, "waiting_for_review", "branch_pushed finalizer should set waiting_for_review");
  assert.equal(savedTask.result.integration.status, "branch_pushed");
});

test("task-final-writeback: waiting_for_integration branch_pushed auto completion marks completed", async () => {
  let savedTask = null;
  let removedWorktree = false;
  const args = makeMinimalArgs("waiting_for_integration");
  args.task = { id: "task_wfi_branch_pushed_auto", logs: [] };
  args.goal = { id: "goal_wfi_branch_pushed_auto", workspace_id: "hosted-default" };
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_wfi_branch_pushed_auto", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { mode: "git_worktree", ok: true, branch_name: "gptwork/task/test" },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "Test result",
    changed_files: ["src/app.mjs"],
    commit: "commit123",
    local_head: "commit123",
    warnings: [],
    followups: [],
    verification: { passed: true, findings: [] },
    reviewer_decision: { decision: { passed: true } },
  };
  args.runIntegrationQueueFn = async () => ({ ok: true, status: "branch_pushed", merged: false, pushed: true, pr_opened: false });
  args.runAutoIntegrationCompletionFn = async () => ({
    attempted: true,
    eligible: true,
    completed: true,
    reason: "ff_only_merged_and_verified",
    blockers: [],
    warnings: [],
    commit: "commit123",
    verification_report_path: "/tmp/report.json",
    verification_report: { passed: true, profile: "changed", head: "commit123", dirty: false, steps: 2 },
    commands: [{ cmd: "node scripts/release-delivery-check.mjs --profile changed", exit_code: 0 }],
  });
  args.verifyTaskCompletionFn = async () => ({
    passed: true, status: "completed", commands: [], changed_files: [], reason_no_tests: null,
    failure_class: null, requires_review: false, findings: [],
  });
  args.removeTaskWorktreeFn = async () => {
    removedWorktree = true;
    return { ok: true, removed: true, worktree_path: "/tmp/worktree" };
  };
  args.autoStartNextOnTaskCompletedFn = async () => ({ auto_started: false, details: [] });
  args.github = { syncTask: async () => {} };
  args.workspaceFiles = { result_md: "/tmp/test.md", dir: "/tmp/test" };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(savedTask.status, "completed");
  assert.equal(savedTask.result.integration.status, "merged");
  assert.equal(savedTask.result.integration.auto_completed, true);
  assert.equal(savedTask.result.auto_integration_completion.completed, true);
  assert.equal(savedTask.result.needs_integration, false);
  assert.equal(removedWorktree, true);
});

test("task-final-writeback: waiting_for_integration merged -> completed", async () => {
  // P0: When finalizer runs integration and gets merged, task should complete
  let savedTask = null;
  const args = makeMinimalArgs("waiting_for_integration");
  args.task = { id: "task_wfi_merged", logs: [] };
  args.goal = { id: "goal_wfi_merged", workspace_id: "hosted-default" };
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: "task_wfi_merged", logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { mode: "git_worktree", ok: true, branch_name: "gptwork/task/test" },
  };
  args.runIntegrationQueueFn = async () => {
    // Simulate local_merge mode: actually merged
    return { ok: true, status: "merged", merged: true };
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true, status: "completed", commands: [], changed_files: [], reason_no_tests: null,
    failure_class: null, requires_review: false, findings: [],
  });
  args.autoStartNextOnTaskCompletedFn = async () => ({ auto_started: false, details: [] });
  args.github = { syncTask: async () => {} };
  args.workspaceFiles = { result_md: "/tmp/test.md", dir: "/tmp/test" };

  await finalizeCodexTaskRun(args);

  // Merged should set task completed
  assert.equal(savedTask.status, "completed", "merged integration should set completed");
  assert.equal(savedTask.result.integration.status, "merged");
});

test("task-final-writeback: synchronizes queue item for terminal and waiting states", async () => {
  for (const status of ["completed", "failed", "waiting_for_review", "waiting_for_repair", "waiting_for_integration"]) {
    let savedState = null;
    const args = makeMinimalArgs(status);
    args.goal = { id: `goal_${status}`, workspace_id: "hosted-default", title: status };
    args.task = { id: `task_${status}`, goal_id: args.goal.id, logs: [] };
    args.store = {
      mutate: async (updater) => {
        const state = {
          tasks: [{ id: args.task.id, goal_id: args.goal.id, logs: [] }],
          goals: [args.goal],
          goal_queue: [{ queue_id: `queue_${status}`, goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
          activities: [],
        };
        const result = await updater(state);
        savedState = state;
        return result;
      },
    };
    args.taskResult = {
      kind: "codex_executed",
      summary: `${status} summary`,
      changed_files: [],
      warnings: [],
      followups: [],
      reason: status === "waiting_for_repair" ? "verification_failed: Repair attempt 1/2" : undefined,
      failure_class: status === "waiting_for_repair" ? "verification_failed" : null,
    };
    args.verifyTaskCompletionFn = async () => ({
      passed: true,
      status: "completed",
      commands: [],
      changed_files: [],
      reason_no_tests: null,
      failure_class: null,
      requires_review: false,
      findings: [],
    });
    args.autoStartNextOnTaskCompletedFn = async () => ({ auto_started: false, details: [] });

    await finalizeCodexTaskRun(args);

    const queueItem = savedState.goal_queue[0];
    assert.equal(queueItem.status, status);
    assert.equal(queueItem.completed_task_id, args.task.id);
    assert.equal(savedState.tasks[0].status, status);
    const expectedGoalStatus = status === "failed" || status === "timed_out" ? "waiting_for_repair" : status;
    assert.equal(savedState.goals[0].status, expectedGoalStatus);
  }
});

test("task-final-writeback: completed task without evidence does not auto-complete linked goal", async () => {
  let savedState = null;
  const args = makeMinimalArgs("completed");
  args.goal = { id: "goal_evidence_gate", workspace_id: "hosted-default", title: "Evidence gate", status: "running" };
  args.task = { id: "task_evidence_gate", goal_id: args.goal.id, logs: [] };
  args.store = {
    mutate: async (updater) => {
      const state = {
        tasks: [{ id: args.task.id, goal_id: args.goal.id, logs: [] }],
        goals: [args.goal],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "missing acceptance evidence",
    changed_files: ["backend/src/app.mjs"],
    warnings: [],
    followups: [],
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: false,
    status: "waiting_for_review",
    commands: [],
    changed_files: ["backend/src/app.mjs"],
    reason_no_tests: null,
    failure_class: "unknown",
    requires_review: true,
    findings: [],
  });
  args.shouldAttemptRepairFn = () => ({ should_repair: false, reason: "not repairable" });

  await finalizeCodexTaskRun(args);

  assert.equal(savedState.tasks[0].status, "waiting_for_review");
  assert.equal(savedState.goals[0].status, "waiting_for_review");
});

test("task-final-writeback: verification failure creates repair goal and records repair ids", async () => {
  let savedState = null;
  const args = makeMinimalArgs("completed");
  args.task = {
    id: "task_repair_writeback",
    goal_id: args.goal.id,
    title: "Original task",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
    logs: [],
  };
  args.store = {
    mutate: async (updater) => {
      const state = {
        tasks: [{ ...args.task, logs: [] }],
        goals: [args.goal],
        goal_queue: [{ queue_id: "queue_repair_writeback", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = { kind: "codex_executed", summary: "needs repair", changed_files: ["src/app.mjs"], warnings: [], followups: [] };
  args.config.maxRepairAttempts = 2;
  args.verifyTaskCompletionFn = async () => ({
    passed: false,
    status: "waiting_for_review",
    commands: [{ cmd: "npm test", exit_code: 1, stdout_tail: "", stderr_tail: "failed" }],
    changed_files: ["src/app.mjs"],
    reason_no_tests: null,
    failure_class: "verification_failed",
    requires_review: true,
    findings: [{ severity: "blocker", code: "verification_failed", message: "Tests failed", source: "test" }],
  });
  args.createGoalFn = async (store, config, payload) => {
    assert.match(payload.user_request, /^Repair:/);
    return { goal: { id: "goal_repair_created" }, task: { id: "task_repair_created" } };
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "waiting_for_repair");
  assert.equal(savedState.tasks[0].status, "waiting_for_repair");
  assert.equal(savedState.goal_queue[0].status, "waiting_for_repair");
  assert.equal(savedState.tasks[0].result.repair_goal_id, "goal_repair_created");
  assert.equal(savedState.tasks[0].result.repair_task_id, "task_repair_created");
  assert.equal(savedState.tasks[0].result.repair_goal.parent_task_id, "task_repair_writeback");
  assert.equal(savedState.tasks[0].result.failure_class, "test_failed");
  assert.equal(savedState.tasks[0].result.repair_goal.attempt, 1);
  assert.equal(savedState.tasks[0].result.repair_goal.repair_of_attempt, 0);
  assert.ok(savedState.tasks[0].logs.some((log) => /failure_class=test_failed attempt=0 repair_of_attempt=0/.test(log.message)));
});

test("task-final-writeback: repeat verification failure after max attempts waits for review", async () => {
  let savedState = null;
  let createGoalCalled = false;
  const args = makeMinimalArgs("completed");
  args.goal = { id: "goal_repair_max", workspace_id: "hosted-default", title: "Repair max" };
  args.task = {
    id: "task_repair_max",
    goal_id: args.goal.id,
    title: "Repair max task",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
    attempt: 1,
    max_attempts: 2,
    repair_attempt: 1,
    logs: [],
  };
  args.store = {
    mutate: async (updater) => {
      const state = {
        tasks: [{ ...args.task, logs: [] }],
        goals: [args.goal],
        goal_queue: [{ queue_id: "queue_repair_max", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = { kind: "codex_executed", summary: "still failing", changed_files: ["src/app.mjs"], warnings: [], followups: [] };
  args.config.maxRepairAttempts = 2;
  args.verifyTaskCompletionFn = async () => ({
    passed: false,
    status: "waiting_for_review",
    commands: [{ cmd: "npm test", exit_code: 1, stdout_tail: "", stderr_tail: "failed again" }],
    changed_files: ["src/app.mjs"],
    reason_no_tests: null,
    requires_review: true,
    findings: [{ severity: "blocker", code: "verification_command_failed", message: "npm test failed", source: "test" }],
  });
  args.createGoalFn = async () => {
    createGoalCalled = true;
    throw new Error("should not create repair after max attempts");
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "waiting_for_review");
  assert.equal(savedState.tasks[0].status, "waiting_for_review");
  assert.equal(savedState.goal_queue[0].status, "waiting_for_review");
  assert.equal(savedState.tasks[0].result.failure_class, "test_failed");
  assert.match(savedState.tasks[0].result.repair_denied_reason, /Max attempts reached/);
  assert.equal(createGoalCalled, false);
  assert.ok(savedState.tasks[0].logs.some((log) => /failure_class=test_failed attempt=1 repair_of_attempt=none/.test(log.message)));
});

test("task-final-writeback: failed missing result with verified commit writes fallback result and completes", async () => {
  let savedState = null;
  let fallbackJson = null;
  const args = makeMinimalArgs("failed");
  args.goal = { id: "goal_verified_writeback", workspace_id: "hosted-default", title: "Verified writeback" };
  args.task = { id: "task_verified_writeback", goal_id: args.goal.id, logs: [] };
  args.store = {
    mutate: async (updater) => {
      const state = {
        tasks: [{ id: args.task.id, goal_id: args.goal.id, logs: [] }],
        goals: [args.goal],
        goal_queue: [{ queue_id: "queue_verified_writeback", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = {
    kind: "codex_failed",
    summary: "Codex execution failed (non-zero exit)",
    failure_class: "result_missing",
    changed_files: [],
    warnings: [],
    followups: [],
  };
  args.cr = { returncode: 1, stdout_bytes: 0, stderr_bytes: 1234 };
  args.resultJsonPath = "/tmp/test-workspace/.gptwork/goals/goal_verified_writeback/result.json";
  args.deliveryResultRecovery = {
    reason: "result_missing_but_verified_commit",
    canonical_clean: true,
    commit_integrated: true,
    commit: "88546312e483f2ce4a338ae0486e31c9bc4dd739",
    local_head: "88546312e483f2ce4a338ae0486e31c9bc4dd739",
    remote_head: "88546312e483f2ce4a338ae0486e31c9bc4dd739",
    worktree_commit: "0f2808abbadc44c5b5c8bfa0547349878c4e8306",
    verification: {
      passed: true,
      commands: [{ cmd: "npm --prefix backend run check:syntax", exit_code: 0 }],
    },
  };
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(savedState.tasks[0].status, "completed");
  assert.equal(savedState.goals[0].status, "completed");
  assert.equal(savedState.goal_queue[0].status, "completed");
  assert.equal(savedState.tasks[0].result.failure_class, "delivery_result_writeback_missing");
  assert.equal(savedState.tasks[0].result.delivery_result_recovery.reason, "result_missing_but_verified_commit");
  assert.equal(savedState.tasks[0].result.verification.passed, true);
  assert.equal(fallbackJson.status, "completed");
  assert.equal(fallbackJson.commit, "88546312e483f2ce4a338ae0486e31c9bc4dd739");
  assert.equal(fallbackJson.local_head, "88546312e483f2ce4a338ae0486e31c9bc4dd739");
  assert.equal(fallbackJson.delivery_result_recovery.reason, "result_missing_but_verified_commit");
});

test("task-final-writeback: missing result recovery without verification does not complete", async () => {
  let savedState = null;
  const args = makeMinimalArgs("failed");
  args.goal = { id: "goal_unverified_writeback", workspace_id: "hosted-default", title: "Unverified writeback" };
  args.task = { id: "task_unverified_writeback", goal_id: args.goal.id, logs: [] };
  args.store = {
    mutate: async (updater) => {
      const state = {
        tasks: [{ id: args.task.id, goal_id: args.goal.id, logs: [] }],
        goals: [args.goal],
        goal_queue: [{ queue_id: "queue_unverified_writeback", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = {
    kind: "codex_failed",
    summary: "Codex execution failed (non-zero exit)",
    failure_class: "result_missing",
    changed_files: [],
    warnings: [],
    followups: [],
  };
  args.deliveryResultRecovery = {
    reason: "result_missing_but_verified_commit",
    canonical_clean: true,
    commit_integrated: true,
    commit: "88546312e483f2ce4a338ae0486e31c9bc4dd739",
    verification: { passed: false, commands: [] },
  };

  const result = await finalizeCodexTaskRun(args);

  assert.notEqual(result.status, "completed");
  assert.equal(savedState.tasks[0].status, "failed");
  assert.equal(savedState.goals[0].status, "failed");
});
