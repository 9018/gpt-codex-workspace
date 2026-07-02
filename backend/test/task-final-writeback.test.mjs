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

function makeAutoIntegrationQueuePropagationArgs(overrides = {}) {
  const commit = overrides.commit || "aea9c3ff72a40ad9ca351bfb1ea77b88010d837c";
  const prerequisiteGoal = {
    id: overrides.goalId || "goal_7e9a6b9f-f243-4834-a26e-e75f263d0b57",
    workspace_id: "hosted-default",
    project_id: "default",
    conversation_id: "conv_g9",
    title: "G9 accepted integration",
    status: overrides.goalStatus || "open",
    mode: "builder",
    acceptance_contract: {
      intent: { operation_kind: "code_change", semantic_confidence: "high" },
      requirements: { requires_commit: true, requires_integration: true },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
  };
  const dependentGoal = {
    id: "goal_g10_dependent",
    workspace_id: "hosted-default",
    project_id: "default",
    conversation_id: "conv_g10",
    title: "G10 dependent",
    status: "open",
    mode: "builder",
  };
  const task = { id: overrides.taskId || "task_a7752115-dc49-44f3-bd49-bf23cd93d430", goal_id: prerequisiteGoal.id, logs: [] };
  const repoId = "github.com/9018/gpt-codex-workspace";
  const state = {
    tasks: [{ ...task, logs: [] }],
    goals: [prerequisiteGoal, dependentGoal],
    conversations: [
      { id: "conv_g9", goal_id: prerequisiteGoal.id, messages: [] },
      { id: "conv_g10", goal_id: dependentGoal.id, messages: [] },
    ],
    goal_queue: [
      { queue_id: "queue_g9", goal_id: prerequisiteGoal.id, task_id: task.id, status: "running", repo_id: repoId, position: 9, auto_start: true },
      {
        queue_id: "queue_5b61e9e3f50",
        goal_id: dependentGoal.id,
        task_id: null,
        status: "blocked",
        repo_id: repoId,
        position: 10,
        depends_on_goal_id: prerequisiteGoal.id,
        blocked_reason: `depends_on_goal ${prerequisiteGoal.id} status=open`,
        auto_start: true,
      },
      ...(overrides.extraQueue || []),
    ],
    activities: [],
  };
  const contractVerification = {
    contract_valid: true,
    blocking_passed: true,
    completion_eligible: true,
    requires_review: false,
    blockers: [],
    non_blocking_followups: [],
    quality_notes: [],
    state_assertions: { passed: true, failures: [] },
    ...(overrides.contractVerification || {}),
  };
  const args = makeMinimalArgs(overrides.taskStatus || "completed");
  args.goal = prerequisiteGoal;
  args.task = task;
  args.store = {
    state,
    load: async () => state,
    save: async () => {},
    mutate: async (updater) => {
      args.store.state = state;
      return updater(state);
    },
  };
  args.config = {
    ...args.config,
    defaultRepoPath: "/tmp/canonical",
    defaultWorkspaceRoot: "/tmp",
    repoResolver: async () => ({
      repo_id: repoId,
      canonical_repo_path: "/tmp/canonical",
      lock_repo_path: "/tmp/canonical",
      worktree_lifecycle: { ok: true, mode: "git_worktree" },
    }),
  };
  args.resolvedRepo = {
    repo_id: repoId,
    canonical_repo_path: "/tmp/canonical",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { mode: "git_worktree", ok: true, branch_name: "gptwork/task/g9" },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "G9 completed cleanly at integrated commit",
    changed_files: ["backend/src/task-final-writeback.mjs"],
    tests: "npm --prefix backend run check:syntax",
    commit,
    local_head: commit,
    remote_head: commit,
    repo_head: commit,
    runtime: { repo_head: commit },
    reviewer_decision: { status: "accepted", passed: true, should_enter_review: false, ...(overrides.reviewerDecision || {}) },
    acceptance_findings: overrides.acceptanceFindings || [],
    integration: { status: "merged", merged: true, pushed: true, commit, ...(overrides.integration || {}) },
    auto_integration_completion: {
      attempted: true,
      completed: true,
      commit,
      canonical_clean_after: true,
      verification_report: { passed: true, head: commit, dirty: false },
      blockers: [],
      ...(overrides.autoIntegrationCompletion || {}),
    },
    contract_verification: contractVerification,
    ...(overrides.taskResult || {}),
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [{ cmd: "npm --prefix backend run check:syntax", exit_code: 0 }],
    changed_files: ["backend/src/task-final-writeback.mjs"],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
    contract_verification: contractVerification,
    ...(overrides.verification || {}),
  });
  args.removeTaskWorktreeFn = async () => ({ ok: true, removed: true, worktree_path: "/tmp/worktree" });
  return { args, state, prerequisiteGoal, dependentGoal, task, commit };
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
  assert.equal(autoStartedTask.result.finalizer_decision.status, "completed");
  assert.equal(autoStartedTask.result.finalizer_decision.safe_to_auto_advance, true);
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

test("task-final-writeback: accepted verified runtime-code result without result.status does not fall to review", async () => {
  let savedTask = null;
  let fallbackJson = null;
  const commit = "4f23c4462c2a46d0bdc1237403274f4300000000";
  const args = makeMinimalArgs("completed");
  args.task = { id: "task_4f23c446", goal_id: "goal_runtime_verified", logs: [], title: "P0: verified runtime policy change" };
  args.goal = {
    id: "goal_runtime_verified",
    workspace_id: "hosted-default",
    title: "P0 verified runtime policy change",
    acceptance_contract: {
      intent: { operation_kind: "code_change", semantic_confidence: "high" },
      requirements: { requires_commit: true, requires_integration: false },
      blocking_requirements: [{ id: "commit_present" }, { id: "changed_files_reported" }, { id: "verification_report" }],
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
  };
  args.store = {
    mutate: async (updater) => {
      const state = { tasks: [{ id: args.task.id, goal_id: args.goal.id, logs: [] }], goals: [args.goal], activities: [] };
      const result = await updater(state);
      savedTask = result.task;
      return result;
    },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "Runtime-sensitive acceptance policy was updated and verified.",
    changed_files: ["backend/src/acceptance/contract-builder.mjs", "backend/src/queue-policy.mjs"],
    tests: "npm --prefix backend run check:syntax; npm --prefix backend run check:imports",
    commit,
    warnings: ["runtime_code_changed_without_safe_restart: backend/src/acceptance/contract-builder.mjs, backend/src/queue-policy.mjs"],
    verification: { passed: true, commands: [{ cmd: "npm --prefix backend run check:syntax", exit_code: 0 }] },
    reviewer_decision: { status: "accepted", passed: true, should_enter_review: false },
    acceptance_findings: [],
    integration: { status: "skipped", merged: false, pushed: false, pr_opened: false, satisfied: true },
  };
  args.verifyTaskCompletionFn = async ({ resultJson }) => {
    assert.equal(resultJson.status, "completed");
    return {
      passed: true,
      status: "completed",
      commands: [{ cmd: "npm --prefix backend run check:syntax", exit_code: 0 }],
      changed_files: ["backend/src/acceptance/contract-builder.mjs", "backend/src/queue-policy.mjs"],
      reason_no_tests: null,
      failure_class: null,
      requires_review: false,
      findings: [],
      contract_verification: {
        contract_valid: true,
        blocking_passed: true,
        acceptance_status: "satisfied",
        completion_eligible: true,
        requires_review: false,
        blockers: [],
        non_blocking_followups: [],
        quality_notes: [],
        state_assertions: { passed: true, failures: [] },
      },
    };
  };
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  const result = await finalizeCodexTaskRun(args);

  assert.notEqual(result.status, "waiting_for_review");
  assert.equal(result.status, "completed");
  assert.equal(savedTask.status, "completed");
  assert.equal(savedTask.result.status, "completed");
  assert.equal(savedTask.result.requires_review, false);
  assert.equal(savedTask.result.contract_verification.acceptance_status, "satisfied");
  assert.equal(savedTask.result.acceptance_gate.status, "passed");
  assert.equal(savedTask.result.closure_decision.status, "auto_completed_clean");
  assert.equal(savedTask.result.integration.status, "skipped");
  assert.equal(savedTask.result.finalizer_decision.safe_to_auto_advance, true);
  assert.equal(fallbackJson.status, "completed");
  assert.equal(fallbackJson.contract_verification.acceptance_status, "satisfied");
  assert.equal(fallbackJson.closure_decision.status, "auto_completed_clean");
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

test("task-final-writeback: accepted auto integration is not demoted by fallback verifier and advances queue", async () => {
  let savedState = null;
  let autoStartedTask = null;
  const commit = "55b14a325aa9af561c67e233455c7c6d60f5d407";
  const repairCommit = "a8ab00a267af8079a626be0c86f87392f3e2dc8c";
  const args = makeMinimalArgs("completed");
  args.goal = {
    id: "goal_g3_auto_acceptance",
    workspace_id: "hosted-default",
    title: "G3 accepted auto integration",
    acceptance_contract: {
      intent: { operation_kind: "code_change", semantic_confidence: "high" },
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [
        { id: "commit_present" },
        { id: "changed_files_reported" },
        { id: "verification_report" },
        { id: "integration_completed" },
      ],
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
  };
  args.task = {
    id: "task_g3_repair",
    goal_id: args.goal.id,
    parent_task_id: "task_g3_root",
    repair_of_task_id: "task_g3_root",
    logs: [],
  };
  const state = {
    tasks: [
      { id: "task_g3_root", goal_id: "goal_g3_root", status: "waiting_for_repair", logs: [], result: {} },
      { id: args.task.id, goal_id: args.goal.id, parent_task_id: "task_g3_root", repair_of_task_id: "task_g3_root", logs: [] },
    ],
    goals: [args.goal, { id: "goal_g3_root", workspace_id: "hosted-default", status: "waiting_for_repair" }],
    goal_queue: [
      { queue_id: "queue_g3", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true },
      { queue_id: "queue_g4", goal_id: "goal_g4", task_id: null, status: "ready", auto_start: true },
    ],
    activities: [],
  };
  args.store = {
    mutate: async (updater) => {
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.resolvedRepo = {
    repo_id: "github.com/acme/repo",
    canonical_repo_path: "/tmp/canonical",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { mode: "git_worktree", ok: true, branch_name: "gptwork/task/g3", base_sha: "0".repeat(40) },
  };
  args.taskResult = {
    kind: "codex_executed",
    status: "completed",
    summary: "G3 accepted repair was integrated and verified",
    changed_files: ["backend/src/task-final-writeback.mjs", "backend/src/task-acceptance.mjs"],
    tests: "backend check:syntax, check:imports, workflow/acceptance/queue tests passed",
    commit: repairCommit,
    local_head: repairCommit,
    remote_head: repairCommit,
    warnings: [],
    followups: [],
    verification: { passed: true, commands: [{ cmd: "npm --prefix backend run check:syntax", exit_code: 0 }], findings: [] },
    reviewer_decision: { status: "accepted", passed: true, decision: { status: "accepted", passed: true } },
    acceptance_findings: [
      { severity: "major", code: "changed_files_mismatch", message: "resolved by repair", resolved: true },
    ],
    integration: { status: "merged", merged: true, auto_completed: true, commit: repairCommit },
    auto_integration_completion: {
      attempted: true,
      eligible: true,
      completed: true,
      reason: "already_integrated_and_verified",
      base_sha: commit,
      commit: repairCommit,
      canonical_clean_after: true,
      verification_report_path: "/tmp/g3-report.json",
      verification_report: { passed: true, profile: "changed", head: repairCommit, dirty: false, steps: 3, failures: 0 },
      commands: [{ cmd: "node scripts/release-delivery-check.mjs --profile changed", exit_code: 0 }],
      blockers: [],
      warnings: [],
    },
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: false,
    status: "waiting_for_review",
    commands: [{ cmd: "git diff --check", exit_code: 0 }],
    changed_files: [],
    reason_no_tests: null,
    failure_class: "verification_failed",
    requires_review: true,
    findings: [
      { severity: "major", code: "changed_files_mismatch", message: "Result claims changed_files but git diff shows no changes", source: "acceptance_agent" },
      { severity: "blocker", code: "verification_command_missing", message: "Required verification command was not evidenced: docs_check", source: "acceptance_contract_verifier" },
    ],
    contract_verification: {
      contract_valid: true,
      blocking_passed: false,
      acceptance_status: "unsatisfied",
      completion_eligible: false,
      blockers: [{ severity: "blocker", code: "verification_command_missing", message: "docs_check", source: "acceptance_contract_verifier" }],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, failures: [] },
    },
  });
  args.autoStartNextOnTaskCompletedFn = async (store, config, completedTask) => {
    autoStartedTask = completedTask;
    return { auto_started: true, details: [{ queue_id: "queue_g4", started: true }] };
  };
  args.removeTaskWorktreeFn = async () => ({ ok: true, removed: true, worktree_path: "/tmp/worktree" });

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  const rootTask = savedState.tasks.find((item) => item.id === "task_g3_root");
  const repairTask = savedState.tasks.find((item) => item.id === "task_g3_repair");
  assert.equal(repairTask.status, "completed");
  assert.equal(rootTask.status, "completed");
  assert.equal(savedState.goals[0].status, "completed");
  assert.equal(savedState.goal_queue[0].status, "completed");
  assert.equal(autoStartedTask.id, "task_g3_repair");
  assert.equal(result.auto_start.auto_started, true);
  assert.equal(repairTask.result.closure_decision.status, "auto_completed_clean");
  assert.equal(repairTask.result.requires_review, false);
  assert.deepEqual(repairTask.result.changed_files, ["backend/src/task-final-writeback.mjs", "backend/src/task-acceptance.mjs"]);
  assert.equal(repairTask.result.final_verification.passed, false);
  assert.equal(repairTask.result.verification.passed, true);
});

test("task-final-writeback: accepted auto integration completes linked goal and starts blocked dependent queue item", async () => {
  const { args, state, prerequisiteGoal, dependentGoal, task } = makeAutoIntegrationQueuePropagationArgs();
  const { autoStartNextOnTaskCompleted } = await import("../src/goal-queue.mjs");
  args.autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted;

  const result = await finalizeCodexTaskRun(args);

  const completedQueue = state.goal_queue.find((item) => item.queue_id === "queue_g9");
  const dependentQueue = state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50");
  const dependentTask = state.tasks.find((item) => item.goal_id === dependentGoal.id);
  assert.equal(result.status, "completed");
  assert.equal(state.goals.find((goal) => goal.id === prerequisiteGoal.id).status, "completed");
  assert.equal(completedQueue.status, "completed");
  assert.equal(completedQueue.completed_task_id, task.id);
  assert.equal(dependentQueue.status, "running", JSON.stringify(result.auto_start));
  assert.equal(dependentQueue.blocked_reason, null);
  assert.ok(dependentTask, "dependent queue item should auto-start a task");
  assert.equal(dependentQueue.task_id, dependentTask.id);
  assert.equal(result.auto_start.auto_started, true);
});

test("task-final-writeback: accepted auto integration with non-blocking followups propagates queue", async () => {
  const { args, state, prerequisiteGoal } = makeAutoIntegrationQueuePropagationArgs({
    contractVerification: {
      non_blocking_followups: [{ code: "docs_followup", message: "Update docs later" }],
      quality_notes: [{ code: "coverage_note", message: "Broaden coverage later" }],
    },
    taskResult: {
      followups: [{ code: "docs_followup", message: "Update docs later" }],
    },
  });
  const { autoStartNextOnTaskCompleted } = await import("../src/goal-queue.mjs");
  args.autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted;

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(state.goals.find((goal) => goal.id === prerequisiteGoal.id).status, "completed");
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_g9").status, "completed");
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").status, "running");
  assert.equal(state.tasks[0].result.closure_decision.status, "auto_completed_with_followups");
  assert.ok(state.tasks[0].result.next_tasks.length > 0);
});

test("task-final-writeback: failed or review-required acceptance does not unblock dependent queue", async () => {
  for (const scenario of [
    {
      name: "failed acceptance",
      overrides: {
        reviewerDecision: { status: "rejected", passed: false },
        contractVerification: { blocking_passed: false, completion_eligible: false, blockers: [{ severity: "blocker", code: "acceptance_failed" }] },
      },
      expectedStatuses: new Set(["waiting_for_review", "waiting_for_repair"]),
    },
    {
      name: "requires review",
      overrides: {
        reviewerDecision: { status: "accepted", passed: true, should_enter_review: true },
        contractVerification: { requires_review: true, semantic_ambiguity: true },
      },
      expectedStatuses: new Set(["waiting_for_review"]),
    },
  ]) {
    const { args, state, prerequisiteGoal } = makeAutoIntegrationQueuePropagationArgs(scenario.overrides);
    const { autoStartNextOnTaskCompleted } = await import("../src/goal-queue.mjs");
    args.autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted;

    const result = await finalizeCodexTaskRun(args);

    assert.ok(scenario.expectedStatuses.has(result.status), scenario.name);
    assert.ok(scenario.expectedStatuses.has(state.goals.find((goal) => goal.id === prerequisiteGoal.id).status), scenario.name);
    assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").status, "blocked", scenario.name);
    assert.match(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").blocked_reason, /depends_on_goal/, scenario.name);
  }
});

test("task-final-writeback: dirty auto integration evidence does not unblock dependent queue", async () => {
  const { args, state } = makeAutoIntegrationQueuePropagationArgs({
    autoIntegrationCompletion: {
      canonical_clean_after: false,
      verification_report: { passed: true, head: "aea9c3ff72a40ad9ca351bfb1ea77b88010d837c", dirty: true },
    },
  });
  args.autoStartNextOnTaskCompletedFn = async () => ({ auto_started: false, details: [] });

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "completed");
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_g9").status, "completed");
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").status, "blocked");
  assert.match(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").blocked_reason, /depends_on_goal/);
});

test("task-final-writeback: repeated accepted final writeback remains idempotent for queue propagation", async () => {
  const { args, state, dependentGoal, task } = makeAutoIntegrationQueuePropagationArgs();
  const { autoStartNextOnTaskCompleted } = await import("../src/goal-queue.mjs");
  args.autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted;

  const first = await finalizeCodexTaskRun(args);
  const firstDependentTaskId = state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").task_id;
  const taskCountAfterFirst = state.tasks.length;

  state.goal_queue.find((item) => item.queue_id === "queue_g9").status = "running";
  await finalizeCodexTaskRun({ ...args, task: { ...task, logs: [] } });

  const dependentTasks = state.tasks.filter((item) => item.goal_id === dependentGoal.id);
  assert.equal(first.status, "completed");
  assert.equal(state.tasks.length, taskCountAfterFirst);
  assert.equal(dependentTasks.length, 1);
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50").task_id, firstDependentTaskId);
  assert.equal(state.goal_queue.find((item) => item.queue_id === "queue_g9").status, "completed");
});

test("task-final-writeback: repo concurrency guard blocks auto-start after dependency reconciliation", async () => {
  const { args, state } = makeAutoIntegrationQueuePropagationArgs({
    extraQueue: [
      { queue_id: "queue_same_repo_running", goal_id: "goal_other_running", task_id: "task_other_running", status: "running", repo_id: "github.com/9018/gpt-codex-workspace", position: 8, auto_start: true },
    ],
  });
  state.goals.push({ id: "goal_other_running", workspace_id: "hosted-default", project_id: "default", conversation_id: "conv_other", title: "Other running", status: "running", mode: "builder" });
  state.tasks.push({ id: "task_other_running", goal_id: "goal_other_running", status: "running", logs: [] });
  const { autoStartNextOnTaskCompleted } = await import("../src/goal-queue.mjs");
  args.autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted;

  const result = await finalizeCodexTaskRun(args);

  const dependentQueue = state.goal_queue.find((item) => item.queue_id === "queue_5b61e9e3f50");
  assert.equal(result.status, "completed");
  assert.equal(dependentQueue.status, "blocked");
  assert.match(dependentQueue.blocked_reason, /repo concurrency/);
  assert.equal(result.auto_start.auto_started, false);
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
  assert.equal(savedState.tasks[0].result.followup_processing.kind, "unaccepted_task_followup");
  assert.equal(savedState.tasks[0].result.followup_processing.source_task_id, "task_repair_writeback");
  assert.equal(savedState.tasks[0].result.followup_processing.source_goal_id, args.goal.id);
  assert.equal(savedState.tasks[0].result.followup_processing.handling_attempt, 1);
  assert.equal(savedState.tasks[0].result.followup_processing.handling_result.status, "waiting_for_repair");
  assert.equal(savedState.tasks[0].result.followup_processing.followup_goal_id, "goal_repair_created");
  assert.equal(savedState.tasks[0].result.followup_processing.followup_task_id, "task_repair_created");
  assert.ok(savedState.tasks[0].logs.some((log) => /failure_class=test_failed attempt=0 repair_of_attempt=0/.test(log.message)));
});

test("task-final-writeback: repairable acceptance blockers create traceable follow-up task", async () => {
  let savedState = null;
  let createdPayload = null;
  let fallbackJson = null;
  const args = makeMinimalArgs("completed");
  args.goal = {
    id: "goal_acceptance_repair",
    workspace_id: "hosted-default",
    acceptance_contract: {
      intent: { operation_kind: "code_change", semantic_confidence: "high" },
      requirements: { requires_commit: true },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
  };
  args.task = {
    id: "task_acceptance_repair",
    goal_id: args.goal.id,
    title: "Acceptance repair task",
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
        goal_queue: [{ queue_id: "queue_acceptance_repair", goal_id: args.goal.id, task_id: args.task.id, status: "running", auto_start: true }],
        activities: [],
      };
      const result = await updater(state);
      savedState = state;
      return result;
    },
  };
  args.taskResult = {
    kind: "codex_executed",
    summary: "Verifier passed but required evidence is missing",
    changed_files: ["src/app.mjs"],
    commit: "abc123",
    warnings: [],
    followups: [],
  };
  args.verifyTaskCompletionFn = async () => ({
    passed: true,
    status: "completed",
    commands: [{ cmd: "npm test", exit_code: 0 }],
    changed_files: ["src/app.mjs"],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
    contract_verification: {
      contract_valid: true,
      blocking_passed: false,
      acceptance_status: "unsatisfied",
      completion_eligible: false,
      blockers: [{ severity: "blocker", code: "diff_reported_missing", message: "Diff evidence missing", source: "contract_verifier" }],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, failures: [] },
    },
  });
  args.createGoalFn = async (store, config, payload) => {
    createdPayload = payload;
    return { goal: { id: "goal_acceptance_followup" }, task: { id: "task_acceptance_followup" } };
  };
  args.writeFileFn = async (path, content) => {
    if (path.endsWith("/result.json")) fallbackJson = JSON.parse(content);
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(result.status, "waiting_for_repair");
  assert.equal(savedState.tasks[0].status, "waiting_for_repair");
  assert.equal(createdPayload.repair_of_goal_id, "goal_acceptance_repair");
  assert.equal(createdPayload.repair_of_task_id, "task_acceptance_repair");
  assert.equal(createdPayload.attempt, 1);
  assert.equal(savedState.tasks[0].result.repair_goal_id, "goal_acceptance_followup");
  assert.equal(savedState.tasks[0].result.repair_task_id, "task_acceptance_followup");
  assert.equal(savedState.tasks[0].result.followup_processing.source_task_id, "task_acceptance_repair");
  assert.equal(savedState.tasks[0].result.followup_processing.source_goal_id, "goal_acceptance_repair");
  assert.equal(savedState.tasks[0].result.followup_processing.handling_attempt, 1);
  assert.equal(savedState.tasks[0].result.followup_processing.handling_result.status, "waiting_for_repair");
  assert.equal(savedState.tasks[0].result.followup_processing.blockers[0].code, "diff_reported_missing");
  assert.equal(fallbackJson.followup_processing.source_task_id, "task_acceptance_repair");
  assert.equal(fallbackJson.followup_processing.followup_task_id, "task_acceptance_followup");
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
