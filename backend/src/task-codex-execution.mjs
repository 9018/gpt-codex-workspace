import { fireHeartbeat, updateRunHeartbeat, writeRunLogs, ensureRunLogFiles, createThrottledHeartbeat, removeThrottledHeartbeat, getStdoutLogPath, getStderrLogPath } from "./codex-run-metadata.mjs";
import { parseCodexResultWithFallback } from "./codex-result-parser.mjs";
import { updateRepoLock } from "./repo-lock.mjs";
import { runLocalShell } from "./workspace-service.mjs";

const RESULT_SEPARATOR = "=".repeat(60);

export function isCodexContentfulOutput({ streamName, chunk } = {}) {
  const text = String(chunk || "");
  if (!text.trim()) return false;
  if (streamName === "stdout") return true;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;

  const bannerPrefixes = [
    "Reading prompt from stdin",
    "OpenAI Codex",
    "workdir:",
    "model:",
    "provider:",
    "approval:",
    "sandbox:",
    "reasoning effort:",
    "reasoning summaries:",
    "session id:",
  ];

  for (const line of lines) {
    if (line === "--------" || line === "user") continue;
    if (bannerPrefixes.some((prefix) => line.startsWith(prefix))) continue;
    if (/^# Task:/.test(line)) continue;
    if (/^##\s+/.test(line)) continue;
    if (/^- \*\*/.test(line)) continue;
    if (/^(Goal ID|Conversation ID|Mode|User Request|Goal Prompt|Context Summary):/.test(line)) continue;

    if (/^(assistant|thinking|exec|apply_patch|patch|tool|status|summary)\b/i.test(line)) return true;
    if (/^(STATUS|SUMMARY|CHANGED_FILES|TESTS|COMMIT|REMOTE_HEAD)=/.test(line)) return true;
    if (/^(\+|-|diff --git|@@ )/.test(line)) return true;
  }
  return false;
}

export async function executeCodexTaskRun({
  config,
  workspaceRoot,
  task,
  goal,
  resultJsonPath,
  executionCwd = null,
  promptFile,
  runFilePath = null,
  runId = null,
  repoLockPath = null,
  runLocalShellFn = runLocalShell,
  parseCodexResultFn = parseCodexResultWithFallback,
  writeRunLogsFn = writeRunLogs,
  ensureRunLogFilesFn = ensureRunLogFiles,
  fireHeartbeatFn = fireHeartbeat,
  updateRunHeartbeatFn = updateRunHeartbeat,
  updateRepoLockFn = updateRepoLock,
}) {
  let summary = "";
  let parsedResult = null;
  let cr = null;

  const lastMessagePath = workspaceRoot + "/.gptwork/tmp/codex-lastmsg-" + task.id + ".txt";
  const cmd = "codex exec " + config.codexExecArgs + " --output-last-message " + lastMessagePath + " < " + promptFile;

  const throttledHb = runFilePath ? createThrottledHeartbeat(runFilePath, 1000, updateRunHeartbeatFn) : null;

  const streamOpts = {};
  if (runId && workspaceRoot && task) {
    streamOpts.streamStdoutPath = getStdoutLogPath(workspaceRoot, task.id, runId);
    streamOpts.streamStderrPath = getStderrLogPath(workspaceRoot, task.id, runId);
  }
  const hasStreamingLogs = Boolean(streamOpts.streamStdoutPath || streamOpts.streamStderrPath);

  const outputMetricFields = (event = {}) => ({
    stdout_bytes: event.stdout_bytes,
    stderr_bytes: event.stderr_bytes,
    first_stdout_at: event.first_stdout_at,
    first_stderr_at: event.first_stderr_at,
    first_output_delay_ms: event.first_output_delay_ms,
    content_first_output_at: event.content_first_output_at,
    content_first_output_delay_ms: event.content_first_output_delay_ms,
    last_content_progress_at: event.last_content_progress_at,
  });

  const cwd = executionCwd || workspaceRoot;
  cr = await runLocalShellFn(cmd, cwd, config.codexExecTimeout, 1000000, (pid) => {
    if (repoLockPath) {
      updateRepoLockFn(config.defaultWorkspaceRoot, repoLockPath, task.id, { child_pid: pid }).catch(() => {});
    }
    if (throttledHb) {
      throttledHb("running_codex", { codex_child_pid: pid });
    } else {
      updateRunHeartbeatFn(runFilePath, "running_codex", { codex_child_pid: pid }).catch(() => {});
    }
  }, {
    firstOutputTimeoutSeconds: config.codexFirstOutputTimeout || 180,
    contentFirstOutputTimeoutSeconds: config.codexContentFirstOutputTimeout || 0,
    noProgressTimeoutSeconds: config.codexNoProgressTimeout || 0,
    isContentfulOutput: isCodexContentfulOutput,
    onOutput: (event) => {
      const fields = outputMetricFields(event);
      if (throttledHb) {
        throttledHb("running_codex", fields);
      } else {
        updateRunHeartbeatFn(runFilePath, "running_codex", fields).catch(() => {});
      }
    },
    ...streamOpts,
  });

  if (throttledHb) removeThrottledHeartbeat(runFilePath);

  if (cr && runId && hasStreamingLogs) {
    await ensureRunLogFilesFn({
      workspaceRoot: config.defaultWorkspaceRoot,
      taskId: task.id,
      runId,
    }).catch(() => {});
  }

  if (cr && runId && !hasStreamingLogs) {
    await writeRunLogsFn({
      workspaceRoot: config.defaultWorkspaceRoot,
      taskId: task.id,
      runId,
      stdout: cr.stdout || "",
      stderr: cr.stderr || "",
    }).catch(() => {});
  }

  if (runFilePath) {
    fireHeartbeatFn(runFilePath, "parsing_result", {
      exit_code: cr?.returncode ?? -1,
      timed_out: cr?.timed_out || false,
      no_first_output_timeout: cr?.no_first_output_timeout || false,
      first_output_timeout_seconds: cr?.first_output_timeout_seconds,
      stdout_bytes: cr?.stdout_bytes,
      stderr_bytes: cr?.stderr_bytes,
      first_stdout_at: cr?.first_stdout_at,
      first_stderr_at: cr?.first_stderr_at,
      first_output_delay_ms: cr?.first_output_delay_ms,
      content_first_output_at: cr?.content_first_output_at,
      content_first_output_delay_ms: cr?.content_first_output_delay_ms,
      last_content_progress_at: cr?.last_content_progress_at,
      no_content_first_output_timeout: cr?.no_content_first_output_timeout || false,
      no_content_progress_timeout: cr?.no_content_progress_timeout || false,
      content_first_output_timeout_seconds: cr?.content_first_output_timeout_seconds,
      no_progress_timeout_seconds: cr?.no_progress_timeout_seconds,
    });
  }

  const out = (cr.stdout || "").trim();
  const resolvedResultJsonPath = resultJsonPath || (workspaceRoot + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json");
  parsedResult = await parseCodexResultFn({ resultJsonPath: resolvedResultJsonPath, stdout: out });
  if (parsedResult.summary) {
    summary = parsedResult.summary;
  } else {
    if (out) {
      const headerIndex = out.indexOf(RESULT_SEPARATOR);
      summary = headerIndex >= 0 ? out.substring(headerIndex) : out;
    }
    if (!summary && cr.stderr) summary = (cr.stderr || "").trim().slice(0, 10000);
  }

  return { cr, parsedResult, summary };
}
