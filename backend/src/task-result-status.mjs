import { validateAutonomyResult, detectRuntimeCodeChanges } from "./codex-result-parser.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { execFileSync } from "node:child_process";

const ACTIVE_RESTART_MARKER_STATUSES = new Set(["pending", "scheduled", "restarted"]);

// ---------------------------------------------------------------------------
// Diagnosis codes for result contract validation (P0)
// ---------------------------------------------------------------------------

export const DIAGNOSIS_CODES = {
  TESTS_MISSING: "tests_missing",
  COMMIT_MISSING: "commit_missing",
  DIRTY_WORKTREE_AFTER_CODEX: "dirty_worktree_after_codex",
  STRUCTURED_RESULT_MISSING_FIELDS: "structured_result_missing_fields",
  SUMMARY_FIELD_CONFLICT: "summary_field_conflict",
};

const NON_BLOCKING_CONTRACT_CODES_BY_PROFILE = {
  tests_missing: new Set(["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop", "network_retry", "readonly_validation", "already_integrated", "diagnostic"]),
  changed_files_mismatch: new Set(["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop", "readonly_validation", "already_integrated", "diagnostic"]),
};

export function isNonBlockingResultContractCode(code, profile) {
  return NON_BLOCKING_CONTRACT_CODES_BY_PROFILE[code]?.has(profile) === true;
}

export function classifyResultContractFindings({ diagnosisCodes = [], profile = null } = {}) {
  const blockingCodes = [];
  const nonBlockingCodes = [];
  const findingSeverityForCode = {};
  for (const code of Array.isArray(diagnosisCodes) ? diagnosisCodes : []) {
    if (isNonBlockingResultContractCode(code, profile)) {
      nonBlockingCodes.push(code);
      findingSeverityForCode[code] = "followup";
    } else {
      blockingCodes.push(code);
      findingSeverityForCode[code] = "major";
    }
  }
  return {
    blocking_codes: blockingCodes,
    non_blocking_codes: nonBlockingCodes,
    finding_severity_for_code: findingSeverityForCode,
  };
}

/**
 * Validate a result JSON against the P0 contract.
 *
 * Checks:
 * 1. tests field MUST be non-null for non-noop completed results
 * 2. commit MUST be present when changed_files > 0
 * 3. Worktree MUST be clean after completed execution
 * 4. summary must not conflict with structured fields
 *
 * @param {object} result - Parsed result object
 * @param {object} [options]
 * @param {string} [options.repoPath] - Path to git repo for worktree dirty check
 * @param {boolean} [options.skipWorktreeCheck=false] - Skip git worktree check
 * @returns {{ valid: boolean, diagnosis_codes: string[], warnings: string[] }}
 */
export function validateResultContract(result, options = {}) {
  const diagnosis_codes = [];
  const warnings = [];

  if (!result || typeof result !== "object") {
    return { valid: false, diagnosis_codes: [DIAGNOSIS_CODES.STRUCTURED_RESULT_MISSING_FIELDS], warnings: ["Result is null or not an object"] };
  }

  const isCompleted = result.status === "completed";
  const isNoop = result.noop === true || result.kind === "noop" || ["noop", "readonly_validation", "already_integrated", "diagnostic"].includes(result.operation_kind);
  const hasChangedFiles = Array.isArray(result.changed_files) && result.changed_files.length > 0;
  const hasCommit = result.commit && result.commit !== "none";
  const hasTests = result.tests && result.tests !== "none" && result.tests !== null;
  const hasSummary = typeof result.summary === "string" && result.summary.length > 0;

  // 1. tests field MUST be non-null for non-noop completed results
  if (isCompleted && !isNoop && !hasTests) {
    diagnosis_codes.push(DIAGNOSIS_CODES.TESTS_MISSING);
    warnings.push("tests is missing for a non-noop completed result");
  }

  // 2. commit must be present when changed_files > 0
  if (isCompleted && hasChangedFiles && !hasCommit) {
    diagnosis_codes.push(DIAGNOSIS_CODES.COMMIT_MISSING);
    warnings.push("commit is missing but changed_files has entries");
  }

  // 3. check worktree is not dirty (skip for noop results — no changes were made)
  if (isCompleted && !isNoop && !options.skipWorktreeCheck) {
    const repoPath = options.repoPath || process.cwd();
    try {
      const stdout = execFileSync("git", ["status", "--porcelain"], {
        cwd: repoPath,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      });
      const dirtyFiles = stdout.trim().split("\n").filter(Boolean);
      if (dirtyFiles.length > 0) {
        diagnosis_codes.push(DIAGNOSIS_CODES.DIRTY_WORKTREE_AFTER_CODEX);
        warnings.push(`worktree has ${dirtyFiles.length} dirty file(s): ${dirtyFiles.slice(0, 5).join(", ")}`);
      }
    } catch {
      // Not a git repo or git not available — skip check non-blocking
    }
  }

  // 4. summary field conflicts: says task completed but no evidence
  if (hasSummary && !isNoop && !hasChangedFiles && !hasCommit && !hasTests) {
    diagnosis_codes.push(DIAGNOSIS_CODES.SUMMARY_FIELD_CONFLICT);
    warnings.push("summary says task completed but no changed_files, commit, or tests evidence");
  }

  return { valid: diagnosis_codes.length === 0, diagnosis_codes, warnings };
}

export function deriveTaskStatusFromTaskResult(taskResult) {
  if (taskResult?.kind === "codex_executed") return "completed";
  if (taskResult?.kind === "codex_timeout" || taskResult?.kind === "no_first_output_timeout") return "timed_out";
  // P0: non-mutating operations are normal completion paths, not review triggers
  if (taskResult?.kind === "noop") return "completed";
  if (["readonly_validation", "already_integrated"].includes(taskResult?.operation_kind)) return "completed";
  return "failed";
}

/** Append a warning to taskResult.warnings array. */
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
 * restart, evidence-less results still require review; results that already
 * contain commit/test/verification evidence continue through acceptance,
 * integration, and final writeback with structured restart-required metadata.
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

  const hasCompletionEvidence = Boolean(
    taskResult.commit || parsedResult.commit
      || taskResult.tests || parsedResult.tests
      || taskResult.verification?.passed === true
      || parsedResult.verification?.passed === true
  );
  if (!hasCompletionEvidence) return "waiting_for_review";

  taskResult.restart_required = true;
  taskResult.requires_restart_check = true;
  taskResult.restart_state = taskResult.restart_state || "missing_safe_restart_marker";
  taskResult.runtime_restart_guard = {
    status: "restart_required",
    requires_review: false,
    matched_files: runtimeCheck.matchedFiles,
    reason: "runtime_code_changed_without_safe_restart",
  };
  return taskStatus;
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
