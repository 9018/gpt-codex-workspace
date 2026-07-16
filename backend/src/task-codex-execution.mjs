import { fireHeartbeat, updateRunHeartbeat, writeRunLogs, ensureRunLogFiles, createThrottledHeartbeat, removeThrottledHeartbeat, getStdoutLogPath, getStderrLogPath } from "./codex-run-metadata.mjs";
import { parseCodexResultWithFallback } from "./codex-result-parser.mjs";
import { updateRepoLock } from "./repo-lock.mjs";
import { runLocalShell } from "./workspace-service.mjs";
import { parseNativeCodexSessionId } from "./codex-session/native-session-id-parser.mjs";
import { createCodexSessionManifestStore } from "./codex-session/codex-session-manifest-store.mjs";
import { buildCodexProcessEnvironment } from "./path-context/codex-process-environment.mjs";
/**
 * Re-resolve codex exec CLI arguments at execution time.
 * Reads from the current process.env GPTWORK_CODEX_EXEC_ARGS so that
 * runtime.env or environment changes between startup and execution are
 * picked up per task/retry.  Falls back to the startup-snapshot config,
 * then to a hardcoded default.
 *
 * @param {object}  config    - Startup runtime config snapshot
 * @param {object}  [task]    - Task object for optional per-task overrides
 * @returns {string} Effective codex exec CLI args
 */
export function resolveCodexExecArgs(config, task = null) {
  if (task?.metadata?.codex_exec_args && typeof task.metadata.codex_exec_args === "string" && task.metadata.codex_exec_args.trim()) {
    return task.metadata.codex_exec_args.trim();
  }
  const envVal = process.env.GPTWORK_CODEX_EXEC_ARGS;
  if (envVal && typeof envVal === "string" && envVal.trim()) {
    return envVal.trim();
  }
  if (config?.codexExecArgs && typeof config.codexExecArgs === "string" && config.codexExecArgs.trim()) {
    return config.codexExecArgs.trim();
  }
  return "--yolo --skip-git-repo-check";
}

/**
 * Extract model/provider/reasoning_effort from Codex CLI banner output.
 */
export function extractHeaderMetadata(text) {
  const result = { model: null, provider: null, reasoning_effort: null };
  if (!text) return result;
  for (const line of String(text).split("\n")) {
    if (!result.model) { const m = line.match(/^model:\s*(.+)/im); if (m) result.model = m[1].trim(); }
    if (!result.provider) { const m = line.match(/(?:api\s+)?provider:\s*(.+)/im); if (m) result.provider = m[1].trim(); }
    if (!result.reasoning_effort) { const m = line.match(/reasoning\s+effort:\s*(.+)/im); if (m) result.reasoning_effort = m[1].trim(); }
  }
  return result;
}



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
  pathContext = null,
  executionId = null,
  controlSessionId = null,
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
    // P0: Re-resolve codex exec args at execution time, not from stale startup config.
  const effectiveCodexExecArgs = resolveCodexExecArgs(config, task);
  const effectiveConfigSource = process.env.GPTWORK_CODEX_EXEC_ARGS ? "process.env" : (config?.codexExecArgs ? "startup_config" : "default");
  const cmd = "codex exec " + effectiveCodexExecArgs + " --output-last-message " + lastMessagePath + " < " + promptFile;

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
  const processEnv = pathContext
    ? buildCodexProcessEnvironment(pathContext, {
      taskId: task?.id,
      goalId: goal?.id,
      executionId: executionId || runId,
      controlSessionId,
    })
    : process.env;
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
    env: processEnv,
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
  let headerMeta = null;
  if (parsedResult.summary) {
    summary = parsedResult.summary;
    // P0: Annotate parsed result with effective model/provider from codex CLI header
    headerMeta = extractHeaderMetadata((cr?.stdout || "") + "\n" + (cr?.stderr || ""));
    parsedResult.model = headerMeta.model || parsedResult.model || null;
    parsedResult.provider = headerMeta.provider || parsedResult.provider || null;
  } else {
    // P0-07: structured fallback — if parsedResult returned no summary,
    // capture stdout/stderr excerpts for review packet diagnostics.
    // This ensures the review reason is actionable even when the model
    // produced no structured output.
    if (out) {
      const headerIndex = out.indexOf(RESULT_SEPARATOR);
      summary = headerIndex >= 0 ? out.substring(headerIndex) : out;
    }
    if (!summary && cr.stderr) summary = (cr.stderr || "").trim().slice(0, 10000);

    // P0-07: When summary is still missing after all fallbacks, annotate
    // the parsed result with explicit diagnostic info for review packet.
    if (!summary) {
      parsedResult = parsedResult || {};
      parsedResult._no_structured_summary = true;
      parsedResult._fallback_diagnostic = {
        reason: "No structured summary could be extracted from stdout or stderr.",
        stdout_bytes: cr?.stdout_bytes || 0,
        stderr_bytes: cr?.stderr_bytes || 0,
        exit_code: cr?.returncode ?? null,
        timed_out: cr?.timed_out || false,
        no_first_output_timeout: cr?.no_first_output_timeout || false,
        has_stdout: Boolean(cr?.stdout?.trim()),
        has_stderr: Boolean(cr?.stderr?.trim()),
        first_output_delay_ms: cr?.first_output_delay_ms ?? null,
        content_first_output_delay_ms: cr?.content_first_output_delay_ms ?? null,
        no_content_first_output_timeout: cr?.no_content_first_output_timeout || false,
        no_content_progress_timeout: cr?.no_content_progress_timeout || false,
        review_reason: "Codex exec produced no structured result. Check provider logs and stdout/stderr output for model errors. If the model returned content but no structured fields, this may indicate a model/provider compatibility issue.",
        repair_suggestion: "If the model returned raw content without structured fields, consider adjusting the prompt format. If no content was returned at all, retry with compacted context or check provider availability.",
      };
    }
  }

  // Build diagnostic metadata for caller
  const codexMeta = {
    model: headerMeta?.model || null,
    provider: headerMeta?.provider || null,
    reasoning_effort: headerMeta?.reasoning_effort || null,
    config_source: effectiveConfigSource,
    effective_args: effectiveCodexExecArgs,
    native_session_id: parseNativeCodexSessionId(`${cr?.stdout || ""}\n${cr?.stderr || ""}`),
  };

  if (pathContext && (controlSessionId || executionId || runId)) {
    const manifestControlId = controlSessionId || executionId || runId;
    try {
      await createCodexSessionManifestStore({ projectRoot: pathContext.projectRoot }).write({
        control_session_id: manifestControlId,
        native_session_id: codexMeta.native_session_id,
        task_id: task?.id || null,
        goal_id: goal?.id || null,
        execution_id: executionId || runId || null,
        cwd,
        codex_home: pathContext.codexHome,
        provider: "codex_exec",
        status: cr?.returncode === 0 ? "completed" : "failed",
      });
    } catch {
      // Session attribution diagnostics must not change task execution outcome.
    }
  }

  return { cr, parsedResult, summary, codexMeta };
}
