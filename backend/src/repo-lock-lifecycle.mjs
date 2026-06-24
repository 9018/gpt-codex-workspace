import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLockFilePath, getLocksDir, safeRepoId } from "./repo-lock-paths.mjs";

// ---------------------------------------------------------------------------
// Lock CRUD
// ---------------------------------------------------------------------------

/**
 * Try to acquire a repo execution lock.
 *
 * Returns { acquired: true, lock } on success.
 * Returns { acquired: false, heldByTask, heldByRunId, reason } if lock is held.
 *
 * @param {string} workspaceRoot
 * @param {string} repoPath — canonical repo path
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} [opts.runId]
 * @param {number} [opts.pid] — current process pid
 * @param {number} [opts.childPid] — Codex child pid (if already spawned)
 * @param {string} [opts.mode] — "builder" | "deploy" | "admin"
 * @returns {Promise<{acquired: boolean, lock?: object, heldByTask?: string, heldByRunId?: string, reason?: string}>}
 */
export async function acquireRepoLock(workspaceRoot, repoPath, opts = {}) {
  const { taskId, runId, pid, childPid, mode } = opts;
  if (!workspaceRoot) throw new Error("workspaceRoot is required for acquireRepoLock");
  if (!repoPath) throw new Error("repoPath is required for acquireRepoLock");
  if (!taskId) throw new Error("taskId is required for acquireRepoLock");

  const lockDir = getLocksDir(workspaceRoot);
  await mkdir(lockDir, { recursive: true });
  const lockPath = getLockFilePath(workspaceRoot, repoPath);

  const now = new Date().toISOString();

  const lockData = {
    canonical_repo_path: repoPath,
    safe_repo_id: safeRepoId(repoPath),
    task_id: taskId,
    run_id: runId || null,
    pid: pid || process.pid || null,
    child_pid: childPid || null,
    acquired_at: now,
    last_heartbeat_at: now,
    mode: mode || "builder",
    restart_state: null,
    status: "held"
  };

  try {
    await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return { acquired: true, lock: lockData };
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  // Existing lock path won the atomic create race. Inspect it without ever
  // treating read-before-write as the acquisition protocol.
  let existingLock = null;
  try {
    existingLock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return {
      acquired: false,
      heldByTask: null,
      heldByRunId: null,
      reason: "Repo lock exists but could not be read"
    };
  }

  if (existingLock) {
    // Check if lock is still valid
    if (existingLock.status === "released") {
      // Previous lock was released, can overwrite
    } else if (existingLock.status === "held") {
      // Lock is active — check if it's the same task (re-entrant)
      if (existingLock.task_id === taskId) {
        // Same task re-acquiring — update heartbeat and return acquired
        existingLock.last_heartbeat_at = now;
        existingLock.pid = pid ?? existingLock.pid;
        existingLock.child_pid = childPid ?? existingLock.child_pid;
        existingLock.run_id = runId ?? existingLock.run_id;
        await writeFile(lockPath, JSON.stringify(existingLock, null, 2) + "\n", "utf8");
        return { acquired: true, lock: existingLock };
      }
      // Lock held by another task
      return {
        acquired: false,
        heldByTask: existingLock.task_id,
        heldByRunId: existingLock.run_id,
        reason: `Repo lock held by task ${existingLock.task_id}`
      };
    } else if (existingLock.status === "stale") {
      // Stale lock can be overwritten (handled below)
    }
  }

  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
  return { acquired: true, lock: lockData };
}

/**
 * Release a repo execution lock.
 *
 * Sets status to "released" so the lock file remains for audit.
 * An alternative is to delete the file — "released" status is preferred
 * for diagnostics and debugging.
 *
 * @param {string} workspaceRoot
 * @param {string} repoPath — canonical repo path
 * @param {string} taskId — verifies the task releasing the lock matches
 * @param {object} [opts]
 * @param {string} [opts.restartState] — if set, keep lock with restart_state instead of releasing
 * @returns {Promise<{released: boolean, reason?: string}>}
 */
export async function releaseRepoLock(workspaceRoot, repoPath, taskId, opts = {}) {
  if (!workspaceRoot || !repoPath || !taskId) {
    return { released: false, reason: "missing required arguments" };
  }

  const lockPath = getLockFilePath(workspaceRoot, repoPath);
  let lockData;
  try {
    lockData = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    // No lock file exists — already released or never acquired
    return { released: true, reason: "no lock file found, already released" };
  }

  // If restart_state is set, keep the lock in held+restart_state mode
  if (opts.restartState) {
    lockData.restart_state = opts.restartState;
    lockData.last_heartbeat_at = new Date().toISOString();
    lockData.status = "held";
    await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
    return { released: false, reason: `lock kept with restart_state=${opts.restartState}` };
  }

  // Don't release if the lock is held by a different task (safety check)
  if (lockData.task_id !== taskId) {
    return { released: false, reason: `lock held by different task ${lockData.task_id}` };
  }

  const now = new Date().toISOString();
  lockData.status = "released";
  lockData.released_at = now;
  lockData.last_heartbeat_at = now;
  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");

  return { released: true };
}

/**
 * Force-release a stale lock (for manual reconciliation or admin use).
 * Only marks it as released — does not delete the file.
 *
 * @param {string} workspaceRoot
 * @param {string} repoPath
 * @returns {Promise<{released: boolean}>}
 */
export async function forceReleaseRepoLock(workspaceRoot, repoPath) {
  if (!workspaceRoot || !repoPath) {
    return { released: false };
  }

  const lockPath = getLockFilePath(workspaceRoot, repoPath);
  let lockData;
  try {
    lockData = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return { released: true };
  }

  lockData.status = "released";
  lockData.released_at = new Date().toISOString();
  lockData.last_heartbeat_at = new Date().toISOString();
  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
  return { released: true };
}

export async function releaseLockForTask(workspaceRoot, taskId) {
  if (!workspaceRoot || !taskId) return { released: false };

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) return { released: false };

  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const lockPath = join(lockDir, entry.name);
      let lockData;
      try {
        lockData = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        continue;
      }

      if (lockData.task_id === taskId && lockData.status !== "released") {
        lockData.status = "released";
        lockData.released_at = new Date().toISOString();
        lockData.last_heartbeat_at = new Date().toISOString();
        lockData.restart_state = null;
        await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
        return { released: true };
      }
    }
  } catch {
    // Non-fatal
  }

  return { released: false };
}
