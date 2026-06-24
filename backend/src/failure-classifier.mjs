export function classifyFailure(input = {}) {
  const result = input.resultJson || input.result || {};
  const error = input.error || {};
  const message = String(input.message || error.message || result.summary || "").toLowerCase();

  if (input.missingResultJson || message.includes("result.json") && message.includes("missing")) return "missing_result_json";
  if (input.invalidResultJson || message.includes("json") && (message.includes("parse") || message.includes("invalid"))) return "invalid_result_json";
  if (input.noFirstOutputTimeout || result.no_first_output_timeout || message.includes("first-output timeout")) return "first_output_timeout";
  if (input.mergeConflict || message.includes("merge conflict") || message.includes("conflict")) return "merge_conflict";
  if (result.verification?.passed === false || input.verification?.passed === false || message.includes("test failed") || message.includes("tests failed")) return "test_failed";
  if (input.staleRunningTask || message.includes("stale running")) return "stale_running_task";
  if (result.status === "failed") return "task_failed";
  return "unknown";
}

export function failureClassRequiresRepair(failureClass) {
  return new Set(["missing_result_json", "invalid_result_json", "test_failed", "first_output_timeout", "merge_conflict"]).has(failureClass);
}
