/**
 * task-general-processor.test.mjs
 * Tests for task-general-processor, including non-hosted workspace handling (P1.1).
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    const taskWorktreePath = join(tmpDir, "worktrees", "github.com-acme-repo", "task_worktree_chain");
    let observedExecutionCwd = null;
    let finalizedTaskResult = null;
    let finalizedResolvedRepo = null;
    let resolvedCalled = false;
    let acquiredLockPath = null;

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
      resolveTaskRepositoryFn: async () => {
        resolvedCalled = true;
        return {
          repo_id: "github.com/acme/repo",
          canonical_repo_path: join(tmpDir, "canonical"),
          lock_repo_path: taskWorktreePath,
          task_worktree_path: taskWorktreePath,
          uses_default_fallback: false,
          worktree_lifecycle: {
            mode: "git_worktree",
            ok: true,
            cleanup_supported: true,
            git_worktree_created: true,
            created_during_run: true,
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
    });

    assert.equal(result.status, "completed");
    assert.equal(resolvedCalled, true);
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
