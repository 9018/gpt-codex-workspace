/**
 * codex-run-metadata.mjs — Run metadata, heartbeat, diagnostics, and recovery for Codex tasks.
 *
 * Provides:
 * - Per-run metadata stored under .gptwork/runs/<task_id>/<run_id>/run.json
 * - Heartbeat updates during Codex execution phases
 * - Durable stdout/stderr log files for each run
 * - Task diagnostics to identify stalled/stuck Codex runs
 * - Recovery actions for stuck tasks (mark_waiting_review, mark_failed, reset_to_assigned, etc.)
 * - Startup reconciliation for tasks left in "running" state after service restart
 * - Secret stripping to keep passwords/tokens out of diagnostic output
 */

import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const RUNS_DIR = ".gptwork/runs";
const heartbeatWriteQueues = new Map();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

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
export async function initRun(opts = {}) {
  const { workspaceRoot, taskId, workspaceId, repoPath, promptPath } = opts;
  if (!workspaceRoot || !taskId) {
    throw new Error("workspaceRoot and taskId are required for initRun");
  }

  const runId = randomUUID();
  const runDir = getRunDir(workspaceRoot, taskId, runId);
  await mkdir(runDir, { recursive: true });

  const now = new Date().toISOString();
  const runData = {
    run_id: runId,
    task_id: taskId,
    started_at: now,
    last_heartbeat_at: now,
    phase: "preparing",
    codex_child_pid: null,
    workspace_id: workspaceId || null,
    repo_path: repoPath || null,
    prompt_path: promptPath || null,
    stdout_log_path: getStdoutLogPath(workspaceRoot, taskId, runId),
    stderr_log_path: getStderrLogPath(workspaceRoot, taskId, runId),
    result_json_path: null,
    exit_code: null,
    timed_out: false
  };

  const runFilePath = getRunFilePath(workspaceRoot, taskId, runId);
  await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");

  return { runDir, runFilePath, runId, runData };
}

/**
 * Update heartbeat and optional fields in run.json.
 *
 * @param {string} runFilePath — path to run.json
 * @param {string} phase — current phase name
 * @param {object} [fields] — additional fields to merge (e.g. codex_child_pid, exit_code)
 * @returns {Promise<object>} updated run data
 */
export async function updateRunHeartbeat(runFilePath, phase, fields = {}) {
  const previous = heartbeatWriteQueues.get(runFilePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => updateRunHeartbeatUnlocked(runFilePath, phase, fields));
  const cleanup = next.finally(() => {
    if (heartbeatWriteQueues.get(runFilePath) === cleanup) heartbeatWriteQueues.delete(runFilePath);
  });
  heartbeatWriteQueues.set(runFilePath, cleanup);
  return next;
}

async function updateRunHeartbeatUnlocked(runFilePath, phase, fields = {}) {
  let runData = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      runData = JSON.parse(await readFile(runFilePath, "utf8"));
      break;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!runData) {
    // Avoid overwriting a transiently unreadable/half-written run.json with
    // incomplete metadata. Fire-and-forget callers treat this as non-fatal.
    return null;
  }

  runData.last_heartbeat_at = new Date().toISOString();
  runData.phase = phase;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      runData[key] = value;
    }
  }

  await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  return runData;
}

/**
 * Fire-and-forget heartbeat update. Non-blocking; errors are silently caught.
 */
export function fireHeartbeat(runFilePath, phase, fields = {}) {
  if (!runFilePath) return;
  updateRunHeartbeat(runFilePath, phase, fields).catch(() => {});
}

/**
 * Write stdout and stderr to durable log files for a run.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string} opts.taskId
 * @param {string} opts.runId
 * @param {string} [opts.stdout]
 * @param {string} [opts.stderr]
 */
export async function writeRunLogs(opts = {}) {
  const { workspaceRoot, taskId, runId, stdout, stderr } = opts;
  if (!workspaceRoot || !taskId || !runId) return;

  const stdLog = getStdoutLogPath(workspaceRoot, taskId, runId);
  const errLog = getStderrLogPath(workspaceRoot, taskId, runId);

  if (stdout) {
    await mkdir(dirname(stdLog), { recursive: true });
    await writeFile(stdLog, stdout, "utf8");
  }
  if (stderr) {
    await mkdir(dirname(errLog), { recursive: true });
    await writeFile(errLog, stderr, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Run queries
// ---------------------------------------------------------------------------

/**
 * Load run metadata for a specific run.
 * Returns null if the run file does not exist or is invalid.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
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
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a git repo has uncommitted changes.
 *
 * @param {string|null|undefined} repoPath
 * @returns {boolean}
 */
export function isRepoDirty(repoPath) {
  if (!repoPath) return false;
  try {
    if (!existsSync(join(repoPath, ".git"))) return false;
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

