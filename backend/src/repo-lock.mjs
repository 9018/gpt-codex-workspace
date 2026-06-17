/**
 * repo-lock.mjs — Per-repository execution lock for GPTWork Codex tasks.
 *
 * Prevents concurrent builder/deploy/admin Codex tasks from running against
 * the same canonical repository. Locks are durable under the workspace's
 * .gptwork directory and survive service restarts.
 *
 * Lock file: .gptwork/locks/repos/<safe-repo-id>.json
 *
 * Lock lifecycle:
 *   acquire -> held -> release (or stale after reconciliation)
 *   held + restart_state="scheduled" during safe-restart window
 *
 * Diagnostics expose only active/stale counts and task ids — no secrets.
 */

import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCKS_DIR = ".gptwork/locks/repos";
const STALL_THRESHOLD_MS = 900_000; // 15 minutes — generous for long Codex runs
const VALID_STATUSES = ["held", "stale", "released"];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Create a filesystem-safe identifier from a repo path.
 * Replaces non-alphanumeric characters with underscore and SHA-256 prefix.
 *
 * @param {string} repoPath — canonical repo path
 * @returns {string} safe id
 */
export function safeRepoId(repoPath) {
  if (!repoPath) return "__unknown__";
  // Use SHA-256 prefix for uniqueness, plus a cleaned path suffix for readability
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  const clean = String(repoPath)
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9_/-]/g, "_")
    .replace(/[/]/g, "--");
  return `${hash}-${clean}`;
}

/**
 * Get the locks directory for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getLocksDir(workspaceRoot) {
  return join(workspaceRoot, LOCKS_DIR);
}

/**
 * Get lock file path for a repo.
 *
 * @param {string} workspaceRoot
 * @param {string} repoPath — canonical repo path
 * @returns {string}
 */
export function getLockFilePath(workspaceRoot, repoPath) {
  return join(getLocksDir(workspaceRoot), safeRepoId(repoPath) + ".json");
}

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

  // Read existing lock if any
  let existingLock = null;
  try {
    existingLock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    // No existing lock, safe to acquire
  }

  const now = new Date().toISOString();

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

  // Acquire new lock
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

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile all repo locks in the workspace.
 *
 * For each lock:
 * 1. If status is "released", skip.
 * 2. If status is "held":
 *    a. Check if lock owner task is still running (status === "running")
 *       AND task process shows activity (non-stale heartbeat or process exists).
 *    b. Check if child process is still alive.
 *    c. If restart_state is set, check if restart marker is still active.
 *    d. Otherwise, mark as stale.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{reconciled: number, stale: number, active: number, details: object[]}>}
 */
export async function reconcileRepoLocks(workspaceRoot) {
  if (!workspaceRoot) return { reconciled: 0, stale: 0, active: 0, details: [] };

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) {
    return { reconciled: 0, stale: 0, active: 0, details: [] };
  }

  const now = Date.now();
  const reconciled = [];
  let staleCount = 0;
  let activeCount = 0;

  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const lockPath = join(lockDir, entry.name);
      let lockData;
      try {
        lockData = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        continue; // skip unreadable files
      }

      if (lockData.status === "released") continue;

      if (lockData.status === "stale") {
        staleCount++;
        continue;
      }

      // status === "held" — check if still valid
      const ageMs = now - new Date(lockData.last_heartbeat_at || lockData.acquired_at).getTime();
      let isStale = false;
      let reason = "";

      // Check 1: Heartbeat stall threshold
      if (ageMs > STALL_THRESHOLD_MS) {
        isStale = true;
        reason = `heartbeat stale (age=${Math.round(ageMs / 1000)}s, threshold=${STALL_THRESHOLD_MS / 1000}s)`;
      }

      // Check 2: Child process alive?
      if (!isStale && lockData.child_pid && typeof lockData.child_pid === "number" && lockData.child_pid > 0) {
        try {
          process.kill(lockData.child_pid, 0);
          // Process is alive — lock is active
          activeCount++;
          continue;
        } catch {
          // Process dead — may be stale, but let heartbeat decide
        }
      }

      // Check 3: PID (current process) alive?
      if (!isStale && lockData.pid && typeof lockData.pid === "number" && lockData.pid > 0) {
        try {
          process.kill(lockData.pid, 0);
          // Process is alive — but check if this process is actually running that task
          // Since pid could be reused, use heartbeat age as secondary signal
          if (ageMs < STALL_THRESHOLD_MS) {
            activeCount++;
            continue;
          }
        } catch {
          // Process dead — mark stale
          isStale = true;
          if (!reason) reason = `owner process (pid=${lockData.pid}) not found`;
        }
      }

      // Check 4: Restart marker keeps lock alive
      if (lockData.restart_state) {
        // Check if restart marker still exists
        const markerDir = join(workspaceRoot, ".gptwork", "pending-restarts");
        const markerPath = join(markerDir, `${lockData.task_id}.json`);
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8"));
          if (["pending", "scheduled", "restarted"].includes(marker.status)) {
            // Restart still in progress — keep lock
            activeCount++;
            continue;
          }
          // Restart completed or failed — lock should be released
          isStale = true;
          reason = `restart marker status=${marker.status}`;
        } catch {
          // No restart marker — restart_state is stale
          isStale = true;
          reason = "restart marker not found";
        }
      }

      if (isStale) {
        lockData.status = "stale";
        lockData.stale_reason = reason;
        lockData.stale_at = new Date().toISOString();
        lockData.last_heartbeat_at = new Date().toISOString();
        await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
        staleCount++;
        reconciled.push({
          safe_repo_id: lockData.safe_repo_id,
          task_id: lockData.task_id,
          reason
        });
      } else {
        activeCount++;
      }
    }
  } catch {
    // Non-fatal
  }

  return {
    reconciled: reconciled.length,
    stale: staleCount,
    active: activeCount,
    details: reconciled
  };
}

/**
 * Mark a lock as released for a specific task (called during Phase C verification).
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<{released: boolean}>}
 */
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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Get a safe summary of all repo locks for diagnostics.
 * No secret values exposed.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{active_repo_locks: number, stale_repo_locks: number, locks: object[]}>}
 */
export async function getRepoLockSummary(workspaceRoot) {
  if (!workspaceRoot) {
    return { active_repo_locks: 0, stale_repo_locks: 0, locks: [] };
  }

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) {
    return { active_repo_locks: 0, stale_repo_locks: 0, locks: [] };
  }

  let active = 0;
  let stale = 0;
  const locks = [];

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

      if (lockData.status === "released") continue;

      // Safe fields only — no secrets
      const safeEntry = {
        safe_repo_id: lockData.safe_repo_id,
        task_id: lockData.task_id,
        status: lockData.status,
        acquired_at: lockData.acquired_at,
        last_heartbeat_at: lockData.last_heartbeat_at,
        mode: lockData.mode,
      };

      // Only include restart_state if set (safe string, not a secret)
      if (lockData.restart_state) {
        safeEntry.restart_state = lockData.restart_state;
      }

      if (lockData.status === "stale") {
        safeEntry.stale_reason = lockData.stale_reason;
        stale++;
      } else {
        active++;
      }

      locks.push(safeEntry);
    }
  } catch {
    // Non-fatal
  }

  // Sort: active locks first, then by acquired_at descending
  locks.sort((a, b) => {
    if (a.status === "held" && b.status !== "held") return -1;
    if (a.status !== "held" && b.status === "held") return 1;
    return new Date(b.acquired_at).getTime() - new Date(a.acquired_at).getTime();
  });

  return {
    active_repo_locks: active,
    stale_repo_locks: stale,
    locks
  };
}

/**
 * List all repo locks (full details for list_repo_locks tool).
 *
 * @param {string} workspaceRoot
 * @returns {Promise<object[]>}
 */
export async function listRepoLocks(workspaceRoot) {
  if (!workspaceRoot) return [];

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) return [];

  const locks = [];

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

      // Safe fields only
      locks.push({
        safe_repo_id: lockData.safe_repo_id,
        canonical_repo_path: lockData.canonical_repo_path,
        task_id: lockData.task_id,
        run_id: lockData.run_id,
        status: lockData.status,
        mode: lockData.mode,
        acquired_at: lockData.acquired_at,
        last_heartbeat_at: lockData.last_heartbeat_at,
        restart_state: lockData.restart_state || null,
        stale_reason: lockData.stale_reason || null,
      });
    }
  } catch {
    // Non-fatal
  }

  return locks;
}
