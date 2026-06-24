import { join } from 'node:path';

export function deriveTaskRepoId(task = {}, goal = {}) {
  return task.repo_id || goal.repo_id || task.repository_id || goal.repository_id || '';
}

export async function resolveTaskRepository({ task = {}, goal = {}, config = {}, registry = null } = {}) {
  const workspaceRoot = config.defaultWorkspaceRoot || config.defaultWorkspaceRootPath || process.cwd();
  const explicitRepoId = deriveTaskRepoId(task, goal);

  if (registry && typeof registry.load === 'function') {
    try { await registry.load(); } catch {}
  }

  let record = null;
  if (explicitRepoId && registry && typeof registry.get === 'function') {
    record = registry.get(explicitRepoId);
  }
  if (!record && !explicitRepoId && registry && typeof registry.getDefaultRepo === 'function') {
    record = registry.getDefaultRepo();
  }

  const repoId = record?.repo_id || explicitRepoId || 'default';
  const canonicalRepoPath = record?.canonical_path || config.defaultRepoPath || config.defaultWorkspaceRoot || workspaceRoot;
  const taskId = task.id || goal.task_id || goal.id || 'unknown-task';
  const taskWorktreePath = join(workspaceRoot, 'worktrees', repoId, taskId);

  return {
    repo_id: repoId,
    canonical_repo_path: canonicalRepoPath,
    lock_repo_path: canonicalRepoPath,
    task_worktree_path: taskWorktreePath,
    uses_default_fallback: !record && !explicitRepoId,
    worktree_lifecycle: {
      mode: 'metadata_only',
      git_worktree_created: false,
      cleanup_supported: false,
      recoverable_after_crash: true,
    },
  };
}

