import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLocksDir, STALL_THRESHOLD_MS } from "./repo-lock-paths.mjs";

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
