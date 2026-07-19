import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLocksDir } from "./repo-lock-paths.mjs";

export const RELEASED_LOCK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export async function cleanupExpiredRepoLocks(
  workspaceRoot,
  { now = Date.now(), retentionMs = RELEASED_LOCK_RETENTION_MS } = {},
) {
  if (!workspaceRoot) return { deleted: 0 };
  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) return { deleted: 0 };

  let deleted = 0;
  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lockPath = join(lockDir, entry.name);
      let expired = false;

      if (entry.name.endsWith(".json")) {
        try {
          const lockData = JSON.parse(await readFile(lockPath, "utf8"));
          if (!["released", "stale"].includes(lockData.status)) continue;
          const terminalAt = lockData.released_at || lockData.stale_at || lockData.last_heartbeat_at;
          const terminalTime = new Date(terminalAt).getTime();
          expired = Number.isFinite(terminalTime) && now - terminalTime >= retentionMs;
        } catch {
          continue;
        }
      } else if (entry.name.includes(".released.") || entry.name.includes(".stale.")) {
        try {
          expired = now - (await stat(lockPath)).mtimeMs >= retentionMs;
        } catch {
          continue;
        }
      }

      if (expired) {
        try {
          await unlink(lockPath);
          deleted++;
        } catch {
          // Non-fatal: another process may already have removed it.
        }
      }
    }
  } catch {
    // Non-fatal diagnostics cleanup.
  }

  return { deleted };
}

function toSafeLock(lockData) {
  const status = lockData.status;
  return {
    safe_repo_id: lockData.safe_repo_id,
    canonical_repo_path: lockData.canonical_repo_path,
    task_id: lockData.task_id,
    run_id: lockData.run_id,
    status,
    mode: lockData.mode,
    acquired_at: lockData.acquired_at,
    last_heartbeat_at: lockData.last_heartbeat_at,
    released_at: lockData.released_at || null,
    stale_at: lockData.stale_at || null,
    restart_state: lockData.restart_state || null,
    stale_reason: lockData.stale_reason || null,
    blocks_current_work: !["released", "stale"].includes(status),
    diagnostic_level: status === "released" ? "history" : status === "stale" ? "stale" : "active",
    stale_reason_scope: status === "released" && lockData.stale_reason ? "historical_released_lock" : null,
  };
}

export async function getRepoLockSummary(workspaceRoot) {
  await cleanupExpiredRepoLocks(workspaceRoot);
  if (!workspaceRoot) {
    return { active_repo_locks: 0, stale_repo_locks: 0, released_repo_locks: 0, history_lock_count: 0, locks: [] };
  }

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) {
    return { active_repo_locks: 0, stale_repo_locks: 0, released_repo_locks: 0, history_lock_count: 0, locks: [] };
  }

  let active = 0;
  let stale = 0;
  let released = 0;
  const locks = [];

  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let lockData;
      try {
        lockData = JSON.parse(await readFile(join(lockDir, entry.name), "utf8"));
      } catch {
        continue;
      }

      if (lockData.status === "released") {
        released++;
        continue;
      }
      if (lockData.status === "stale") stale++;
      else active++;
      locks.push(toSafeLock(lockData));
    }
  } catch {
    // Non-fatal.
  }

  locks.sort((a, b) => {
    if (a.status === "held" && b.status !== "held") return -1;
    if (a.status !== "held" && b.status === "held") return 1;
    return new Date(b.acquired_at).getTime() - new Date(a.acquired_at).getTime();
  });

  return {
    active_repo_locks: active,
    stale_repo_locks: stale,
    released_repo_locks: released,
    history_lock_count: released,
    locks,
  };
}

export async function listRepoLocks(
  workspaceRoot,
  { scope = "current", page = 1, pageSize = 50 } = {},
) {
  await cleanupExpiredRepoLocks(workspaceRoot);
  if (!workspaceRoot) return [];

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) return [];

  const locks = [];
  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let lockData;
      try {
        lockData = JSON.parse(await readFile(join(lockDir, entry.name), "utf8"));
      } catch {
        continue;
      }
      const isHistory = lockData.status === "released";
      if (scope === "history" ? !isHistory : isHistory) continue;
      locks.push(toSafeLock(lockData));
    }
  } catch {
    // Non-fatal.
  }

  locks.sort((a, b) => new Date(b.released_at || b.stale_at || b.last_heartbeat_at || b.acquired_at).getTime() - new Date(a.released_at || a.stale_at || a.last_heartbeat_at || a.acquired_at).getTime());
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedPageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const start = (normalizedPage - 1) * normalizedPageSize;
  return locks.slice(start, start + normalizedPageSize);
}
