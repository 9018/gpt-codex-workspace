/**
 * codex-tui-task-worktree.test.mjs — Tests that the Codex TUI startup
 * materializes and uses task_worktree_path as cwd for isolated per-task
 * worktree execution.
 *
 * Acceptance criteria G2-1 & G2-3:
 *   - TUI startup materializes and uses task_worktree_path as cwd
 *   - Two tasks can start with distinct worktrees and no canonical checkout writes
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";
import { createCodexTuiToolsGroup } from "../src/tool-groups/codex-tui-tools-group.mjs";
import { createExecutionStore } from "../src/executions/execution-store.mjs";

afterEachHook(test);

function fakeTool(descriptor) {
  return {
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    handler: descriptor.handler,
    metadata: { modes: descriptor.modes || [], audience: descriptor.audience || [], tags: descriptor.tags || [] },
  };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

function makeStore(state) {
  return {
    async load() { return state; },
    async save() {},
  };
}

async function makeGitRepo(prefix) {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeState(repo, taskId, goalId) {
  return {
    tasks: [{ id: taskId, title: "Worktree TUI test", goal_id: goalId, mode: "builder" }],
    goals: [{ id: goalId, task_id: taskId, title: "Worktree TUI test goal" }],
  };
}

// ===========================================================================
// G2-1: TUI startup materializes and uses task_worktree_path as cwd
// ===========================================================================

test("G2-1: codex_tui_start_goal materializes worktree and uses it as cwd", async () => {
  const repo = await makeGitRepo("g2-1-wt-cwd-");
  const taskId = "task_wt_cwd";
  const goalId = "goal_wt_cwd";

  const materializationCalls = [];
  let acquiredLockPath = null;

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, goalId)),
    config: {
      defaultWorkspaceRoot: repo,
      defaultRepoPath: repo,
      codexTuiEnabled: true,
      enableTaskWorktrees: true,
    },
    resolveTaskRepositoryPlanFn: async ({ task, goal, config }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "test-repo",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        target_branch: "main",
        base_ref: "HEAD",
        base_sha: null,
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "test-repo", task.id),
        dirty_source: false,
        dirty_paths: [],
        uses_default_fallback: false,
        worktree_lifecycle: null,
      };
    },
    materializeTaskWorktreeFn: async (plan, { config }) => {
      const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
      materializationCalls.push({ plan });
      const result = await ensureTaskWorktree(plan.repo_id, plan.task_id, {
        workspaceRoot: repo,
        canonicalRepoPath: plan.canonical_repo_path,
        baseRef: "HEAD",
      });
      return {
        worktree_lifecycle: {
          ok: result.ok,
          mode: "git_worktree",
          source_root: plan.canonical_repo_path,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: result.branch_name,
          worktree_path: result.worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: result.ok ? null : result.error,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async (workspaceRoot, repoPath, opts) => {
      acquiredLockPath = repoPath;
      return { acquired: true, lock: { safe_repo_id: "safe_repo", task_id: opts.taskId, status: "held" } };
    },
    startCodexTuiGoalSessionFn: async ({ task, goal, cwd, repoLockId }) => {
      return { id: `session_${task.id}`, task_id: task.id, goal_id: goal.id, cwd, status: "running" };
    },
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});

  // Must have succeeded
  assert.equal(result.kind, "codex_tui_session_started");
  assert.equal(result.task_id, taskId);
  assert.equal(result.goal_id, goalId);
  assert.equal(result.status, "running");

  // cwd must be the task worktree path, NOT the canonical repo path
  assert.notEqual(result.cwd, repo, "cwd must not be the canonical repo path");
  assert.ok(result.cwd.includes(".gptwork/worktrees"), "cwd must be under .gptwork/worktrees");
  assert.ok(result.cwd.includes(taskId), "cwd must contain the task ID");
  assert.equal(result.cwd, result.worktree_path, "cwd must equal worktree_path");

  // Lock must be on the worktree path
  assert.equal(acquiredLockPath, result.cwd, "Lock must be acquired on the worktree path, not canonical repo");

  // Materialization must have been called
  assert.equal(materializationCalls.length, 1);
  assert.ok(materializationCalls[0].plan.task_worktree_path, "Plan must include task_worktree_path");

  // Clean up worktree
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "test-repo", canonicalRepoPath: repo });
});

test("G2-1: codex_tui_start_goal reports failure when worktree materialization fails", async () => {
  const repo = await makeGitRepo("g2-1-wt-fail-");
  const taskId = "task_wt_fail";

  const state = makeState(repo, taskId, "goal_wt_fail");
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(state),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    resolveTaskRepositoryPlanFn: async () => ({
      canonical_repo_path: "/nonexistent/repo",
      source_root: "/nonexistent/repo",
      task_worktree_path: "/nonexistent/worktree",
    }),
    materializeTaskWorktreeFn: async () => ({
      worktree_lifecycle: { ok: false, error: "worktree add failed: repository not found" },
    }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});
  assert.equal(result.kind, "codex_tui_worktree_failed");
  assert.equal(result.status, "blocked");
  assert.equal(state.tasks[0].metadata?.tui_session_owner, undefined);
  assert.equal(state.tasks[0].metadata?.manual_tui_session_starting, undefined);
});

// ===========================================================================
// G2-3: Two tasks can start with distinct worktrees and no canonical writes
// ===========================================================================

test("G2-3: two tasks get distinct worktree paths and cwds", async () => {
  const repo = await makeGitRepo("g2-3-two-wts-");

  const taskIds = ["task_alpha", "task_beta"];
  const goalIds = ["goal_alpha", "goal_beta"];
  const results = [];
  const lockPaths = [];

  for (let i = 0; i < taskIds.length; i++) {
    const tools = createCodexTuiToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      store: makeStore(makeState(repo, taskIds[i], goalIds[i])),
      config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true, enableTaskWorktrees: true },
      resolveTaskRepositoryPlanFn: async ({ task }) => {
        const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
        return {
          repo_id: "test-repo",
          canonical_repo_path: repo,
          source_root: repo,
          task_id: task.id,
          target_branch: "main",
          base_ref: "HEAD",
          task_branch: sanitizeTaskBranchName(task.id),
          task_worktree_path: getTaskWorktreePath(repo, "test-repo", task.id),
          dirty_source: false,
          dirty_paths: [],
        };
      },
      materializeTaskWorktreeFn: async (plan) => {
        const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
        const result = await ensureTaskWorktree(plan.repo_id, plan.task_id, {
          workspaceRoot: repo,
          canonicalRepoPath: repo,
          baseRef: "HEAD",
        });
        return {
          worktree_lifecycle: {
            ok: result.ok,
            mode: "git_worktree",
            source_root: repo,
            base_ref: "HEAD",
            base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
            branch_name: result.branch_name,
            worktree_path: result.worktree_path,
            dirty_source: false,
            dirty_paths: [],
            created_at: new Date().toISOString(),
            error: result.ok ? null : result.error,
            lifecycle_events: [],
          },
        };
      },
      acquireRepoLockFn: async (wsRoot, repoPath, opts) => {
        lockPaths.push(repoPath);
        return { acquired: true, lock: { safe_repo_id: "safe_repo", task_id: opts.taskId, status: "held" } };
      },
      startCodexTuiGoalSessionFn: async ({ cwd }) => ({ id: "session", cwd, status: "running" }),
    });

    const result = await tools.codex_tui_start_goal.handler({ task_id: taskIds[i] }, {});
    results.push(result);
  }

  // Both must succeed
  assert.equal(results[0].status, "running", "Task alpha should succeed");
  assert.equal(results[1].status, "running", "Task beta should succeed");

  // Worktree paths must be different
  assert.notEqual(results[0].cwd, results[1].cwd, "Two tasks must have different cwds");
  assert.notEqual(results[0].worktree_path, results[1].worktree_path, "Two tasks must have different worktree paths");

  // Each cwd must be a git worktree
  for (const result of results) {
    const gitCheck = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: result.cwd,
      encoding: "utf8",
    }).trim();
    assert.equal(gitCheck, "true", `Worktree ${result.cwd} must be a valid git worktree`);
  }

  // Canonical repo must remain clean (no changes in canonical)
  const canonicalStatus = execFileSync("git", ["status", "--short"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  assert.equal(canonicalStatus, "", "Canonical repo must remain clean");

  // Locks must have been acquired on different worktree paths
  assert.notEqual(lockPaths[0], lockPaths[1], "Locks must be on different worktree paths");

  // Clean up worktrees
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  for (const taskId of taskIds) {
    await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "test-repo", canonicalRepoPath: repo });
  }
});

// ===========================================================================
// G2-X: Execution store records worktree metadata for each task
// ===========================================================================

test("G2-X: execution store records worktree_path, branch, and commits for each task", async () => {
  const repo = await makeGitRepo("g2-x-exec-store-");
  const execStore = createExecutionStore({ workspaceRoot: repo });

  const execA = await execStore.createExecution({
    executionId: "exec_task_a",
    workstreamId: "ws_test",
    goalId: "goal_a",
    taskId: "task_a",
    worktreePath: join(repo, ".gptwork", "worktrees", "test-repo", "task_a"),
    branch: "gptwork/task/task_a",
    baseCommit: "abc123",
    sessionId: "session_a",
  });

  const execB = await execStore.createExecution({
    executionId: "exec_task_b",
    workstreamId: "ws_test",
    goalId: "goal_b",
    taskId: "task_b",
    worktreePath: join(repo, ".gptwork", "worktrees", "test-repo", "task_b"),
    branch: "gptwork/task/task_b",
    baseCommit: "def456",
    sessionId: "session_b",
  });

  // Verify distinct paths
  assert.notEqual(execA.worktree_path, execB.worktree_path);
  assert.notEqual(execA.branch, execB.branch);

  // Verify full metadata
  assert.equal(execA.workstream_id, "ws_test");
  assert.equal(execA.goal_id, "goal_a");
  assert.equal(execA.task_id, "task_a");
  assert.equal(execA.base_commit, "abc123");
  assert.equal(execA.session_id, "session_a");

  assert.equal(execB.workstream_id, "ws_test");
  assert.equal(execB.goal_id, "goal_b");
  assert.equal(execB.task_id, "task_b");
  assert.equal(execB.base_commit, "def456");
  assert.equal(execB.session_id, "session_b");

  // Update with head_commit
  await execStore.updateExecution(execA.id, { head_commit: "zzz999", status: "completed" });
  const updated = await execStore.readExecution(execA.id);
  assert.equal(updated.head_commit, "zzz999");
  assert.equal(updated.status, "completed");

  // Find executions by task_id
  const found = await execStore.findExecutions({ task_id: "task_a" });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, execA.id);
});
