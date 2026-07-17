import test from "node:test";
import assert from "node:assert/strict";

import { executeWorktreeCleanupCommand } from "../../src/task-finalization/worktree-cleanup.mjs";

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
