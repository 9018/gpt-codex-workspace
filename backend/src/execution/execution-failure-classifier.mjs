import { classifyFailureStructured } from "../failure-classifier.mjs";

function text(value) {
  return String(value || "").trim();
}

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
  if (failure.code === "pty_unavailable" || failure.code === "provider_unavailable") return "provider_unavailable";
  if (failure.code === "execution_timeout" || failure.code === "provider_timeout") return "timed_out";
  return "failed";
}
