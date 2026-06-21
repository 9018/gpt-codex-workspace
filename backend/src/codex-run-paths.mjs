import { join } from "node:path";

export const RUNS_DIR = ".gptwork/runs";
export const MAX_STDOUT_TAIL_BYTES = 256 * 1024; // 256KB tail kept in memory
export const MAX_STDERR_TAIL_BYTES = 64 * 1024;  // 64KB stderr tail

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Create or get a throttled heartbeat updater for a run.
 * Phase changes (phase !== lastPhase) flush immediately.
 * Output-only updates flush at most once per second (default interval).
 *
 * @param {string} runFilePath
 * @param {number} [intervalMs=1000]
 * @returns {(phase: string, fields?: object) => void} fire-and-forget throttled updater
 */

export function getRunsBaseDir(workspaceRoot) {
  return join(workspaceRoot, RUNS_DIR);
}

export function getRunDir(workspaceRoot, taskId, runId) {
  return join(getRunsBaseDir(workspaceRoot), String(taskId), String(runId));
}

export function getRunFilePath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "run.json");
}

export function getStdoutLogPath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "stdout.log");
}

export function getStderrLogPath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "stderr.log");
}

// ---------------------------------------------------------------------------
// Run metadata lifecycle
// ---------------------------------------------------------------------------

/**
 * Create initial run metadata for a Codex execution.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot — workspace root path
 * @param {string} opts.taskId — task id
 * @param {string} [opts.workspaceId] — workspace id
 * @param {string} [opts.repoPath] — canonical repo path if known
 * @param {string} [opts.promptPath] — prompt file path if written
 * @returns {Promise<{runDir: string, runFilePath: string, runId: string, runData: object}>}
 */
