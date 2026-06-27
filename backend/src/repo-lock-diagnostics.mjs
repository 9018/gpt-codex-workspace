import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLocksDir } from "./repo-lock-paths.mjs";

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
  let released = 0;
  let releasedWithStaleReason = 0;
  const locks = [];
  const historyLocks = [];

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

      if (lockData.stale_reason) {
        safeEntry.stale_reason = lockData.stale_reason;
      }

      if (lockData.status === "released") {
        released++;
        if (lockData.stale_reason) releasedWithStaleReason++;
        safeEntry.blocks_current_work = false;
        safeEntry.diagnostic_level = "history";
        safeEntry.stale_reason_scope = lockData.stale_reason ? "historical_released_lock" : null;
        historyLocks.push(safeEntry);
        continue;
      }

      if (lockData.status === "stale") {
        safeEntry.blocks_current_work = true;
        safeEntry.diagnostic_level = "blocker";
        stale++;
      } else {
        safeEntry.blocks_current_work = true;
        safeEntry.diagnostic_level = "active";
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
    released_repo_locks: released,
    locks,
    history: {
      released_repo_locks: released,
      released_with_stale_reason: releasedWithStaleReason,
      locks: historyLocks,
    },
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
      const status = lockData.status;
      locks.push({
        safe_repo_id: lockData.safe_repo_id,
        canonical_repo_path: lockData.canonical_repo_path,
        task_id: lockData.task_id,
        run_id: lockData.run_id,
        status,
        mode: lockData.mode,
        acquired_at: lockData.acquired_at,
        last_heartbeat_at: lockData.last_heartbeat_at,
        restart_state: lockData.restart_state || null,
        stale_reason: lockData.stale_reason || null,
        blocks_current_work: status !== "released",
        diagnostic_level: status === "released" ? "history" : status === "stale" ? "blocker" : "active",
        stale_reason_scope: status === "released" && lockData.stale_reason ? "historical_released_lock" : null,
      });
    }
  } catch {
    // Non-fatal
  }

  return locks;
}
