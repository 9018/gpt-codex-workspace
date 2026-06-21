import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadRestartMarker, updateRestartMarkerStatus, writePendingRestartMarker } from "./safe-restart-marker-store.mjs";

// ---------------------------------------------------------------------------
// Misplaced marker detection and migration
// ---------------------------------------------------------------------------

/**
 * Validate that a workspace root is not pointing at a git repository path.
 *
 * Safe-restart markers must be stored under the canonical workspace `.gptwork`
 * directory, NOT under a repo-local `.gptwork` directory.  If the workspaceRoot
 * points inside a git repo (i.e. a `.git` subdirectory exists), it will produce
 * markers that the Phase C reconciliation cannot find.
 *
 * @param {string} workspaceRoot — the path to check
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot) {
    return { valid: false, reason: "workspaceRoot is required" };
  }
  if (existsSync(join(workspaceRoot, ".git"))) {
    return {
      valid: false,
      reason: `workspaceRoot points to a git repository path: ${workspaceRoot}. Use the workspace root (e.g. parent of repo), not the repo itself.`
    };
  }
  return { valid: true };
}

/**
 * The diagnostic key emitted when a safe-restart marker is found inside a
 * repo-local .gptwork/pending-restarts directory instead of the canonical
 * workspace-level .gptwork/pending-restarts.
 */
export const MISPLACED_MARKER_DIAGNOSTIC = "misplaced_safe_restart_marker";

/**
 * Scan for misplaced restart markers located under repo-local `.gptwork`
 * directories instead of the canonical workspace path.
 *
 * A "misplaced" marker was written to `repoPath/.gptwork/pending-restarts/`
 * rather than `workspaceRoot/.gptwork/pending-restarts/`.  This can happen
 * when Codex writes the marker file directly via `exec_command` instead of
 * calling the `schedule_service_restart` MCP tool, or when a caller passes
 * the repo path as `workspaceRoot`.
 *
 * @param {string[]} repoPaths — array of canonical repo paths to inspect
 * @returns {Array<{ repoPath: string, taskId: string, marker: object, markerPath: string }>}
 */
export function scanMisplacedMarkersSync(repoPaths) {
  if (!Array.isArray(repoPaths) || repoPaths.length === 0) return [];

  const results = [];
  for (const repoPath of repoPaths) {
    if (!repoPath) continue;
    const markerDir = join(repoPath, ".gptwork", "pending-restarts");
    let entries;
    try {
      entries = readdirSync(markerDir, { withFileTypes: true });
    } catch {
      continue; // no misplaced marker directory for this repo
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const markerPath = join(markerDir, entry.name);
        const data = readFileSync(markerPath, "utf8");
        const marker = JSON.parse(data);
        results.push({ repoPath, taskId, marker, markerPath });
      } catch {
        // skip unreadable files
      }
    }
  }
  return results;
}

/**
 * Migrate a misplaced restart marker from a repo-local path to the canonical
 * workspace-level path.
 *
 * Reads the source marker from `repoPath/.gptwork/pending-restarts/<taskId>.json`,
 * writes an equivalent marker to `workspaceRoot/.gptwork/pending-restarts/`,
 * preserves the source marker's status (pending/scheduled/restarted), then
 * removes the misplaced source file.
 *
 * @param {string} workspaceRoot — canonical workspace root
 * @param {string} repoPath — repo path where the misplaced marker was found
 * @param {string} taskId — task ID
 * @returns {Promise<{ migrated: boolean, marker?: object, diagnostic?: string }>}
 */
export async function migrateMisplacedMarker(workspaceRoot, repoPath, taskId) {
  if (!workspaceRoot) {
    return { migrated: false, diagnostic: "workspaceRoot is required" };
  }
  if (!repoPath) {
    return { migrated: false, diagnostic: "repoPath is required" };
  }
  if (!taskId) {
    return { migrated: false, diagnostic: "taskId is required" };
  }

  const sourcePath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  let sourceMarker;
  try {
    sourceMarker = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch {
    return {
      migrated: false,
      diagnostic: "misplaced_safe_restart_marker: source marker not found or unreadable at " + sourcePath
    };
  }

  // Check if canonical marker already exists — skip if so
  const existing = await loadRestartMarker(workspaceRoot, taskId);
  if (existing) {
    // Canonical already exists; just remove the misplaced marker
    try { await rm(sourcePath, { force: true }); } catch {}
    return {
      migrated: false,
      diagnostic: "misplaced_safe_restart_marker: canonical marker already exists; removed duplicate",
      marker: existing
    };
  }

  // Write marker to canonical path
  const marker = await writePendingRestartMarker(workspaceRoot, taskId, {
    requested_by: sourceMarker.requested_by || "codex",
    service_name: sourceMarker.service_name || "gptwork-mcp.service",
    expected_commit: sourceMarker.expected_commit || null,
    expected_remote_head: sourceMarker.expected_remote_head || null,
    repo_path: sourceMarker.repo_path || repoPath,
  });

  // Preserve the source marker's status (already written as "pending" above)
  if (sourceMarker.status && sourceMarker.status !== "pending") {
    try {
      await updateRestartMarkerStatus(workspaceRoot, taskId, sourceMarker.status, {
        restart_method: sourceMarker.restart_method || null,
        scheduled_at: sourceMarker.scheduled_at || null,
      });
    } catch {
      // non-fatal — marker exists at least as "pending"
    }
  }

  // Remove the misplaced source file
  try {
    await rm(sourcePath, { force: true });
  } catch {
    // non-fatal
  }

  return { migrated: true, marker };
}

/**
 * Get a human-readable diagnostic for a misplaced restart marker.
 *
 * @param {object} result — the result from scanMisplacedMarkersSync item
 * @returns {string} diagnostic string
 */
export function getMisplacedMarkerDiagnostic({ repoPath, taskId, marker } = {}) {
  if (!repoPath || !taskId) {
    return "misplaced_safe_restart_marker: insufficient data";
  }
  const status = marker?.status || "unknown";
  const commit = marker?.expected_commit || "(none)";
  return [
    "misplaced_safe_restart_marker",
    `task=${taskId}`,
    `status=${status}`,
    `expected_commit=${commit}`,
    `repo_path=${repoPath}`,
    `expected_path=${join(repoPath, ".gptwork", "pending-restarts", taskId + ".json")}`,
  ].join(" ");
}

/**
 * Remove a misplaced restart marker file without migrating it.
 * Used when the canonical marker already exists or the task cannot be recovered.
 *
 * @param {string} repoPath — repo path where the misplaced marker was found
 * @param {string} taskId — task ID
 * @returns {Promise<boolean>} true if removed (or not found)
 */
export async function removeMisplacedMarker(repoPath, taskId) {
  if (!repoPath || !taskId) return false;
  const markerPath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  try {
    await rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
