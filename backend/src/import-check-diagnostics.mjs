const RUNNER_502_PATTERN = /\b(502|bad gateway|gateway error|upstream connect error|service unavailable)\b/i;

export const IMPORT_CHECK_LOCAL_COMMAND = "npm --prefix backend run check:imports";

export function classifyImportCheckRunnerFailure(input = {}) {
  const message = String(input.message || input.error?.message || input.stderr || input.stdout || "");
  if (!RUNNER_502_PATTERN.test(message)) {
    return {
      transient: false,
      kind: "unknown",
      tool_error: false,
      local_fallback_command: IMPORT_CHECK_LOCAL_COMMAND,
      recommendation: "Run the local backend import check in the target repo/worktree before treating this as a code failure.",
    };
  }
  return {
    transient: true,
    kind: "transient/tool_error",
    tool_error: true,
    status_code: 502,
    local_fallback_command: IMPORT_CHECK_LOCAL_COMMAND,
    recommendation: "MCP runner returned a transient 502/tool error. Re-run npm --prefix backend run check:imports directly in the repo/worktree and use that result for code health.",
  };
}

export function buildImportCheckDiagnostics(input = {}) {
  const classification = classifyImportCheckRunnerFailure(input);
  return {
    check: "npm_check_imports_runner",
    status: classification.transient ? "WARN" : "PASS",
    detail: classification.transient
      ? classification.recommendation
      : "Local import check command available for direct verification.",
    classification,
    local_fallback: {
      command: IMPORT_CHECK_LOCAL_COMMAND,
      auto_runnable: true,
      cwd: "repo_root_or_task_worktree",
    },
  };
}
