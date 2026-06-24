/**
 * integration-queue.mjs — Serial integration queue for same repo/branch.
 *
 * Ensures that tasks targeting the same repository and target branch
 * are integrated (merged/rebase/pushed) serially to avoid conflicts.
 */

import { execFileSync } from 'node:child_process';
import { acquireRepoLock, releaseRepoLock, forceReleaseRepoLock, safeRepoId, getLocksDir } from './repo-lock.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INTEGRATION_LOCKS = new Map();

/**
 * Run the integration queue for a given repo and target branch.
 * Only one integration runs per (repo_id, target_branch) pair at a time.
 *
 * @param {object} options
 * @param {string} options.repoId - Repository ID
 * @param {string} options.targetBranch - Target branch name
 * @param {string} options.worktreePath - Path to the task worktree
 * @param {string} options.canonicalRepoPath - Path to canonical repo
 * @param {string} options.taskBranch - Task branch name
 * @param {string} [options.integrationMode] - Integration mode: local_merge|push_branch|open_pr|none
 * @param {Array} [options.checkCommands] - Integration check commands
 * @returns {Promise<{ ok: boolean, status: string, merged: boolean, pushed: boolean, pr_opened: boolean, error?: string, conflict_files?: string[] }>}
 */
export async function runIntegrationQueue({
  repoId, targetBranch, worktreePath, canonicalRepoPath, taskBranch,
  integrationMode, checkCommands, locksBasePath, taskId,
} = {}) {
  const lockKey = `integration:${repoId}:${targetBranch}`;
  const mode = integrationMode || process.env.GPTWORK_INTEGRATION_MODE || 'push_branch';
  const integrationLockPath = `integration:${safeRepoId(repoId)}:${targetBranch}`;

  // Acquire integration lock — file-based when locksBasePath provided, Map fallback
  const useFileLock = Boolean(locksBasePath);
  if (useFileLock) {
    const lockResult = await acquireRepoLock(locksBasePath, integrationLockPath, {
      taskId: taskId || 'integration',
      mode: 'integration',
    });
    if (!lockResult.acquired) {
      return { ok: false, status: 'locked', merged: false, pushed: false, pr_opened: false,
        error: `Integration lock held for ${lockKey}: ${lockResult.reason || 'by another task'}` };
    }
  } else {
    if (INTEGRATION_LOCKS.has(lockKey)) {
      return { ok: false, status: 'locked', merged: false, pushed: false, pr_opened: false,
        error: `Integration lock held for ${lockKey} by another task` };
    }
    INTEGRATION_LOCKS.set(lockKey, Date.now());
  }

  try {
    const gitPath = worktreePath || canonicalRepoPath;

    // Run pre-integration checks
    if (Array.isArray(checkCommands) && checkCommands.length > 0) {
      for (const cmd of checkCommands) {
        try {
          execFileSync('/bin/sh', ['-c', cmd], { cwd: gitPath, stdio: 'pipe', timeout: 30000 });
        } catch (err) {
          return {
            ok: false, status: 'check_failed', merged: false, pushed: false, pr_opened: false,
            error: `Integration check failed: ${cmd}: ${err.stderr?.toString().trim() || err.message}`,
          };
        }
      }
    }

    if (mode === 'none') {
      return { ok: true, status: 'completed', merged: false, pushed: false, pr_opened: false };
    }

    // Rebase or merge onto target branch
    try {
      execFileSync('git', ['checkout', targetBranch], { cwd: gitPath, stdio: 'pipe', timeout: 30000 });
      execFileSync('git', ['pull', '--rebase', 'origin', targetBranch], { cwd: gitPath, stdio: 'pipe', timeout: 60000 });
      execFileSync('git', ['checkout', taskBranch], { cwd: gitPath, stdio: 'pipe', timeout: 30000 });
    } catch {
      // Non-fatal if remote not available
    }

    // Rebase onto target
    try {
      execFileSync('git', ['rebase', targetBranch], { cwd: gitPath, stdio: 'pipe', timeout: 60000 });
    } catch (err) {
      const stderr = err.stderr?.toString() || '';
      const conflictFiles = parseConflictFiles(stderr);
      return {
        ok: false, status: 'conflict', merged: false, pushed: false, pr_opened: false,
        error: `Rebase conflict on ${targetBranch}`,
        conflict_files: conflictFiles,
      };
    }

    // Push branch
    let pushed = false;
    try {
      execFileSync('git', ['push', 'origin', taskBranch, '--force-with-lease'], { cwd: gitPath, stdio: 'pipe', timeout: 60000 });
      pushed = true;
    } catch {
      // Push failed — might not have remote configured
    }

    // Open PR if mode allows
    let prOpened = false;
    if (mode === 'open_pr' && pushed) {
      try {
        // Try gh CLI for PR creation
        execFileSync('gh', ['pr', 'create', '--fill', '--base', targetBranch, '--head', taskBranch], { cwd: gitPath, stdio: 'pipe', timeout: 30000 });
        prOpened = true;
      } catch {
        // gh CLI not available or PR creation failed
      }
    }

    return { ok: true, status: 'completed', merged: false, pushed, pr_opened: prOpened };
  } catch (err) {
    return { ok: false, status: 'failed', merged: false, pushed: false, pr_opened: false, error: err.message };
  } finally {
    if (useFileLock) {
      try { await releaseRepoLock(locksBasePath, integrationLockPath, taskId || 'integration'); } catch {}
    } else {
      INTEGRATION_LOCKS.delete(lockKey);
    }
  }
}

function parseConflictFiles(stderr) {
  const files = [];
  const lines = stderr.split('\n');
  for (const line of lines) {
    const match = line.match(/CONFLICT.*in\s+(.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
}

/**
 * Check if an integration lock is currently held for a given repo/branch.
 *
 * @param {string} repoId
 * @param {string} targetBranch
 * @returns {boolean}
 */
export async function isIntegrationLocked(repoId, targetBranch, { locksBasePath } = {}) {
  if (locksBasePath) {
    const lockFilePath = join(getLocksDir(locksBasePath), safeRepoId(`integration:${repoId}:${targetBranch}`) + '.json');
    try {
      const lock = JSON.parse(await readFile(lockFilePath, 'utf8'));
      return lock.status === 'held';
    } catch {
      return false;
    }
  }
  return INTEGRATION_LOCKS.has(`integration:${repoId}:${targetBranch}`);
}

/**
 * Release an integration lock (e.g., after stale recovery).
 *
 * @param {string} repoId
 * @param {string} targetBranch
 */
export async function releaseIntegrationLock(repoId, targetBranch, { locksBasePath } = {}) {
  if (locksBasePath) {
    const integrationLockPath = `integration:${safeRepoId(repoId)}:${targetBranch}`;
    try {
      await forceReleaseRepoLock(locksBasePath, integrationLockPath);
    } catch {
      // Non-fatal
    }
  }
  INTEGRATION_LOCKS.delete(`integration:${repoId}:${targetBranch}`);
}
