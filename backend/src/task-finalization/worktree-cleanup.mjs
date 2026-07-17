import { removeTaskWorktree } from "../task-worktree-manager.mjs";

export async function executeWorktreeCleanupCommand(command = {}, {
  config = {},
  task = {},
  removeTaskWorktreeFn = removeTaskWorktree,
} = {}) {
  const taskId = command.payload?.task_id || command.task_id || task.id;
  const worktreePath = command.payload?.worktree_path || task.worktree_path || task.worktree?.path || null;
  if (!taskId) throw new TypeError("cleanup_worktree command requires task_id");
  if (!worktreePath) throw new TypeError("cleanup_worktree command requires worktree_path");

  const repoResolution = task.result?.repo_resolution || {};
  const cleanup = await removeTaskWorktreeFn(taskId, {
    workspaceRoot: config.defaultWorkspaceRoot,
    repoId: task.repo_id || repoResolution.repo_id || "default",
    canonicalRepoPath: repoResolution.canonical_repo_path || config.defaultRepoPath,
    worktreePath,
  });

  return {
    action: "cleanup_worktree",
    task_id: taskId,
    worktree_path: worktreePath,
    ...cleanup,
  };
}
