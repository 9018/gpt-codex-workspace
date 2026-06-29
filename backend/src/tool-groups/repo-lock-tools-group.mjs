import { forceReleaseRepoLock } from "../repo-lock.mjs";
import { listRepoLocks } from "../repo-lock-diagnostics.mjs";
import { STALL_THRESHOLD_MS } from "../repo-lock-paths.mjs";
import {
  TASK_STATUSES,
  isHumanReviewStatus,
  normalizeTaskStatus,
} from "../task-status-taxonomy.mjs";

function isClearableTaskStatus(status) {
  const normalizedStatus = normalizeTaskStatus(status);
  return normalizedStatus === TASK_STATUSES.COMPLETED ||
    normalizedStatus === TASK_STATUSES.FAILED ||
    normalizedStatus === TASK_STATUSES.CANCELLED ||
    normalizedStatus === TASK_STATUSES.TIMED_OUT ||
    isHumanReviewStatus(normalizedStatus);
}

export function createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary, store }) {
  async function repoLockStatusHandler() {
    const lockList = await listRepoLocks(config.defaultWorkspaceRoot);
    const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
    return {
      active_repo_locks: lockSummary.active_repo_locks,
      stale_repo_locks: lockSummary.stale_repo_locks,
      locks: lockList,
    };
  }

  async function collectLockDiagnostics(workspaceRoot) {
    const lockList = await listRepoLocks(workspaceRoot);
    const lockSummary = await getRepoLockSummary(workspaceRoot);
    return {
      active_repo_locks: lockSummary.active_repo_locks,
      stale_repo_locks: lockSummary.stale_repo_locks,
      locks: lockList,
    };
  }

  return {
    list_repo_locks: tool(
      'List repo execution locks with safe diagnostics. Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)',
      schema({}),
      repoLockStatusHandler,
    ),
    repo_lock_status: tool(
      'List repo execution locks with safe diagnostics (alias for list_repo_locks). Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)',
      schema({}),
      repoLockStatusHandler,
    ),
    // -----------------------------------------------------------------------
    // clear_repo_lock — safe mutation with strict guards
    // -----------------------------------------------------------------------
    clear_repo_lock: tool({
      name: "clear_repo_lock",
      description: "Safely clear a stale or terminal-task repo lock. " +
        "Will NOT clear an actively heartbeating running task lock. " +
        "Requires either task_id or repo_id to identify the lock. " +
        "Returns before/after lock status. (安全释放仓库执行锁)",
      inputSchema: schema({
        task_id: { type: "string", description: "Task ID whose lock to clear. Mutually supported with repo_id." },
        repo_id: { type: "string", description: "Safe repo ID whose lock to clear. Mutually supported with task_id." },
        reason: { type: "string", description: "Optional reason for clearing the lock (logged for audit)." },
      }),
      modes: ["operator", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["system", "repo-lock", "admin"],
      handler: async ({ task_id, repo_id, reason }) => {
        const workspaceRoot = config.defaultWorkspaceRoot;
        if (!workspaceRoot) {
          return { ok: false, error: "workspaceRoot not configured" };
        }

        if (!task_id && !repo_id) {
          return { ok: false, error: "Either task_id or repo_id is required to identify the lock." };
        }

        // Fetch all locks
        const allLocks = await listRepoLocks(workspaceRoot);
        const matchingLocks = allLocks.filter((l) => {
          if (task_id && l.task_id === task_id) return true;
          if (repo_id && l.safe_repo_id === repo_id) return true;
          return false;
        });

        if (matchingLocks.length === 0) {
          return {
            ok: false,
            error: `No lock found${task_id ? ` for task ${task_id}` : ""}${repo_id ? ` with repo_id ${repo_id}` : ""}.`,
          };
        }

        const results = [];
        for (const lock of matchingLocks) {
          const guardResult = await _checkClearGuard(lock, store, workspaceRoot);
          if (!guardResult.ok) {
            results.push({
              safe_repo_id: lock.safe_repo_id,
              task_id: lock.task_id,
              status: lock.status,
              skipped: true,
              reason: guardResult.reason,
            });
            continue;
          }

          // Before snapshot
          const before = { ...lock };

          // Force release
          let releaseResult;
          try {
            // forceReleaseRepoLock works on repo path, not repo_id
            // We need the canonical_repo_path from the lock
            if (lock.canonical_repo_path) {
              releaseResult = await forceReleaseRepoLock(workspaceRoot, lock.canonical_repo_path);
            } else {
              // Fallback: try to find by scanning all lock files
              releaseResult = { released: false, reason: "no canonical_repo_path in lock" };
            }
          } catch (releaseErr) {
            results.push({
              safe_repo_id: lock.safe_repo_id,
              task_id: lock.task_id,
              status: lock.status,
              skipped: true,
              reason: `Error releasing lock: ${releaseErr.message}`,
            });
            continue;
          }

          // After snapshot (re-read the lock)
          let after = null;
          try {
            const refreshed = await listRepoLocks(workspaceRoot);
            after = refreshed.find((l) =>
              (task_id && l.task_id === task_id) ||
              (repo_id && l.safe_repo_id === repo_id)
            ) || null;
          } catch {
            after = null;
          }

          results.push({
            safe_repo_id: lock.safe_repo_id,
            task_id: lock.task_id,
            status_before: before.status,
            status_after: after ? after.status : "released",
            heartbeat_age_s: before.last_heartbeat_at
              ? Math.round((Date.now() - new Date(before.last_heartbeat_at).getTime()) / 1000)
              : null,
            cleared: true,
            reason: reason || null,
          });
        }

        return {
          ok: results.some((r) => r.cleared),
          locks_checked: matchingLocks.length,
          locks_cleared: results.filter((r) => r.cleared).length,
          locks_skipped: results.filter((r) => r.skipped).length,
          details: results,
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Guard: can this lock be safely cleared?
// ---------------------------------------------------------------------------
async function _checkClearGuard(lock, store, workspaceRoot) {
  if (!lock || !lock.task_id) {
    return { ok: true, reason: "no task_id in lock, clearing by force" };
  }

  // Check if the task is terminal
  if (lock.status === "released") {
    return { ok: false, reason: "lock is already released" };
  }

  if (lock.status === "stale") {
    return { ok: true, reason: "lock is already marked stale" };
  }

  try {
    const state = await store.load();
    const task = (state.tasks || []).find((t) => t.id === lock.task_id);
    if (task) {
      if (isClearableTaskStatus(task.status)) {
        return { ok: true, reason: `task ${lock.task_id} is in terminal status "${task.status}"` };
      }
      // Task is not terminal — check heartbeat staleness
      const heartbeatAge = lock.last_heartbeat_at
        ? Date.now() - new Date(lock.last_heartbeat_at).getTime()
        : Infinity;
      if (heartbeatAge > STALL_THRESHOLD_MS) {
        return { ok: true, reason: `task ${lock.task_id} heartbeat is stale (age=${Math.round(heartbeatAge / 1000)}s, threshold=${STALL_THRESHOLD_MS / 1000}s)` };
      }
      // Active running task — refuse
      return {
        ok: false,
        reason: `task ${lock.task_id} is still "${task.status}" with active heartbeat (age=${Math.round(heartbeatAge / 1000)}s < threshold=${STALL_THRESHOLD_MS / 1000}s). Cannot clear an active lock.`,
      };
    }
  } catch {
    // If we can't read the store, fall through to heartbeat check
  }

  // Task not found in store — check heartbeat as last resort
  const heartbeatAge = lock.last_heartbeat_at
    ? Date.now() - new Date(lock.last_heartbeat_at).getTime()
    : Infinity;
  if (heartbeatAge > STALL_THRESHOLD_MS) {
    return { ok: true, reason: `task ${lock.task_id} not found in state, heartbeat is stale (age=${Math.round(heartbeatAge / 1000)}s)` };
  }

  return {
    ok: false,
    reason: `task ${lock.task_id} not found in state and heartbeat is active (age=${Math.round(heartbeatAge / 1000)}s). Cannot clear unknown active lock.`,
  };
}
