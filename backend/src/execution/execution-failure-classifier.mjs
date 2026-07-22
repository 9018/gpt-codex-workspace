import { classifyFailureStructured } from "../failure-classifier.mjs";

function text(value) {
  return String(value || "").trim();
}

const TUI_PROVIDER_UNAVAILABLE_CODES = new Set([
  "codex_tui_unavailable",
  "pty_unavailable",
  "provider_unavailable",
  "codex_tui_native_session_unbound",
  "codex_tui_cwd_mismatch",
  "native_session_not_found",
  "native_session_ambiguous",
]);

export function classifyExecutionProviderFailure(error, { provider = null, phase = "observe" } = {}) {
  const rawCode = text(error?.code).toLowerCase();
  const message = text(error?.message || error);
  const lowered = message.toLowerCase();

  if (
    rawCode === "codex_tui_unavailable"
    || rawCode === "pty_unavailable"
    || lowered.includes("node-pty unavailable")
    || lowered.includes("no pty mechanism")
  ) {
    return { code: "pty_unavailable", failure_class: "provider_interruption", provider, phase, message };
  }
  if (
    rawCode === "codex_tui_native_session_unbound"
    || rawCode === "native_session_not_found"
    || rawCode === "native_session_ambiguous"
    || lowered.includes("native session binding failed")
    || lowered.includes("native_session_not_found")
  ) {
    return {
      code: "codex_tui_native_session_unbound",
      failure_class: "provider_interruption",
      provider,
      phase,
      message,
      retryable: false,
      repairable: false,
    };
  }
  if (rawCode === "codex_tui_cwd_mismatch" || lowered.includes("codex tui cwd mismatch")) {
    return {
      code: "codex_tui_cwd_mismatch",
      failure_class: "provider_interruption",
      provider,
      phase,
      message,
      retryable: false,
      repairable: false,
    };
  }
  if (rawCode === "etimedout" || rawCode === "execution_timeout" || lowered.includes("timed out")) {
    return { code: "execution_timeout", failure_class: "execution_timeout", provider, phase, message };
  }
  if (rawCode === "econnreset" || rawCode === "epipe" || rawCode === "provider_interruption") {
    return { code: "provider_interruption", failure_class: "provider_interruption", provider, phase, message };
  }

  const classified = classifyFailureStructured({ error, message });
  return {
    code: rawCode || classified.class || "provider_failure",
    failure_class: classified.class || "unknown_failure",
    retryable: classified.retryable === true,
    repairable: classified.repairable === true,
    provider,
    phase,
    message,
  };
}

export function executionFailureState(failure = {}) {
  if (TUI_PROVIDER_UNAVAILABLE_CODES.has(failure.code)) return "provider_unavailable";
  if (failure.code === "execution_timeout" || failure.code === "provider_timeout") return "timed_out";
  return "failed";
}
