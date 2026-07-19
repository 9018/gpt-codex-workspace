import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLocksDir, STALL_THRESHOLD_MS } from "./repo-lock-paths.mjs";

export async function reconcileRepoLocks(workspaceRoot) {
  if (!workspaceRoot) return { reconciled: 0, stale: 0, active: 0, details: [] };

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) return { reconciled: 0, stale: 0, active: 0, details: [] };

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
        continue;
      }

      if (lockData.status === "released") continue;
      if (lockData.status === "stale") {
        staleCount++;
        continue;
      }

      const ageMs = now - new Date(lockData.last_heartbeat_at || lockData.acquired_at).getTime();
      let isStale = false;
      let reason = "";

      if (ageMs > STALL_THRESHOLD_MS) {
        isStale = true;
        reason = `heartbeat stale (age=${Math.round(ageMs / 1000)}s, threshold=${STALL_THRESHOLD_MS / 1000}s)`;
      }

      if (!isStale && lockData.child_pid && typeof lockData.child_pid === "number" && lockData.child_pid > 0) {
        try {
          process.kill(lockData.child_pid, 0);
          activeCount++;
          continue;
        } catch {
          isStale = true;
          reason = `child process (pid=${lockData.child_pid}) not found`;
        }
      }

      if (!isStale && lockData.pid && typeof lockData.pid === "number" && lockData.pid > 0) {
        try {
          process.kill(lockData.pid, 0);
          if (ageMs < STALL_THRESHOLD_MS) {
            activeCount++;
            continue;
          }
        } catch {
          isStale = true;
          if (!reason) reason = `owner process (pid=${lockData.pid}) not found`;
        }
      }

      if (lockData.restart_state) {
        const markerPath = join(workspaceRoot, ".gptwork", "pending-restarts", `${lockData.task_id}.json`);
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8"));
          if (["pending", "scheduled", "restarted"].includes(marker.status)) {
            activeCount++;
            continue;
          }
          isStale = true;
          reason = `restart marker status=${marker.status}`;
        } catch {
          isStale = true;
          reason = "restart marker not found";
        }
      }

      if (isStale) {
        const terminalAt = new Date().toISOString();
        lockData.status = "stale";
        lockData.stale_reason = reason;
        lockData.stale_at = terminalAt;
        lockData.released_at = terminalAt;
        lockData.last_heartbeat_at = terminalAt;
        lockData.restart_state = null;
        await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
        staleCount++;
        reconciled.push({ safe_repo_id: lockData.safe_repo_id, task_id: lockData.task_id, reason, released: true });
      } else {
        activeCount++;
      }
    }
  } catch {
    // Non-fatal reconciliation.
  }

  return { reconciled: reconciled.length, stale: staleCount, active: activeCount, details: reconciled };
}
