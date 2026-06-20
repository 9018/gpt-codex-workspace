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
 * - Heartbeat throttling (P1.1): phase changes flush immediately, output counters at most 1/s
 * - Output streaming to log files during execution (P1.1)
 */

import { readdir, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const RUNS_DIR = ".gptwork/runs";
const heartbeatWriteQueues = new Map();
const MAX_STDOUT_TAIL_BYTES = 256 * 1024; // 256KB tail kept in memory
const MAX_STDERR_TAIL_BYTES = 64 * 1024;  // 64KB stderr tail

// ---------------------------------------------------------------------------
// Heartbeat throttling (P1.1)
// ---------------------------------------------------------------------------

/** Per-run heartbeat throttler state */
const _heartbeatThrottlers = new Map();

/**
 * Create or get a throttled heartbeat updater for a run.
 * Phase changes (phase !== lastPhase) flush immediately.
 * Output-only updates flush at most once per second (default interval).
 *
 * @param {string} runFilePath
 * @param {number} [intervalMs=1000]
 * @returns {(phase: string, fields?: object) => void} fire-and-forget throttled updater
 */
export function createThrottledHeartbeat(runFilePath, intervalMs = 1000, heartbeatFn = null) {
  let lastFlushAt = 0;
  let lastPhase = null;
  let pendingFields = null;
  let pendingPhase = null;
  let timer = null;

  const writeFn = heartbeatFn || ((path, phase, fields) => updateRunHeartbeat(path, phase, fields));

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const phase = pendingPhase || lastPhase || "unknown";
    const fields = pendingFields || {};
    lastFlushAt = Date.now();
    pendingPhase = null;
    pendingFields = null;
    writeFn(runFilePath, phase, fields).catch(() => {});
  }

  function throttledUpdate(phase, fields = {}) {
    const now = Date.now();
    const phaseChanged = phase !== lastPhase;
    lastPhase = phase;

    if (phaseChanged) {
      // Phase change: flush immediately
      pendingPhase = phase;
      pendingFields = fields;
      flush();
      return;
    }

    // Output-only update: throttle
    pendingFields = { ...pendingFields, ...fields };
    pendingPhase = phase;

    if (now - lastFlushAt >= intervalMs) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, intervalMs - (now - lastFlushAt));
    }
  }

  _heartbeatThrottlers.set(runFilePath, throttledUpdate);
  return throttledUpdate;
}

/**
 * Get an existing throttled heartbeat function, or create one.
 * @param {string} runFilePath
 * @returns {function}
 */
export function getThrottledHeartbeat(runFilePath) {
  let fn = _heartbeatThrottlers.get(runFilePath);
  if (!fn) {
    fn = createThrottledHeartbeat(runFilePath);
    _heartbeatThrottlers.set(runFilePath, fn);
  }
  return fn;
}

/**
 * Remove throttled heartbeat for a run (cleanup after final heartbeat).
 * @param {string} runFilePath
 */
export function removeThrottledHeartbeat(runFilePath) {
  const fn = _heartbeatThrottlers.get(runFilePath);
  if (fn) _heartbeatThrottlers.delete(runFilePath);
}

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
 * Uses throttling when called through createThrottledHeartbeat.
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
 * Stream a chunk of output to a run log file (append-only).
 * Also returns bounded tail for in-memory fallback.
 *
 * @param {object} opts
 * @param {string} opts.filePath - log file path (stdout.log or stderr.log)
 * @param {string} opts.chunk - output chunk to append
 * @param {string} [opts.boundedTail] - current bounded tail string (mutated in place)
 * @param {number} [opts.maxTailBytes] - max bytes to keep in tail
 * @returns {{ tail: string, truncated: boolean }}
 */
export function streamToLog(opts = {}) {
  const { filePath, chunk, boundedTail = "", maxTailBytes = MAX_STDOUT_TAIL_BYTES } = opts;
  if (!filePath || !chunk) return { tail: boundedTail, truncated: false };

  // Append to file asynchronously (fire-and-forget for streaming perf)
  appendFile(filePath, chunk, "utf8").catch(() => {});

  // Keep bounded tail in memory
  let tail = boundedTail + chunk;
  let truncated = false;
  if (Buffer.byteLength(tail) > maxTailBytes) {
    const excess = Buffer.byteLength(tail) - maxTailBytes;
    tail = tail.slice(excess);
    truncated = true;
  }
  return { tail, truncated };
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

  // Append-mode for streaming: write logs incrementally
  if (stdout) {
    await mkdir(dirname(stdLog), { recursive: true });
    await appendFile(stdLog, stdout, "utf8");
  }
  if (stderr) {
    await mkdir(dirname(errLog), { recursive: true });
    await appendFile(errLog, stderr, "utf8");
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
