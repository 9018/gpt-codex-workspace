import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getPendingRestartsDir, scanPendingRestartMarkers, updateRestartMarkerStatus } from "./safe-restart.mjs";
import { CACHE_DEFAULTS, _diagnosticsCache } from "./diagnostics-cache.mjs";

/**
 * Collect restart marker status (counts by status, active count).
 */
export async function collectRestartMarkerStatus(workspaceRoot) {
  const cacheKey = "restartMarkers:" + (workspaceRoot || "none");
  const cached = _diagnosticsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_DEFAULTS.restartMarkers) {
    return cached.value;
  }

  const result = { total_count: 0, active_count: 0, statuses: { pending: 0, scheduled: 0, restarted: 0, verified: 0, failed: 0 }, marker_dir_exists: false };
  try {
    const markerDir = getPendingRestartsDir(workspaceRoot);
    result.marker_dir_exists = existsSync(markerDir);
    const markers = await scanPendingRestartMarkers(workspaceRoot);
    result.total_count = markers.length;
    result.active_count = markers.filter(m => ["pending", "scheduled", "restarted"].includes(m.status)).length;
    for (const m of markers) {
      if (m.status && result.statuses[m.status] !== undefined) {
        result.statuses[m.status]++;
      }
    }
  } catch (e) { /* non-fatal */ }
  _diagnosticsCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * Reconcile pending restart markers against the running commit.
 *
 * For each active marker (pending/scheduled/restarted) where expected_commit
 * matches the current running commit, mark it as verified with
 * pre_verified_pending=true so it is no longer counted as active.
 *
 * This is the non-destructive auto-verification path for the common case
 * where the runtime is already running the expected commit and a full
 * restart cycle is unnecessary.
 *
 * @param {string} workspaceRoot
 * @param {string|null} [repoDir=null] - git repo path for running_commit resolution
 * @returns {Promise<{verified: number, skipped: number, active_after: number}>}
 */
export async function reconcilePendingRestartMarkers(workspaceRoot, repoDir = null) {
  const markers = await scanPendingRestartMarkers(workspaceRoot);
  const activeMarkers = markers.filter(m => ["pending", "scheduled", "restarted"].includes(m.status));

  if (activeMarkers.length === 0) {
    return { verified: 0, skipped: 0, active_after: 0 };
  }

  let runningCommit = null;
  if (repoDir) {
    try {
      runningCommit = execSync("git rev-parse HEAD", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
    } catch {
      // non-fatal: skip commit-based auto-verification
    }
  }

  let verified = 0;
  let skipped = 0;
  for (const marker of activeMarkers) {
    const commitMatches = runningCommit && marker.expected_commit && runningCommit === marker.expected_commit;
    if (commitMatches) {
      await updateRestartMarkerStatus(workspaceRoot, marker.task_id, "verified", {
        verified_at: new Date().toISOString(),
        running_commit: runningCommit,
        pre_verified_pending: true,
      });
      verified++;
    } else {
      skipped++;
    }
  }

  return { verified, skipped, active_after: activeMarkers.length - verified };
}
