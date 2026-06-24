import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { getStdoutLogPath, getStderrLogPath, MAX_STDOUT_TAIL_BYTES } from "./codex-run-paths.mjs";

const logAppendQueues = new Map();

export function trimUtf8Tail(text = "", maxBytes = MAX_STDOUT_TAIL_BYTES) {
  const str = String(text || "");
  const limit = Math.max(1, Number(maxBytes) || MAX_STDOUT_TAIL_BYTES);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return { tail: str, truncated: false };

  let tail = buf.subarray(buf.length - limit).toString("utf8").replace(/^\uFFFD+/, "");
  while (Buffer.byteLength(tail, "utf8") > limit) {
    tail = tail.slice(1);
  }
  return { tail, truncated: true };
}

export async function appendLogFile(filePath, chunk) {
  if (!filePath || chunk === undefined || chunk === null) return;
  const previous = logAppendQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, chunk, "utf8");
  });
  logAppendQueues.set(filePath, next);
  next.finally(() => {
    if (logAppendQueues.get(filePath) === next) logAppendQueues.delete(filePath);
  }).catch(() => {});
  return next;
}

export function streamToLog(opts = {}) {
  const { filePath, chunk, boundedTail = "", maxTailBytes = MAX_STDOUT_TAIL_BYTES } = opts;
  if (!filePath || chunk === undefined || chunk === null || chunk === "") return { tail: boundedTail, truncated: false };

  // Append to file in per-file order. Fire-and-forget keeps streaming fast,
  // while appendLogFile serializes concurrent chunks for stable logs.
  appendLogFile(filePath, chunk).catch(() => {});

  // Keep bounded UTF-8 tail in memory without slicing by UTF-16 code units.
  return trimUtf8Tail(boundedTail + chunk, maxTailBytes);
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

  // Append-mode for streaming: writes are serialized per log file to avoid
  // out-of-order chunks when stdout/stderr handlers fire quickly.
  await appendLogFile(stdLog, stdout || "");
  await appendLogFile(errLog, stderr || "");
}

export async function ensureRunLogFiles(opts = {}) {
  const { workspaceRoot, taskId, runId } = opts;
  if (!workspaceRoot || !taskId || !runId) return;
  for (const filePath of [getStdoutLogPath(workspaceRoot, taskId, runId), getStderrLogPath(workspaceRoot, taskId, runId)]) {
    await mkdir(dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    await handle.close();
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
