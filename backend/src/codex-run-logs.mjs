import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getStdoutLogPath, getStderrLogPath, MAX_STDOUT_TAIL_BYTES } from "./codex-run-paths.mjs";

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
