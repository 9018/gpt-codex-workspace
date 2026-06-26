/**
 * failure-classifier.mjs — Failure classification for Codex task results.
 *
 * Classifies failures into categories that determine repair eligibility,
 * notification strategy, and terminal-state decisions.
 */

/**
 * Classify a task failure into a named category.
 *
 * Network-level failures are checked first to prevent transient network issues
 * from being misclassified as repairable code-level failures.
 *
 * @param {object} [input={}] - Diagnostics input
 * @param {object} [input.resultJson] - Parsed result.json
 * @param {object} [input.result] - Result object (alias for resultJson)
 * @param {object} [input.error] - Error object
 * @param {string} [input.message] - Error message string
 * @returns {string} Failure class name
 */
export function classifyFailure(input = {}) {
  const result = input.resultJson || input.result || {};
  const error = input.error || {};
  const message = String(input.message || error.message || result.summary || "").toLowerCase();

  // ---- P0: Network failure classes ----
  // Checked before code-level failures to prevent transient network issues
  // from being misclassified as repairable code failures.
  if (
    input.rateLimited ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded")
  ) return "rate_limited";

  if (
    input.gatewayError ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("gateway") ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("upstream")
  ) return "gateway_error";

  if (
    input.transientNetworkError ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    (message.includes("enotfound") && !message.includes("test"))
  ) return "transient_network_error";

  if (
    input.codexTimeout ||
    result.codex_timeout ||
    message.includes("codex timeout") ||
    message.includes("codex execution timed out")
  ) return "codex_timeout";

  // ---- Code-level failure classes ----
  if (input.missingResultJson || (message.includes("result.json") && message.includes("missing"))) return "missing_result_json";
  if (input.invalidResultJson || (message.includes("json") && (message.includes("parse") || message.includes("invalid")))) return "invalid_result_json";
  if (input.noFirstOutputTimeout || result.no_first_output_timeout || message.includes("first-output timeout")) return "first_output_timeout";
  if (input.mergeConflict || message.includes("merge conflict") || message.includes("conflict")) return "merge_conflict";
  if (result.verification?.passed === false || input.verification?.passed === false || message.includes("test failed") || message.includes("tests failed")) return "test_failed";
  if (input.staleRunningTask || message.includes("stale running")) return "stale_running_task";
  if (result.status === "failed") return "task_failed";
  return "unknown";
}

/**
 * Determine if a failure class should trigger automatic repair.
 *
 * Only code-level failures are repairable. Network errors (rate_limited,
 * gateway_error, transient_network_error, codex_timeout) are terminal
 * and should NOT enter the repair loop — retrying them is counterproductive
 * and may exacerbate resource exhaustion.
 *
 * @param {string} failureClass
 * @returns {boolean}
 */
export function failureClassRequiresRepair(failureClass) {
  // Network and terminal failures are not repairable
  if (failureClassIsTerminalNonRepairable(failureClass)) return false;
  // Only code-level failures that can be addressed by re-running repairs
  return new Set([
    "missing_result_json",
    "invalid_result_json",
    "test_failed",
    "first_output_timeout",
    "merge_conflict",
  ]).has(failureClass);
}

/**
 * Check whether a failure class is terminal-but-non-repairable.
 *
 * These failures (e.g., rate limiting, gateway errors) cannot be fixed
 * by re-running the same operation and must be escalated, blocked, or
 * handled at the infrastructure level. The repair loop must NOT retry
 * these.
 *
 * @param {string} failureClass
 * @returns {boolean}
 */
export function failureClassIsTerminalNonRepairable(failureClass) {
  return new Set([
    "rate_limited",
    "gateway_error",
    "transient_network_error",
    "codex_timeout",
    "stale_running_task",
    "task_failed",
  ]).has(failureClass);
}
