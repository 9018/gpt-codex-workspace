/**
 * execution-service.test.mjs — Tests for the execution service that orchestrates
 * worktree-based TUI execution.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutionService } from "../src/executions/execution-service.mjs";
import { createExecutionStore } from "../src/executions/execution-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
}

function makeStore(state) {
  return {
    async load() { return state; },
    async save() {},
  };
}

// ===========================================================================
// verifyTaskWorktree
// ===========================================================================

test("verifyTaskWorktree returns invalid for non-existent path", () => {
  const service = createExecutionService({
    store: makeStore({ tasks: [], goals: [] }),
    config: { defaultWorkspaceRoot: "/tmp" },
    resolveTaskRepositoryPlanFn: async () => ({}),
    materializeTaskWorktreeFn: async () => ({}),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = service.verifyTaskWorktree({
    worktreePath: "/nonexistent/path",
    plan: {},
  });

  assert.equal(result.valid, false);
  assert.ok(result.error.includes("does not exist"));
});

test("verifyTaskWorktree requires worktreePath", () => {
  const service = createExecutionService({
    store: makeStore({ tasks: [], goals: [] }),
    config: { defaultWorkspaceRoot: "/tmp" },
    resolveTaskRepositoryPlanFn: async () => ({}),
    materializeTaskWorktreeFn: async () => ({}),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = service.verifyTaskWorktree({});
  assert.equal(result.valid, false);
  assert.ok(result.error.includes("required"));
});

test("verifyTaskWorktree validates path is within workspace", async () => {
  const repo = track(await mkdtemp(join(tmpdir(), "g2-verify-escape-")));
  await initGitRepo(repo);

  const service = createExecutionService({
    store: makeStore({ tasks: [], goals: [] }),
    config: { defaultWorkspaceRoot: repo },
    resolveTaskRepositoryPlanFn: async () => ({}),
    materializeTaskWorktreeFn: async () => ({}),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = service.verifyTaskWorktree({
    worktreePath: "/tmp/escape-attempt",
    plan: {},
  });

  assert.equal(result.valid, false);
});

// ===========================================================================
// startExecutionWithWorktree — full flow
// ===========================================================================

test("startExecutionWithWorktree runs full resolve -> materialize -> verify -> lock -> create -> start flow", async () => {
  const repo = track(await mkdtemp(join(tmpdir(), "g2-exec-flow-")));
  await initGitRepo(repo);

  const taskId = "task_full_flow";
  const goalId = "goal_full_flow";

  const state = {
    tasks: [{ id: taskId, title: "Full flow test", goal_id: goalId, mode: "builder" }],
    goals: [{ id: goalId, task_id: taskId, title: "Full flow goal" }],
  };

  const plan = {
    canonical_repo_path: repo,
    source_root: repo,
    task_id: taskId,
    base_ref: "HEAD",
    task_branch: "gptwork/task/task_full_flow",
    repo_id: "test-repo",
  };

  const resolvePlanFn = async () => plan;
  const materializeFn = async (pl) => {
    const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
    const result = await ensureTaskWorktree("test-repo", pl.task_id, {
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
  };

  let acquiredPath = null;
  let releasedPath = null;
  let tuiStarted = false;

  const service = createExecutionService({
    store: makeStore(state),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo },
    resolveTaskRepositoryPlanFn: resolvePlanFn,
    materializeTaskWorktreeFn: materializeFn,
    acquireRepoLockFn: async (wsRoot, path, opts) => {
      acquiredPath = path;
      return { acquired: true, lock: { safe_repo_id: "safe_repo", task_id: opts.taskId, status: "held" } };
    },
    releaseRepoLockFn: async (wsRoot, path, taskId) => {
      releasedPath = path;
    },
    startTuiSessionFn: async ({ task, goal, cwd, repoLockId, execution }) => {
      tuiStarted = true;
      assert.equal(cwd, acquiredPath, "TUI cwd must equal lock path (worktree path)");
      return { id: "session_full_flow", session_id: "session_full_flow", cwd, status: "running" };
    },
    workstreamId: "ws_test_full_flow",
  });

  const result = await service.startExecutionWithWorktree({ taskId });

  assert.equal(result.status, "running");
  assert.equal(result.kind, "execution_started");
  assert.equal(result.task_id, taskId);
  assert.equal(result.goal_id, goalId);
  assert.ok(result.worktree_path, "Must have worktree_path");
  assert.ok(result.worktree_path.includes(".gptwork/worktrees"), "Must be under worktrees dir");
  assert.ok(result.execution_id, "Must have execution_id");
  assert.ok(result.session_id, "Must have session_id");
  assert.ok(result.base_commit, "Must have base_commit");
  assert.ok(tuiStarted, "TUI session must have been started");
  assert.ok(acquiredPath === result.worktree_path, "Lock must be on worktree path");
  assert.ok(acquiredPath !== repo, "Lock must not be on canonical repo path");

  // Verify execution record
  const execStore = createExecutionStore({ workspaceRoot: repo });
  const execRecord = await execStore.readExecution(result.execution_id);
  assert.equal(execRecord.workstream_id, "ws_test_full_flow");
  assert.equal(execRecord.goal_id, goalId);
  assert.equal(execRecord.task_id, taskId);
  assert.equal(execRecord.worktree_path, result.worktree_path);
  assert.equal(execRecord.session_id, result.session_id);

  // Clean up worktree
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "test-repo", canonicalRepoPath: repo });
});

test("startExecutionWithWorktree fails gracefully when task not found", async () => {
  const service = createExecutionService({
    store: makeStore({ tasks: [], goals: [] }),
    config: { defaultWorkspaceRoot: "/tmp" },
    resolveTaskRepositoryPlanFn: async () => ({}),
    materializeTaskWorktreeFn: async () => ({}),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = await service.startExecutionWithWorktree({ taskId: "nonexistent" });
  assert.equal(result.status, "failed");
  assert.equal(result.kind, "task_not_found");
});

test("startExecutionWithWorktree fails gracefully when goal not found", async () => {
  const service = createExecutionService({
    store: makeStore({ tasks: [{ id: "task_no_goal" }], goals: [] }),
    config: { defaultWorkspaceRoot: "/tmp" },
    resolveTaskRepositoryPlanFn: async () => ({}),
    materializeTaskWorktreeFn: async () => ({}),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = await service.startExecutionWithWorktree({ taskId: "task_no_goal" });
  assert.equal(result.status, "failed");
  assert.equal(result.kind, "goal_not_found");
});

test("startExecutionWithWorktree fails when materialization fails", async () => {
  const repo = track(await mkdtemp(join(tmpdir(), "g2-exec-fail-")));
  await initGitRepo(repo);

  const state = {
    tasks: [{ id: "task_fail_mat", goal_id: "goal_fail_mat", mode: "builder" }],
    goals: [{ id: "goal_fail_mat", task_id: "task_fail_mat" }],
  };

  const service = createExecutionService({
    store: makeStore(state),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo },
    resolveTaskRepositoryPlanFn: async () => ({
      canonical_repo_path: "/nonexistent",
      task_id: "task_fail_mat",
      task_worktree_path: "/nonexistent/wt",
    }),
    materializeTaskWorktreeFn: async () => ({
      worktree_lifecycle: { ok: false, error: "worktree add failed" },
    }),
    acquireRepoLockFn: async () => ({ acquired: true }),
  });

  const result = await service.startExecutionWithWorktree({ taskId: "task_fail_mat" });
  assert.equal(result.status, "failed");
  assert.equal(result.kind, "worktree_materialization_failed");
});
