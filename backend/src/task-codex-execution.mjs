import { fireHeartbeat, updateRunHeartbeat, writeRunLogs } from "./codex-run-metadata.mjs";
import { parseCodexResultWithFallback } from "./codex-result-parser.mjs";
import { runLocalShell } from "./workspace-service.mjs";

const RESULT_SEPARATOR = "=".repeat(60);

export async function executeCodexTaskRun({
  config,
  workspaceRoot,
  task,
  goal,
  promptFile,
  runFilePath = null,
  runId = null,
  runLocalShellFn = runLocalShell,
  parseCodexResultFn = parseCodexResultWithFallback,
  writeRunLogsFn = writeRunLogs,
  fireHeartbeatFn = fireHeartbeat,
  updateRunHeartbeatFn = updateRunHeartbeat,
}) {
  let summary = "";
  let parsedResult = null;
  let cr = null;

  const cmd = "codex exec " + config.codexExecArgs + " < " + promptFile;
  cr = await runLocalShellFn(cmd, workspaceRoot, config.codexExecTimeout, 1000000, (pid) => {
    updateRunHeartbeatFn(runFilePath, "running_codex", { codex_child_pid: pid }).catch(() => {});
  }, {
    firstOutputTimeoutSeconds: config.codexFirstOutputTimeout || 180,
    onOutput: (event) => {
      updateRunHeartbeatFn(runFilePath, "running_codex", {
        stdout_bytes: event.stdout_bytes,
        stderr_bytes: event.stderr_bytes,
        first_stdout_at: event.first_stdout_at,
        first_stderr_at: event.first_stderr_at,
        first_output_delay_ms: event.first_output_delay_ms,
      }).catch(() => {});
    },
  });

  if (cr && runId) {
    writeRunLogsFn({
      workspaceRoot: config.defaultWorkspaceRoot,
      taskId: task.id,
      runId,
      stdout: cr.stdout,
      stderr: cr.stderr,
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
    });
  }

  const out = (cr.stdout || "").trim();
  const resultJsonPath = workspaceRoot + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json";
  parsedResult = await parseCodexResultFn({ resultJsonPath, stdout: out });
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
