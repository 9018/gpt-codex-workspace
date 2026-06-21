import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getRunsBaseDir, getRunFilePath } from "./codex-run-paths.mjs";

export async function loadRun(workspaceRoot, taskId, runId) {
  try {
    const data = JSON.parse(await readFile(getRunFilePath(workspaceRoot, taskId, runId), "utf8"));
    return data;
  } catch {
    return null;
  }
}

/**
 * List all runs for a task, newest first.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object[]>}
 */
export async function listRuns(workspaceRoot, taskId) {
  const baseDir = join(getRunsBaseDir(workspaceRoot), String(taskId));
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runData = await loadRun(workspaceRoot, taskId, entry.name);
        if (runData) runs.push(runData);
      }
    }
    runs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    return runs;
  } catch {
    return [];
  }
}

/**
 * Get the latest run for a task (most recent started_at), or null.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function getLatestRun(workspaceRoot, taskId) {
  const runs = await listRuns(workspaceRoot, taskId);
  return runs.length > 0 ? runs[0] : null;
}

// ---------------------------------------------------------------------------
// Process/repo introspection
// ---------------------------------------------------------------------------

/**
 * Check if a process is alive by sending signal 0.
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
