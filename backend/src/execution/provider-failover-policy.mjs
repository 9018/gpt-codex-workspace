export function selectFailoverProvider({ attempt = {}, failure = {}, availability = {} } = {}) {
  if (attempt.provider === "codex_exec" && availability.codex_tui) {
    if (failure.code === "no_content_output" && Number(failure.retry_count || 0) >= 1) {
      return { provider: "codex_tui", reason_code: "exec_no_content_output" };
    }
    if (failure.code === "structured_result_failure" && Number(failure.retry_count || 0) >= 2) {
      return { provider: "codex_tui", reason_code: "exec_structured_result_failure" };
    }
  }
  if (attempt.provider === "codex_tui" && availability.codex_exec) {
    if (failure.code === "pty_unavailable") return { provider: "codex_exec", reason_code: "tui_pty_unavailable" };
    if (failure.code === "provider_unavailable") return { provider: "codex_exec", reason_code: "tui_provider_unavailable" };
  }
  return null;
}
