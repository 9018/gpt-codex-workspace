/**
 * task-repo-resolution.mjs — Repository resolution and worktree lifecycle.
 *
 * Two-phase approach:
 *   1. resolveTaskRepositoryPlan — plan only, no git mutation (safe for queue/dry-run)
 *   2. materializeTaskWorktree — actual git worktree creation (only during execution)
 */

import { getTaskWorktreePath, ensureTaskWorktree, sanitizeTaskBranchName } from './task-worktree-manager.mjs';

export function deriveTaskRepoId(task = {}, goal = {}) {
  return task.repo_id || goal.repo_id || task.repository_id || goal.repository_id || '';
}

/**
 * Resolve a task's repository plan WITHOUT creating a worktree.
 * This is safe to call from queue/dry-run — no git mutation.
 *
 * Returns enough information for the queue to decide eligibility and for
 * materializeTaskWorktree to finish the job.
 */
export async function resolveTaskRepositoryPlan({ task = {}, goal = {}, config = {}, registry = null } = {}) {
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
  const targetBranch = record?.default_branch || config.defaultBranch || 'HEAD';
  const taskId = task.id || goal.task_id || goal.id || 'unknown-task';
  const taskWorktreePath = getTaskWorktreePath(workspaceRoot, repoId, taskId);
  const taskBranch = sanitizeTaskBranchName(taskId);

  const plan = {
    repo_id: repoId,
    canonical_repo_path: canonicalRepoPath,
    task_id: taskId,
    source_root: canonicalRepoPath,
    target_branch: targetBranch,
    base_ref: targetBranch,
    base_sha: null, // resolved during materialization
    task_branch: taskBranch,
    task_worktree_path: taskWorktreePath,
    dirty_source: false,
    dirty_paths: [],
    uses_default_fallback: !record && !explicitRepoId,
    worktree_lifecycle: null, // set during materialization
  };

  return plan;
}

/**
 * Resolve a task's repository, falling back to current behavior for backward compat.
 * Calls resolveTaskRepositoryPlan + materializes worktree (legacy behavior).
 */
export async function resolveTaskRepository({ task = {}, goal = {}, config = {}, registry = null } = {}) {
  const plan = await resolveTaskRepositoryPlan({ task, goal, config, registry });
  if (config.enableTaskWorktrees !== false) {
    const materialized = await materializeTaskWorktree(plan, { config });
    return {
      ...plan,
      ...materialized,
    };
  }
  return plan;
}

/**
 * Materialize a Git worktree from a previously resolved plan.
 * This is the ONLY function that performs git mutation (worktree add).
 * Must be called only during materializing_worktree stage, not during queue/dry-run.
 *
 * @param {object} plan - Resolved plan from resolveTaskRepositoryPlan
 * @param {object} options
 * @param {object} [options.config]
 * @returns {Promise<object>} Materialization result with worktree_lifecycle metadata
 */
export async function materializeTaskWorktree(plan, { config = {} } = {}) {
  const {
    repo_id,
    canonical_repo_path: canonicalRepoPath,
    task_branch: branchName,
    task_worktree_path: worktreePath,
    base_ref: baseRef,
  } = plan;

  const workspaceRoot = config.defaultWorkspaceRoot || config.defaultWorkspaceRootPath || process.cwd();

  // Resolve base_sha if possible
  let baseSha = null;
  const { execFileSync } = await import('node:child_process');
  try {
    const stdout = execFileSync('git', ['rev-parse', baseRef || 'HEAD'], {
      cwd: canonicalRepoPath,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    baseSha = stdout.trim();
  } catch {
    // non-fatal, worktree add will resolve it
  }

  const ensured = await ensureTaskWorktree(repo_id, plan.task_id, {
    workspaceRoot,
    canonicalRepoPath,
    worktreePath,
    baseRef: baseSha || baseRef || 'HEAD',
    branchName,
  });

  const now = new Date().toISOString();

  return {
    lock_repo_path: ensured.ok ? ensured.worktree_path || worktreePath : canonicalRepoPath,
    worktree_lifecycle: {
      mode: ensured.ok ? 'git_worktree' : 'metadata_only',
      ok: ensured.ok === true,
      source_root: canonicalRepoPath,
      base_ref: baseRef,
      base_sha: baseSha,
      branch_name: branchName,
      worktree_path: ensured.worktree_path || worktreePath,
      dirty_source: ensured.dirty_source || plan.dirty_source || false,
      dirty_paths: ensured.dirty_paths || plan.dirty_paths || [],
      created_at: now,
      cleanup_policy: process.env.GPTWORK_WORKTREE_CLEANUP_POLICY || 'remove_on_success_retain_on_failure',
      error: ensured.ok ? null : (ensured.error || null),
      lifecycle_events: ensured.ok ? [
        {
          event: ensured.git_worktree_created === true ? 'git_worktree_add' : 'git_worktree_reuse',
          ok: ensured.ok === true,
          worktree_path: ensured.worktree_path || worktreePath,
          branch_name: branchName,
          base_ref: baseSha || baseRef,
        },
      ] : [],
    },
  };
}
