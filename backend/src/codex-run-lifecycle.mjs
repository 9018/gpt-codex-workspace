import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getRunDir, getRunFilePath, getStdoutLogPath, getStderrLogPath } from "./codex-run-paths.mjs";

const heartbeatWriteQueues = new Map();

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
