import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PENDING_RESTARTS_DIR = ".gptwork/pending-restarts";
export const SERVICE_NAME = "gptwork-mcp.service";

export const VALID_STATUSES = ["pending", "scheduled", "restarted", "verified", "failed"];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the pending restarts directory for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getPendingRestartsDir(workspaceRoot) {
  return join(workspaceRoot, PENDING_RESTARTS_DIR);
}

/**
 * Get the path to a specific restart marker file.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {string}
 */
export function getRestartMarkerPath(workspaceRoot, taskId) {
  return join(getPendingRestartsDir(workspaceRoot), String(taskId) + ".json");
}

// ---------------------------------------------------------------------------
// Marker CRUD
// ---------------------------------------------------------------------------

/**
 * Write a pending restart marker file.
 * The marker is the durable checkpoint that survives service restart.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {object} fields
 * @param {string} [fields.requested_by="codex"]
 * @param {string} [fields.service_name="gptwork-mcp.service"]
 * @param {string|null} [fields.expected_commit=null] - SHA of the commit we expect after restart
 * @param {string|null} [fields.expected_remote_head=null] - SHA of the remote HEAD we expect
 * @param {string|null} [fields.repo_path=null]
 * @param {string} [fields.restart_kind="systemd"]
 * @returns {Promise<object>} the written marker
 */
export async function writePendingRestartMarker(workspaceRoot, taskId, fields = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  if (!taskId) throw new Error("taskId is required");

  const dir = getPendingRestartsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const marker = {
    task_id: taskId,
    requested_at: now,
    requested_by: fields.requested_by || "codex",
    service_name: fields.service_name || SERVICE_NAME,
    expected_commit: fields.expected_commit || null,
    expected_remote_head: fields.expected_remote_head || null,
    repo_path: fields.repo_path || null,
    restart_kind: fields.restart_kind || "systemd",
    status: "pending",
    logs: [
      { time: now, message: `Restart marker created by ${fields.requested_by || "codex"} with status=pending` }
    ],
    attempts: 0
  };
  if (fields.result_json_commit_rejected) {
    marker.result_json_commit_rejected = fields.result_json_commit_rejected;
  }

  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");

  return marker;
}

/**
 * Load a restart marker for a specific task.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function loadRestartMarker(workspaceRoot, taskId) {
  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Update a restart marker's status and append a log entry.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {string} newStatus — one of pending|scheduled|restarted|verified|failed
 * @param {object} [extraFields={}] - additional fields to merge into the marker
 * @returns {Promise<object>} updated marker
 */
export async function updateRestartMarkerStatus(workspaceRoot, taskId, newStatus, extraFields = {}) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid restart marker status: ${newStatus}. Valid values: ${VALID_STATUSES.join(", ")}`);
  }

  const marker = await loadRestartMarker(workspaceRoot, taskId);
  if (!marker) {
    throw new Error(`No restart marker found for task: ${taskId}`);
  }

  const now = new Date().toISOString();
  marker.status = newStatus;
  marker.logs = marker.logs || [];
  marker.logs.push({ time: now, message: `Status changed to: ${newStatus}` });

  for (const [key, value] of Object.entries(extraFields)) {
    if (value !== undefined) {
      marker[key] = value;
    }
  }

  if (newStatus === "restarted") {
    marker.attempts = (marker.attempts || 0) + 1;
  }

  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");

  return marker;
}

/**
 * Scan all pending restart markers in the workspace.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<object[]>} array of marker objects
 */
export async function scanPendingRestartMarkers(workspaceRoot) {
  const dir = getPendingRestartsDir(workspaceRoot);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const markers = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const marker = await loadRestartMarker(workspaceRoot, taskId);
        if (marker) markers.push(marker);
      } catch {
        // skip unreadable markers
      }
    }

    // Sort by requested_at descending
    markers.sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    return markers;
  } catch {
    return [];
  }
}

/**
 * Synchronous version of scanPendingRestartMarkers for use in synchronous contexts
 * (e.g., gptwork_doctor suggested_next_actions).
 * Uses readdirSync / readFileSync instead of async variants.
 *
 * @param {string} workspaceRoot
 * @returns {object[]} array of marker objects
 */
export function scanPendingRestartMarkersSync(workspaceRoot) {
  const dir = getPendingRestartsDir(workspaceRoot);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const markers = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
        const data = readFileSync(markerPath, "utf8");
        markers.push(JSON.parse(data));
      } catch {
        // skip unreadable markers
      }
    }
    markers.sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    return markers;
  } catch {
    return [];
  }
}

/**
 * Remove a restart marker file.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<boolean>} true if the marker was removed
 */
export async function removeRestartMarker(workspaceRoot, taskId) {
  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  try {
    await rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
