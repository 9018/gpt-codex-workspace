import { assertGoalId, goalBranchName } from './goal-worktree-service.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return stdout.trim();
}

export async function ensureGoalBranch({ goalId, config }) {
  const id = assertGoalId(goalId);
  const branch = goalBranchName({ config, goalId: id });
  const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
  const baseBranch = config.mergeTargetBranch || config.defaultBranch || 'main';

  try {
    await git(repoPath, ['rev-parse', '--verify', branch]);
    return { branch, existed: true };
  } catch {
    await git(repoPath, ['checkout', '-b', branch, baseBranch]);
    return { branch, existed: false };
  }
}

export async function deleteGoalBranch({ goalId, config }) {
  const id = assertGoalId(goalId);
  const branch = goalBranchName({ config, goalId: id });
  const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
  const baseBranch = config.mergeTargetBranch || config.defaultBranch || 'main';
  // Switch to base branch first in case the target branch is checked out
  try { await git(repoPath, ['checkout', baseBranch]); } catch {}
  try {
    // If the branch has a worktree, remove it first
    const worktreePath = (await import('./goal-worktree-service.mjs')).goalWorktreePath({ config, goalId: id });
    try { await git(repoPath, ['worktree', 'remove', '--force', worktreePath]); } catch {}
  } catch { /* non-fatal */ }
  await git(repoPath, ['branch', '-D', branch]);
}
