/**
 * task-general-processor.test.mjs
 * Tests for task-general-processor, including non-hosted workspace handling (P1.1).
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { processGeneralTask, processGeneralTaskWithDeps } from "../src/task-general-processor.mjs";

/**
 * Helper to create a StateStore with pre-populated state for testing
 * the non-hosted workspace code path.
 */
function makeStoreWithNonHostedWorkspace(tmpDir) {
  const now = new Date().toISOString();
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{
      id: "default",
      team_id: "team_default",
      name: "Default Project",
      description: "Default project",
      default_workspace_id: "non-hosted-workspace",
      created_at: now,
      updated_at: now,
    }],
    workspaces: [{
      id: "non-hosted-workspace",
      project_id: "default",
      name: "Local Workspace",
      type: "local",
      root: tmpDir,
      default: true,
      created_at: now,
      updated_at: now,
    }],
    goals: [{
      id: "goal_non_hosted",
      project_id: "default",
      workspace_id: "non-hosted-workspace",
      conversation_id: "conv_non_hosted",
      user_request: "Test non-hosted workspace",
      goal_prompt: "Test goal for non-hosted workspace handling.",
      context_summary: "Testing P1.1",
      title: "Test non-hosted workspace",
      created_by: "user_default",
      assignee: "codex",
      status: "assigned",
      mode: "builder",
      created_at: now,
      updated_at: now,
    }],
    conversations: [{
      id: "conv_non_hosted",
      goal_id: "goal_non_hosted",
      project_id: "default",
      workspace_id: "non-hosted-workspace",
      messages: [{ role: "user", content: "Test", id: "msg_1", author_id: "user_default", created_at: now }],
      created_at: now,
      updated_at: now,
    }],
    memories: [],
    tasks: [{
      id: "task_non_hosted",
      project_id: "default",
      workspace_id: "non-hosted-workspace",
      goal_id: "goal_non_hosted",
      conversation_id: "conv_non_hosted",
      title: "Test task on non-hosted workspace",
      description: "Test description",
      created_by: "user_default",
      assignee: "codex",
      status: "assigned",
      mode: "builder",
      logs: [],
      artifacts: [],
      result: null,
      created_at: now,
      updated_at: now,
    }],
    chatgpt_requests: [],
    activities: [],
    audit: [],
  };

  const statePath = join(tmpDir, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return new StateStore({
    statePath,
    defaultWorkspaceRoot: tmpDir,
  });
}

test("processGeneralTask transitions non-hosted workspace task to waiting_for_review with clear reason", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-nonhosted-"));
  try {
    const store = makeStoreWithNonHostedWorkspace(tmpDir);
    await store.load();
    const task = store.state.tasks.find((item) => item.id === "task_non_hosted");

    // Minimal config: ensureTaskGoal with pre-existing goal doesn't need defaultRepoPath
    const config = {
      defaultRepoPath: null,
      defaultWorkspaceRoot: tmpDir,
    };
    const context = {
      user_id: "test_user",
      project_ids: ["*"],
      workspace_ids: ["*"],
      scopes: ["task:create", "task:update", "workspace:read", "project:read", "workspace:write"],
    };
    const github = {}; // Not used before the non-hosted return

    const result = await processGeneralTask(store, config, task, context, github);

    // Verify task transitions to waiting_for_review
    const updatedTask = await store.findTaskById("task_non_hosted");
    assert.equal(updatedTask.status, "waiting_for_review");

    // Verify clear log message with workspace type
    const lastLog = updatedTask.logs[updatedTask.logs.length - 1];
    assert.ok(lastLog.message.includes("local"), "log message should mention workspace type");
    assert.ok(lastLog.message.includes("waiting_for_review"), "log message should mention waiting_for_review");

    // Verify result shape
    assert.equal(result.status, "waiting_for_review");
    assert.equal(result.skipped, true);
    assert.equal(result.transitioned, true);
    assert.equal(result.progressed, true);
    assert.ok(result.reason.includes("local"), "reason should include workspace type");

    // Verify goal transcript has the message appended
    const goal = store.state.goals.find((g) => g.id === "goal_non_hosted");
    assert.equal(goal.status, "assigned", "goal status should remain unchanged");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTask non-hosted workspace does not interact with repo lock or task execution", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-nonhosted2-"));
  try {
    const store = makeStoreWithNonHostedWorkspace(tmpDir);
    await store.load();
    const task = store.state.tasks.find((item) => item.id === "task_non_hosted");

    // Set defaultRepoPath so we can verify it's NOT used
    const config = {
      defaultRepoPath: "/nonexistent/repo",
      defaultWorkspaceRoot: tmpDir,
    };
    const context = {
      user_id: "test_user",
      project_ids: ["*"],
      workspace_ids: ["*"],
      scopes: ["task:create", "task:update", "workspace:read", "project:read", "workspace:write"],
    };
    const github = {};

    // This should NOT throw even though defaultRepoPath doesn't exist
    // because the non-hosted check happens before acquireRepoLock
    const result = await processGeneralTask(store, config, task, context, github);
    assert.equal(result.status, "waiting_for_review");

    // Verify no lock was acquired or attempted (looking at logs for lock-related messages)
    const updatedTask = await store.findTaskById("task_non_hosted");
    assert.ok(updatedTask.logs.length >= 2, "should have at least 2 log entries (started + waiting_for_review)");
    assert.ok(updatedTask.logs[updatedTask.logs.length - 1].message.includes("waiting_for_review"));
    // No lock-related error in logs
    const lockLogs = updatedTask.logs.filter((log) => log.message.includes("locked") || log.message.includes("lock"));
    assert.equal(lockLogs.length, 0, "should not have any lock-related log entries");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTask real worktree path flows through resolveTaskRepository to Codex cwd and finalizer result", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-real-worktree-chain-"));
  try {
    const store = makeStoreWithNonHostedWorkspace(tmpDir);
    await store.load();
    const now = new Date().toISOString();
    store.state.workspaces[0].type = "hosted";
    store.state.workspaces[0].id = "hosted-default";
    store.state.workspaces[0].root = tmpDir;
    store.state.projects[0].default_workspace_id = "hosted-default";
    store.state.goals[0].id = "goal_worktree_chain";
    store.state.goals[0].workspace_id = "hosted-default";
    store.state.goals[0].status = "assigned";
    store.state.tasks[0] = {
      id: "task_worktree_chain",
      project_id: "default",
      workspace_id: "hosted-default",
      goal_id: "goal_worktree_chain",
      conversation_id: "conv_non_hosted",
      title: "P0 real worktree chain",
      description: "Verify execution cwd chain",
      created_by: "user_default",
      assignee: "codex",
      status: "assigned",
      mode: "builder",
      logs: [],
      artifacts: [],
      result: null,
      created_at: now,
      updated_at: now,
    };
    await store.save();

    const task = store.state.tasks[0];
    const taskWorktreePath = join(tmpDir, ".gptwork", "worktrees", "github.com-acme-repo", "task_worktree_chain");
    let observedExecutionCwd = null;
    let finalizedTaskResult = null;
    let finalizedResolvedRepo = null;
    let resolvedCalled = false;
    let acquiredLockPath = null;
    mkdirSync(taskWorktreePath, { recursive: true });

    const result = await processGeneralTaskWithDeps(store, {
      defaultRepoPath: join(tmpDir, "canonical"),
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
      codexExecArgs: "--skip-git-repo-check",
    }, task, {
      user_id: "test_user",
      project_ids: ["*"],
      workspace_ids: ["*"],
      scopes: ["task:create", "task:update", "workspace:read", "project:read", "workspace:write"],
    }, { syncTask: async () => {} }, {
      resolveTaskRepositoryPlanFn: async () => {
        resolvedCalled = true;
        return {
          repo_id: "github.com/acme/repo",
          canonical_repo_path: join(tmpDir, "canonical"),
          task_id: "task_worktree_chain",
          task_worktree_path: taskWorktreePath,
          uses_default_fallback: false,
          worktree_lifecycle: null,
        };
      },
      materializeTaskWorktreeFn: async (plan) => {
        return {
          lock_repo_path: taskWorktreePath,
          worktree_lifecycle: {
            mode: "git_worktree",
            ok: true,
            source_root: plan.canonical_repo_path,
            worktree_path: taskWorktreePath,
            branch_name: "gptwork/task/task_worktree_chain",
            dirty_source: false,
            created_at: new Date().toISOString(),
            cleanup_policy: "remove_on_success_retain_on_failure",
            lifecycle_events: [{ event: "git_worktree_add", ok: true, worktree_path: taskWorktreePath }],
          },
        };
      },
      acquireRepoLockFn: async (workspaceRoot, repoPath) => {
        acquiredLockPath = repoPath;
        return { acquired: true };
      },
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: "run_1" }),
      executeCodexTaskRunFn: async ({ executionCwd }) => {
        observedExecutionCwd = executionCwd;
        return {
          cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
          summary: "chain complete",
          parsedResult: {
            structured: true,
            status: "completed",
            summary: "chain complete",
            changed_files: [],
            tests: "focused chain stub: passed",
            warnings: [],
            followups: [],
            acceptance_findings: [],
          },
        };
      },
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult, resolvedRepo }) => {
        finalizedTaskResult = taskResult;
        finalizedResolvedRepo = resolvedRepo;
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      // PR0: Mock acceptance/repair/integration to avoid interference with existing test
      runAcceptanceAgentFn: async () => ({
        passed: true,
        status: "accepted_with_followups",
        profile: "default",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: [] },
        reviewer_decision: { role: "acceptance_agent", summary: "Mock accepted", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: false, reason: "mock - no repair" }),
      createRepairGoalFromFindingsFn: async () => ({ id: "mock_repair" }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async () => ({ goal: {}, task: {} }),
    });

    assert.equal(result.status, "completed");
    assert.equal(resolvedCalled, true);
    // Lock is now acquired on task worktree path (not canonical repo)
  assert.equal(acquiredLockPath, taskWorktreePath);
    assert.equal(observedExecutionCwd, taskWorktreePath);
    assert.equal(finalizedResolvedRepo.task_worktree_path, taskWorktreePath);
    assert.equal(finalizedTaskResult.repo_resolution.worktree_lifecycle.mode, "git_worktree");
    assert.equal(finalizedTaskResult.repo_resolution.worktree_lifecycle.ok, true);
    assert.equal(finalizedTaskResult.execution_cwd, taskWorktreePath);
    assert.equal(finalizedTaskResult.execution_cwd_proof.used_task_worktree_path, true);
    assert.equal(finalizedTaskResult.execution_cwd_proof.canonical_repo_path, join(tmpDir, "canonical"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps fails clearly when materialized builder worktree is unavailable", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-missing-worktree-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_missing_worktree", "goal_missing_worktree");
    await store.load();
    const plan = makeRepoPlan("task_missing_worktree", tmpDir, "github.com/acme/repo");
    rmSync(plan.task_worktree_path, { recursive: true, force: true });
    let lockAttempted = false;
    let prepareAttempted = false;
    let executeAttempted = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: plan.canonical_repo_path,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => plan,
      materializeTaskWorktreeFn: async () => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: {
          mode: "git_worktree",
          ok: true,
          worktree_path: plan.task_worktree_path,
          branch_name: "gptwork/task/task_missing_worktree",
        },
      }),
      acquireRepoLockFn: async () => {
        lockAttempted = true;
        return { acquired: true };
      },
      prepareCodexTaskRunFn: async () => {
        prepareAttempted = true;
        return { promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null };
      },
      executeCodexTaskRunFn: async () => {
        executeAttempted = true;
        return {};
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.kind, "worktree_error");
    assert.match(result.reason, /expected task worktree is unavailable/);
    assert.match(result.reason, new RegExp(plan.task_worktree_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(lockAttempted, false, "worker must not lock an unavailable worktree path");
    assert.equal(prepareAttempted, false, "worker must not prepare a prompt for an unavailable worktree path");
    assert.equal(executeAttempted, false, "worker must not execute Codex outside the expected worktree");

    const updatedTask = await store.findTaskById(task.id);
    assert.equal(updatedTask.status, "failed");
    assert.equal(updatedTask.result.kind, "worktree_error");
    assert.match(updatedTask.result.summary, /expected task worktree is unavailable/);
    assert.ok(updatedTask.logs.some((log) => log.message.includes("expected task worktree is unavailable")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PR0 Integration Tests: acceptance agent + repair loop + integration queue
// ===========================================================================

test("processGeneralTaskWithDeps: acceptance passed + no changes -> completed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-pass-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_acc_pass_noop", "goal_acc_pass_noop");
    let acceptanceCalled = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_acc_pass_noop", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_acc_pass_noop", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "noop completed",
        parsedResult: { structured: true, status: "completed", summary: "noop completed", changed_files: [], tests: "none", noop: true, acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        acceptanceCalled = true;
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      // Use real acceptance agent functions
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "noop",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: [] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(acceptanceCalled, true);
    assert.equal(result.status, "completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: acceptance followups stay next_tasks without blocking finalizer", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-followup-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_acc_followup", "goal_acc_followup");
    let finalizedTaskResult = null;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_acc_followup", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_acc_followup", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "diagnostic completed with followup",
        parsedResult: { structured: true, status: "completed", summary: "diagnostic completed with followup", operation_kind: "diagnostic", changed_files: [], tests: "diagnostic: passed", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        finalizedTaskResult = taskResult;
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async () => ({
        passed: true,
        status: "accepted_with_followups",
        profile: "diagnostic",
        findings: [{ severity: "followup", code: "coverage_note", message: "Add a broader report fixture", source: "acceptance_agent" }],
        repair_proposals: [],
        next_tasks: [{ title: "Add a broader report fixture", reason: "Useful coverage", severity: "non_blocking", auto_enqueue: false }],
        evidence: { changed_files: [] },
        reviewer_decision: { role: "acceptance_agent", summary: "Accepted with followups", decision: { status: "accepted_with_followups", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async () => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(result.status, "completed");
    assert.equal(finalizedTaskResult.next_tasks.length, 1);
    assert.equal(finalizedTaskResult.next_tasks[0].severity, "non_blocking");
    assert.equal(finalizedTaskResult.next_tasks[0].auto_enqueue, false);
    assert.ok(finalizedTaskResult.acceptance_findings.some((finding) => finding.code === "coverage_note"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: acceptance passed + code changes + integration success -> completed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-int-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_acc_int_ok", "goal_acc_int_ok");
    let integrationCalled = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_acc_int_ok", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_acc_int_ok", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change completed",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "completed", "task should complete after successful integration");
        integrationCalled = true;
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async (opts) => {
        integrationCalled = true;
        assert.equal(opts.repoId, "github.com/acme/repo");
        // Real integration queue returns status='merged' with merged=true for local_merge mode.
        // This is a terminal state that should result in completed taskStatus.
        return { ok: true, status: "merged", merged: true };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(integrationCalled, true, "integration should have been called");
    assert.equal(result.status, "completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: acceptance passed + code changes + integration locked -> waiting_for_integration", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-int-lock-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_int_lock", "goal_int_lock");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_int_lock", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_int_lock", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_integration", "task should wait when integration locked");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async (opts) => {
        return { ok: false, status: "locked", merged: false, pushed: false, pr_opened: false, error: "Integration lock held for integration:github.com/acme/repo:main by another task" };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(result.status, "waiting_for_integration");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: acceptance failed + repair possible -> waiting_for_repair", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-fail-repair-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_fail_repair", "goal_fail_repair");
    let repairGoalCreated = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_fail_repair", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_fail_repair", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "failed code",
        parsedResult: { structured: true, status: "completed", summary: "failed code", changed_files: ["src/bug.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_repair");
        assert.ok(taskResult.repair_goal, "repair_goal should be set");
        assert.equal(taskResult.repair_goal.parent_task_id, task.id);
        assert.ok(taskResult.reason.startsWith("acceptance_failed"), "reason should indicate acceptance failure");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: false,
        status: "needs_fix",
        profile: "code_change",
        findings: [{ severity: "blocker", code: "verification_failed", message: "Tests did not pass", source: "acceptance_agent" }],
        repair_proposals: [{ title: "Fix tests", proposed_action: "Re-run tests after fixing" }],
        next_tasks: [],
        evidence: { changed_files: ["src/bug.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "Acceptance failed", decision: { status: "needs_fix", passed: false } },
      }),
      shouldAttemptRepairFn: async () => {
        repairGoalCreated = true;
        return { should_repair: true, reason: "Repair attempt 1/2" };
      },
      createRepairGoalFromFindingsFn: async (opts) => ({
        id: "repair_task_fail_repair_1",
        parent_task_id: task.id,
        root_task_id: task.id,
        repair_attempt: 1,
        acceptance_findings: opts.findings,
        repair_proposals: opts.repairProposals,
        user_request: "Repair: " + task.title + " (attempt 1)",
        goal_prompt: "Repair prompt for task " + task.id,
        mode: "builder",
        workspace_id: "hosted-default",
      }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async (store, config, args) => {
        assert.ok(args.user_request.includes("Repair"), "should be a repair goal");
        return { goal: { id: "repair_goal_created" }, task: { id: "repair_task_created" } };
      },
    });

    assert.equal(result.status, "waiting_for_repair");
    assert.equal(repairGoalCreated, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: acceptance failed + no repair -> waiting_for_review", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-acc-fail-review-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_fail_review", "goal_fail_review");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_fail_review", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_fail_review", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "failing code",
        parsedResult: { structured: true, status: "completed", summary: "failing code", changed_files: ["src/bug.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_review");
        assert.ok(taskResult.repair_denied_reason, "repair_denied_reason should be set");
        assert.ok(taskResult.reason.startsWith("acceptance_failed"), "reason should indicate acceptance failure");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: false,
        status: "needs_fix",
        profile: "code_change",
        findings: [{ severity: "blocker", code: "verification_failed", message: "Tests did not pass", source: "acceptance_agent" }],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/bug.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "Acceptance failed", decision: { status: "needs_fix", passed: false } },
      }),
      shouldAttemptRepairFn: async () => {
        return { should_repair: false, reason: "Repair attempt 3/2 exceeds max. Waiting for review." };
      },
      createRepairGoalFromFindingsFn: async (opts) => ({}),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async () => ({ goal: {}, task: {} }),
    });

    assert.equal(result.status, "waiting_for_review");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: delivery recovery completes commit_missing dirty worktree result", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-delivery-recovery-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_delivery_recovery", "goal_delivery_recovery");
    const recoveredCommit = "1234567890abcdef1234567890abcdef12345678";
    let acceptanceCalled = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
      deliveryResultRecoveryCommands: ["true"],
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_delivery_recovery", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_delivery_recovery", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "changed but no commit",
        parsedResult: {
          structured: true,
          status: "completed",
          summary: "changed but no commit",
          changed_files: ["src/recovered.mjs"],
          tests: "pass",
          commit: "none",
          acceptance_findings: [],
        },
      }),
      analyzeDeliveryRecoveryCandidateFn: () => ({ attempted: true, eligible: true, triggers: ["commit_missing"] }),
      runDeliveryRecoveryFn: async () => ({
        attempted: true,
        eligible: true,
        recovered: true,
        reason: "recovered_dirty_worktree_delivery",
        changed_files: ["src/recovered.mjs"],
        commit: recoveredCommit,
        local_head: recoveredCommit,
        remote_head: recoveredCommit,
        canonical_clean_before: true,
        canonical_clean_after: true,
        canonical_clean: true,
        commit_integrated: true,
        verification: { passed: true, commands: [{ cmd: "true", cwd: tmpDir, exit_code: 0, duration_ms: 1, stdout_tail: "", stderr_tail: "" }] },
        integration: { mode: "ff_only", merged: true, status: "merged" },
        blockers: [],
        warnings: [],
      }),
      runAcceptanceAgentFn: async () => {
        acceptanceCalled = true;
        return { passed: false, findings: [] };
      },
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult, deliveryResultRecovery }) => {
        assert.equal(taskStatus, "completed");
        assert.equal(taskResult.commit, recoveredCommit);
        assert.equal(taskResult.integration.status, "merged");
        assert.equal(taskResult.delivery_result_recovery.recovered, true);
        assert.equal(deliveryResultRecovery.recovered, true);
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
    });

    assert.equal(result.status, "completed");
    assert.equal(acceptanceCalled, false, "recovered delivery should not re-enter normal acceptance path");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: integration conflict -> waiting_for_repair", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-int-conflict-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_int_conflict", "goal_int_conflict");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_int_conflict", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_int_conflict", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "conflicting change",
        parsedResult: { structured: true, status: "completed", summary: "conflicting change", changed_files: ["src/app.mjs"], tests: "pass", commit: "def456", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_repair", "conflict should trigger repair");
        assert.ok(taskResult.reason.startsWith("integration_conflict"), "reason should indicate integration conflict");
        assert.ok(taskResult.repair_goal, "repair_goal should be set for integration conflict");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "Repair attempt 1/2" }),
      createRepairGoalFromFindingsFn: async (opts) => ({
        id: "repair_int_conflict_1",
        parent_task_id: task.id,
        root_task_id: task.id,
        repair_attempt: 1,
        acceptance_findings: opts.findings,
        repair_proposals: opts.repairProposals,
        user_request: "Repair integration conflict",
        goal_prompt: "Resolve integration conflict",
        mode: "builder",
        workspace_id: "hosted-default",
      }),
      runIntegrationQueueFn: async (opts) => ({
        ok: false, status: "conflict", merged: false, pushed: false, pr_opened: false,
        error: "Rebase conflict on main",
        conflict_files: ["src/app.mjs"],
      }),
      createGoalFn: async () => ({ goal: { id: "repair_goal_created" }, task: { id: "repair_task_created" } }),
    });

    assert.equal(result.status, "waiting_for_repair");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: prompt preparation waiting_for_review action parks task for review", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-healing-review-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_healing_review", "goal_healing_review");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_healing_review", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.task_worktree_path, branch_name: "gptwork/task/task_healing_review" },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      releaseLockForTaskFn: async () => {},
      prepareCodexTaskRunFn: async () => { throw Object.assign(new Error("unknown prep failure"), { code: "EUNKNOWN" }); },
      determineHealingActionFn: () => ({ action: "waiting_for_review", next_status: "waiting_for_review", reason: "not recoverable", retry_budget: 0 }),
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
    });

    assert.equal(result.status, "waiting_for_review");
    assert.equal(result.healing_action, "waiting_for_review");
    const updated = await store.findTaskById(task.id);
    assert.equal(updated.status, "waiting_for_review");
    assert.equal(updated.result.healing_action, "waiting_for_review");
    assert.equal(updated.result.healing_retry_count, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: prompt preparation retry action requeues within retry budget", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-healing-retry-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_healing_retry", "goal_healing_retry");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_healing_retry", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.task_worktree_path, branch_name: "gptwork/task/task_healing_retry" },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      releaseLockForTaskFn: async () => {},
      prepareCodexTaskRunFn: async () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); },
      determineHealingActionFn: () => ({ action: "cleanup_and_retry", next_status: "queued", reason: "cleanup temp files", retry_budget: 1 }),
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
    });

    assert.equal(result.status, "queued");
    assert.equal(result.healing_action, "cleanup_and_retry");
    assert.equal(result.healing_retry_count, 1);
    const updated = await store.findTaskById(task.id);
    assert.equal(updated.status, "queued");
    assert.equal(updated.healing_retry_count, 1);
    assert.equal(updated.result.healing_action, "cleanup_and_retry");
    assert.equal(updated.result.reason, "cleanup temp files");
    assert.ok(updated.logs.some((log) => /self-healing cleanup_and_retry/.test(log.message)));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: execution retry action requeues within retry budget", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-healing-exec-retry-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_healing_exec_retry", "goal_healing_exec_retry");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_healing_exec_retry", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.task_worktree_path, branch_name: "gptwork/task/task_healing_exec_retry" },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      releaseLockForTaskFn: async () => {},
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => { throw Object.assign(new Error("worker crash"), { code: "EWORKER" }); },
      determineHealingActionFn: () => ({ action: "recover_and_retry", next_status: "queued", reason: "restart worker", retry_budget: 1 }),
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
    });

    assert.equal(result.status, "queued");
    assert.equal(result.healing_action, "recover_and_retry");
    const updated = await store.findTaskById(task.id);
    assert.equal(updated.status, "queued");
    assert.equal(updated.healing_retry_count, 1);
    assert.equal(updated.result.reason, "restart worker");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: integration push_failed creates repair when allowed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-int-push-failed-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_int_push_failed", "goal_int_push_failed");
    let createGoalArgs = null;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_int_push_failed", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.task_worktree_path, branch_name: "gptwork/task/task_int_push_failed" },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_repair");
        assert.equal(taskResult.failure_class, "integration_push_failed");
        assert.match(taskResult.reason, /integration_push_failed/);
        assert.equal(taskResult.repair_goal.repair_of_task_id, task.id);
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async () => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "accepted", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "Repair attempt 1/2" }),
      runIntegrationQueueFn: async () => ({ ok: false, status: "push_failed", error: "git push failed", merged: false, pushed: false, pr_opened: false }),
      createGoalFn: async (_store, _config, args) => {
        createGoalArgs = args;
        return { goal: { id: "repair_goal_push" }, task: { id: "repair_task_push" } };
      },
    });

    assert.equal(result.status, "waiting_for_repair");
    assert.equal(createGoalArgs.repair_of_task_id, task.id);
    assert.equal(createGoalArgs.repair_of_worktree, join(tmpDir, ".gptwork", "worktrees", "github.com-acme-repo", "task_int_push_failed"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// P0: Integration Completion Semantics — branch_pushed/pr_opened are NOT terminal
// ===========================================================================

test("processGeneralTaskWithDeps: integration branch_pushed does NOT mark task completed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-branch-pushed-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_branch_pushed", "goal_branch_pushed");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_branch_pushed", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_branch_pushed", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        // branch_pushed with merged:false should NOT produce completed
        assert.notEqual(taskStatus, "completed", "branch_pushed must NOT set task completed");
        assert.equal(taskStatus, "waiting_for_review", "branch_pushed should set task to waiting_for_review");
        assert.equal(taskResult.integration.status, "branch_pushed");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async (opts) => {
        // push_branch mode returns branch_pushed (NOT merged)
        return { ok: true, status: "branch_pushed", merged: false, pushed: true, pr_opened: false };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(result.status, "waiting_for_review", "branch_pushed should result in waiting_for_review, not completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: branch_pushed auto completion can ff-only close task", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-branch-pushed-auto-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_branch_pushed_auto", "goal_branch_pushed_auto");
    let autoCompletionCalled = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_branch_pushed_auto", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_branch_pushed_auto", base_sha: "base123", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "commit123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "completed");
        assert.equal(taskResult.integration.status, "merged");
        assert.equal(taskResult.integration.merged, true);
        assert.equal(taskResult.integration.auto_completed, true);
        assert.equal(taskResult.auto_integration_completion.completed, true);
        assert.equal(taskResult.verification.source, "auto_integration_completion");
        assert.equal(taskResult.needs_integration, false);
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async () => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async () => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "branch_pushed", merged: false, pushed: true, pr_opened: false }),
      runAutoIntegrationCompletionFn: async ({ taskResult, integrationResult }) => {
        autoCompletionCalled = true;
        assert.equal(integrationResult.status, "branch_pushed");
        assert.equal(taskResult.commit, "commit123");
        return {
          attempted: true,
          eligible: true,
          completed: true,
          reason: "ff_only_merged_and_verified",
          blockers: [],
          warnings: [],
          base_sha: "base123",
          commit: "commit123",
          canonical_clean_before: true,
          canonical_clean_after: true,
          verification_report_path: join(tmpDir, "report.json"),
          verification_report: { passed: true, profile: "changed", head: "commit123", dirty: false, steps: 2 },
          commands: [{ cmd: "node scripts/release-delivery-check.mjs --profile changed", exit_code: 0 }],
        };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(autoCompletionCalled, true);
    assert.equal(result.status, "completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: branch_pushed without passed acceptance does not try auto completion", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-branch-pushed-no-accept-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_branch_pushed_no_accept", "goal_branch_pushed_no_accept");
    let autoCompletionCalled = false;

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
      maxRepairAttempts: 0,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_branch_pushed_no_accept", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_branch_pushed_no_accept", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "commit123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        assert.equal(taskStatus, "waiting_for_review");
        assert.equal(taskResult.integration, undefined);
        assert.equal(taskResult.auto_integration_completion, undefined);
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async () => ({
        passed: false,
        status: "rejected",
        profile: "code_change",
        findings: [{ severity: "blocker", code: "tests_failed", message: "tests failed" }],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "Rejected", decision: { status: "rejected", passed: false } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: false, reason: "no repair" }),
      runIntegrationQueueFn: async () => {
        throw new Error("integration must not run when acceptance fails");
      },
      runAutoIntegrationCompletionFn: async () => {
        autoCompletionCalled = true;
        return { attempted: true, completed: true };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(autoCompletionCalled, false);
    assert.equal(result.status, "waiting_for_review");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: integration pr_opened does NOT mark task completed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-pr-opened-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_pr_opened", "goal_pr_opened");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_pr_opened", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_pr_opened", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        // pr_opened with merged:false should NOT produce completed
        assert.notEqual(taskStatus, "completed", "pr_opened must NOT set task completed");
        assert.equal(taskStatus, "waiting_for_review", "pr_opened should set task to waiting_for_review");
        assert.equal(taskResult.integration.status, "pr_opened");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async (opts) => {
        // open_pr mode returns pr_opened (NOT merged)
        return { ok: true, status: "pr_opened", merged: false, pushed: true, pr_opened: true };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(result.status, "waiting_for_review", "pr_opened should result in waiting_for_review, not completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("processGeneralTaskWithDeps: integration skipped is still terminal (completed)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-skipped-"));
  try {
    const { store, task, goal } = createTaskStore(tmpDir, "task_skipped", "goal_skipped");

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      codexExecTimeout: 10,
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => makeRepoPlan("task_skipped", tmpDir, "github.com/acme/repo"),
      materializeTaskWorktreeFn: async (plan) => ({
        lock_repo_path: plan.worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.worktree_path, branch_name: "gptwork/task/task_skipped", created_at: new Date().toISOString() },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: null }),
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        summary: "code change",
        parsedResult: { structured: true, status: "completed", summary: "code change", changed_files: ["src/app.mjs"], tests: "pass", commit: "abc123", acceptance_findings: [] },
      }),
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        // skipped is explicitly terminal — integration was bypassed, e.g. mode=none
        assert.equal(taskStatus, "completed", "skipped integration is terminal → completed");
        assert.equal(taskResult.integration.status, "skipped");
        return { task_id: task.id, status: taskStatus, kind: taskResult.kind };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async (opts) => ({
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["src/app.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "All checks passed", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "repair possible" }),
      createRepairGoalFromFindingsFn: async (opts) => ({ id: "repair_mock", parent_task_id: task.id }),
      runIntegrationQueueFn: async (opts) => {
        // mode=none returns skipped with merged:false — but skipped is terminal by design
        return { ok: true, status: "skipped", merged: false, pushed: false, pr_opened: false };
      },
      createGoalFn: async () => ({ goal: { id: "repair_goal_mock" }, task: { id: "repair_task_mock" } }),
    });

    assert.equal(result.status, "completed", "skipped integration should result in completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Helpers for PR0 integration tests
// ===========================================================================

/**
 * Create a StateStore with a pre-populated hosted workspace.
 */
/**
 * Create a StateStore with a pre-populated hosted workspace and a single task.
 * The state is written to a file before loading so that RocksDB-based indexes
 * are properly populated.
 *
 * @param {string} tmpDir - Temp directory for state file
 * @param {string} taskId - Task ID to create (optional)
 * @param {string} goalId - Goal ID to create (optional)
 * @param {object} [overrides] - Extra fields to set on the task
 * @returns {{ store: object, task: object|null, goal: object|null, now: string }}
 */
function createTaskStore(tmpDir, taskId, goalId, overrides = {}) {
  const now = new Date().toISOString();
  const convId = "conv_" + (goalId || "default");

  const goal = goalId ? {
    id: goalId,
    project_id: "default",
    workspace_id: "hosted-default",
    conversation_id: convId,
    user_request: "Test " + taskId,
    goal_prompt: "Goal prompt for " + taskId,
    title: "Test " + taskId,
    created_by: "user_default",
    assignee: "codex",
    status: "assigned",
    mode: "builder",
    created_at: now,
    updated_at: now,
  } : null;

  const conversation = {
    id: convId,
    goal_id: goal ? goal.id : "none",
    project_id: "default",
    workspace_id: "hosted-default",
    messages: [{ role: "user", content: "Test", id: "msg_1", author_id: "user_default", created_at: now }],
    created_at: now,
    updated_at: now,
  };

  const task = taskId ? {
    id: taskId,
    project_id: "default",
    workspace_id: "hosted-default",
    goal_id: goal ? goal.id : null,
    conversation_id: convId,
    title: "Test " + taskId,
    description: "Test description for " + taskId,
    created_by: "user_default",
    assignee: "codex",
    status: "assigned",
    mode: "builder",
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } : null;

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Workspace", type: "hosted", root: tmpDir, default: true, created_at: now, updated_at: now }],
    goals: goal ? [goal] : [],
    conversations: [conversation],
    memories: [],
    tasks: task ? [task] : [],
    activities: [],
  };

  const statePath = join(tmpDir, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  const store = new StateStore({ statePath, defaultWorkspaceRoot: tmpDir });
  return { store, task, goal, now };
}

const ctx = {
  user_id: "test_user",
  project_ids: ["*"],
  workspace_ids: ["*"],
  scopes: ["task:create", "task:update", "workspace:read", "project:read", "workspace:write"],
};

console.log("task-general-processor PR0 integration tests loaded");

/**
 * Create a mock repo plan for testing.
 */
function makeRepoPlan(taskId, tmpDir, repoId) {
  const worktreePath = join(tmpDir, ".gptwork", "worktrees", repoId.replace(/\//g, "-"), taskId);
  mkdirSync(worktreePath, { recursive: true });
  return {
    repo_id: repoId,
    canonical_repo_path: join(tmpDir, "canonical", repoId.replace(/\//g, "-")),
    task_id: taskId,
    task_worktree_path: worktreePath,
    uses_default_fallback: false,
    worktree_lifecycle: null,
  };
}

test("processGeneralTaskWithDeps routes execution through selected agent backend", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-agent-backend-route-"));
  try {
    const { store, task } = createTaskStore(tmpDir, "task_backend_route", "goal_backend_route", { role: "verifier" });
    await store.load();
    const plan = makeRepoPlan("task_backend_route", tmpDir, "github.com/acme/repo");
    const calls = [];

    const result = await processGeneralTaskWithDeps(store, {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: plan.canonical_repo_path,
      codexExecTimeout: 10,
      agentBackend: "codex_exec",
      agentRoleBackends: { verifier: "null" },
    }, task, ctx, {}, {
      resolveTaskRepositoryPlanFn: async () => plan,
      materializeTaskWorktreeFn: async () => ({
        lock_repo_path: plan.task_worktree_path,
        worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: plan.task_worktree_path, branch_name: "gptwork/task/task_backend_route" },
      }),
      acquireRepoLockFn: async () => ({ acquired: true }),
      prepareCodexTaskRunFn: async () => ({ promptFile: join(tmpDir, "prompt.txt"), runFilePath: null, runId: "run_backend" }),
      executeCodexTaskRunFn: async () => {
        throw new Error("legacy codex executor should not be called when verifier routes to null backend");
      },
      executeAgentBackendRunFn: async ({ task: routedTask, role, executionCwd }) => {
        calls.push({ type: "execute", role, taskRole: routedTask.role, executionCwd });
        return {
          backend: "null",
          cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
          summary: "null backend completed",
          parsedResult: {
            structured: true,
            status: "completed",
            summary: "null backend completed",
            backend: "null",
            role,
            changed_files: [],
            tests: "null backend: no-op",
            warnings: [],
            followups: [],
            acceptance_findings: [],
          },
        };
      },
      finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
        calls.push({ type: "finalize", taskStatus, taskResult });
        return { task_id: task.id, status: taskStatus, backend: taskResult.execution_backend };
      },
      appendGoalMessageFn: async () => {},
      selectWorkspaceFn: async () => ({ type: "hosted", root: tmpDir, id: "hosted-default" }),
      runAcceptanceAgentFn: async () => ({
        passed: true,
        status: "accepted",
        profile: "default",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        reviewer_decision: { role: "acceptance_agent", summary: "accepted", decision: { status: "accepted", passed: true } },
      }),
      shouldAttemptRepairFn: async () => ({ should_repair: false, reason: "mock" }),
      createRepairGoalFromFindingsFn: async () => ({ id: "mock_repair" }),
      runIntegrationQueueFn: async () => ({ ok: true, status: "completed" }),
      createGoalFn: async () => ({ goal: {}, task: {} }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.backend, "null");
    assert.deepEqual(calls.map((call) => call.type), ["execute", "finalize"]);
    const finalized = calls.find((call) => call.type === "finalize").taskResult;
    assert.equal(finalized.execution_backend, "null");
    assert.equal(finalized.execution_backend_role, "verifier");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
