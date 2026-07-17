import test from "node:test";
import assert from "node:assert/strict";

import { executeWorktreeCleanupCommand, releaseFinalizationRepoLock } from "../../src/task-finalization/worktree-cleanup.mjs";

test("executeWorktreeCleanupCommand removes the command worktree and returns audit evidence", async () => {
  const calls = [];
  const command = {
    id: "pcmd_cleanup_1",
    action: "cleanup_worktree",
    task_id: "task_cleanup",
    payload: {
      task_id: "task_cleanup",
      worktree_path: "/tmp/gptwork-task-cleanup",
    },
  };

  const result = await executeWorktreeCleanupCommand(command, {
    config: {
      defaultWorkspaceRoot: "/workspace",
      defaultRepoPath: "/workspace/repo",
    },
    task: {
      id: "task_cleanup",
      repo_id: "repo-main",
      result: {
        repo_resolution: {
          canonical_repo_path: "/workspace/repo",
        },
      },
    },
    removeTaskWorktreeFn: async (taskId, options) => {
      calls.push({ taskId, options });
      return { ok: true, removed: true, worktree_path: options.worktreePath };
    },
  });

  assert.deepEqual(calls, [{
    taskId: "task_cleanup",
    options: {
      workspaceRoot: "/workspace",
      repoId: "repo-main",
      canonicalRepoPath: "/workspace/repo",
      worktreePath: "/tmp/gptwork-task-cleanup",
    },
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.action, "cleanup_worktree");
  assert.equal(result.task_id, "task_cleanup");
  assert.equal(result.worktree_path, "/tmp/gptwork-task-cleanup");
});

test("releaseFinalizationRepoLock preserves scheduled restart state", async () => {
  const releases = [];
  const scheduled = await releaseFinalizationRepoLock({
    config: { defaultWorkspaceRoot: "/workspace" },
    task: { id: "task_restart" },
    repoLockPath: "/workspace/.gptwork/locks/repo.lock",
    loadRestartMarkerFn: async () => ({ status: "scheduled" }),
    releaseRepoLockFn: async (...args) => releases.push(args),
  });

  assert.equal(scheduled.kept_for_restart, true);
  assert.deepEqual(releases[0], [
    "/workspace",
    "/workspace/.gptwork/locks/repo.lock",
    "task_restart",
    { restartState: "scheduled" },
  ]);

  const normalReleases = [];
  const normal = await releaseFinalizationRepoLock({
    config: { defaultWorkspaceRoot: "/workspace" },
    task: { id: "task_normal" },
    repoLockPath: "/workspace/.gptwork/locks/repo.lock",
    loadRestartMarkerFn: async () => null,
    releaseRepoLockFn: async (...args) => normalReleases.push(args),
  });

  assert.equal(normal.kept_for_restart, false);
  assert.deepEqual(normalReleases[0], ["/workspace", "/workspace/.gptwork/locks/repo.lock", "task_normal"]);
});
