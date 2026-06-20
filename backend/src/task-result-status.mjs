import { validateAutonomyResult, detectRuntimeCodeChanges } from "./codex-result-parser.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";

const ACTIVE_RESTART_MARKER_STATUSES = new Set(["pending", "scheduled", "restarted"]);

export function deriveTaskStatusFromTaskResult(taskResult) {
  if (taskResult?.kind === "codex_executed") return "completed";
  if (taskResult?.kind === "codex_timeout" || taskResult?.kind === "no_first_output_timeout") return "timed_out";
  return "failed";
}

function appendWarning(taskResult, warning) {
  taskResult.warnings = taskResult.warnings || [];
  taskResult.warnings.push(warning);
}

export function applyAutonomyValidation(taskStatus, taskResult, goal, parsedResult) {
  if (taskStatus !== "completed" || !goal || !parsedResult) return taskStatus;
  const autonomyValidation = validateAutonomyResult(parsedResult, goal);
  if (autonomyValidation.valid) return taskStatus;
  appendWarning(taskResult, "Autonomy policy validation failed: " + autonomyValidation.reason);
  return "waiting_for_review";
}

export async function applyRuntimeCodeChangeGuard({
  taskStatus,
  taskResult,
  mode,
  parsedResult,
  workspaceRoot,
  taskId,
  loadRestartMarkerFn = loadRestartMarker,
}) {
  if (taskStatus !== "completed" || mode !== "deploy" || !parsedResult) return taskStatus;
  const runtimeCheck = detectRuntimeCodeChanges(parsedResult.changed_files || []);
  if (!runtimeCheck.hasRuntimeChanges) return taskStatus;

  let hasRestartMarker = false;
  try {
    const marker = await loadRestartMarkerFn(workspaceRoot, taskId);
    if (marker && ACTIVE_RESTART_MARKER_STATUSES.has(marker.status)) {
      hasRestartMarker = true;
    }
  } catch {}

  if (hasRestartMarker) return taskStatus;
  appendWarning(taskResult, "runtime_code_changed_without_safe_restart: " + runtimeCheck.matchedFiles.join(", "));
  return "waiting_for_review";
}
