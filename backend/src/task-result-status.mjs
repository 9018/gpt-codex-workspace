import { validateAutonomyResult, detectRuntimeCodeChanges } from "./codex-result-parser.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";

const ACTIVE_RESTART_MARKER_STATUSES = new Set(["pending", "scheduled", "restarted"]);

export function deriveTaskStatusFromTaskResult(taskResult) {
  if (taskResult?.kind === "codex_executed") return "completed";
  if (taskResult?.kind === "codex_timeout" || taskResult?.kind === "no_first_output_timeout") return "timed_out";
  if (taskResult?.kind === "noop") return "waiting_for_review";
  return "failed";
}

function appendWarning(taskResult, warning) {
  taskResult.warnings = taskResult.warnings || [];
  taskResult.warnings.push(warning);
}

/**
 * Check if a task title indicates P0/P0.x priority.
 * Matches titles like "P0: ...", "P0.1: ...", "P0.x: ...", "P0 Task: ...", etc.
 *
 * @param {string} taskTitle - The task title to check.
 * @returns {boolean} true if the title indicates P0 priority.
 */
export function isP0TaskTitle(taskTitle) {
  if (!taskTitle || typeof taskTitle !== "string") return false;
  return /^P0[\.\s:-]/.test(taskTitle);
}

export function applyAutonomyValidation(taskStatus, taskResult, goal, parsedResult) {
  if (taskStatus !== "completed" || !goal || !parsedResult) return taskStatus;
  const autonomyValidation = validateAutonomyResult(parsedResult, goal);
  if (autonomyValidation.valid) return taskStatus;
  appendWarning(taskResult, "Autonomy policy validation failed: " + autonomyValidation.reason);
  return "waiting_for_review";
}

/**
 * Apply the runtime code change guard to a completed task.
 *
 * If the task changed runtime/server/tool files AND did not schedule a safe
 * restart, the task is moved to "waiting_for_review" with a clear warning.
 *
 * Triggers when:
 *   1. mode === "deploy" (existing behavior)
 *   2. isP0Task === true (P0/P0.x priority tasks that changed runtime files)
 *   3. parsedResult.requires_mcp_restart === true (user explicitly requested)
 *
 * If none of these triggers match, the guard is skipped and the task
 * completes normally regardless of which files changed.
 *
 * @param {object} options
 * @param {string}  options.taskStatus     - Current task status
 * @param {object}  options.taskResult     - Task result object (mutated to add warnings)
 * @param {string}  options.mode           - Task execution mode ("builder", "deploy", etc.)
 * @param {object}  options.parsedResult   - Parsed result from codex-result-parser
 * @param {string}  options.workspaceRoot  - Workspace root path for restart marker lookup
 * @param {string}  options.taskId         - Task ID for restart marker lookup
 * @param {boolean} [options.isP0Task=false] - True if the task is P0/P0.x priority
 * @param {function} [options.loadRestartMarkerFn] - Mockable restart marker loader
 * @returns {Promise<string>} Updated task status
 */
export async function applyRuntimeCodeChangeGuard({
  taskStatus,
  taskResult,
  mode,
  parsedResult,
  workspaceRoot,
  taskId,
  isP0Task = false,
  loadRestartMarkerFn = loadRestartMarker,
}) {
  if (taskStatus !== "completed" || !parsedResult) return taskStatus;

  // Determine whether this task requires a restart check.
  // 1. mode === "deploy" (existing behavior — deploy tasks always need restart check)
  // 2. isP0Task (P0/P0.x priority tasks that changed runtime files)
  // 3. parsedResult.requires_mcp_restart === true (user explicitly requested)
  const needsRestartCheck = mode === "deploy" || isP0Task || parsedResult.requires_mcp_restart === true;
  if (!needsRestartCheck) return taskStatus;

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

/**
 * Check whether a task result includes a restart_state field indicating
 * a safe restart was verified. Used by the finalizer to include restart
 * metadata in completion output.
 *
 * @param {object} taskResult
 * @returns {{ hasRestart: boolean, restartState: string|null, runningCommit: string|null }}
 */
export function getRestartVerification(taskResult) {
  if (!taskResult) return { hasRestart: false, restartState: null, runningCommit: null };
  const restartState = taskResult.restart_state || null;
  const runningCommit = taskResult.running_commit || null;
  return {
    hasRestart: restartState === "verified" || taskResult.restart_verified_at != null,
    restartState,
    runningCommit,
  };
}

/**
 * Check whether a list of operational tools is exposed after restart.
 * Used by the safe restart verification to report missing tools.
 *
 * @param {string[]} availableTools - List of tool names from runtime status
 * @param {string[]} requiredTools  - List of expected operational tool names
 * @returns {{ allPresent: boolean, missingTools: string[], presentTools: string[] }}
 */
export function verifyToolExposure(availableTools, requiredTools) {
  if (!Array.isArray(availableTools)) {
    return { allPresent: false, missingTools: requiredTools || [], presentTools: [] };
  }
  const toolSet = new Set(availableTools);
  const present = (requiredTools || []).filter(t => toolSet.has(t));
  const missing = (requiredTools || []).filter(t => !toolSet.has(t));
  return {
    allPresent: missing.length === 0,
    missingTools: missing,
    presentTools: present,
  };
}
