import { existsSync } from "node:fs";
import { getPendingRestartsDir, scanPendingRestartMarkers } from "./safe-restart.mjs";
import { CACHE_DEFAULTS, _diagnosticsCache } from "./diagnostics-cache.mjs";

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
 * Shared context status query used by context_status/project_context_status
 * and context_prepare handlers. Accepts { config, registry, store } as
 * explicit dependencies.
 */
