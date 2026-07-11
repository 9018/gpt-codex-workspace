/**
 * workstream-drift-detector.mjs — Detects workstream drift conditions
 * such as error phase/scope, stale progress, and terminal task/queue mismatch.
 *
 * Drift conditions detected:
 *   1. wrong_phase     — task phase doesn't match workstream phase
 *   2. wrong_scope     — task scope/area doesn't match workstream deliverable
 *   3. stale_progress  — progress hasn't changed for extended period
 *   4. terminal_queue_mismatch — terminal task but non-terminal workstream goal
 *
 * Idempotent: Same state always returns same drift detection results.
 * Deterministic: Pure computations, no side effects.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DRIFT_TYPE = Object.freeze({
  WRONG_PHASE: "wrong_phase",
  WRONG_SCOPE: "wrong_scope",
  STALE_PROGRESS: "stale_progress",
  TERMINAL_QUEUE_MISMATCH: "terminal_queue_mismatch",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isoNow() {
  return new Date().toISOString();
}

function hoursAgo(isoString, now = Date.now()) {
  if (!isoString) return Infinity;
  const ts = new Date(isoString).getTime();
  if (Number.isNaN(ts)) return Infinity;
  return (now - ts) / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Drift checks
// ---------------------------------------------------------------------------

/**
 * Check for wrong phase drift — when a task's phase value does not match
 * the expected workstream phase.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.workstream
 * @param {string} options.expectedPhase - The phase the task should be in
 * @returns {{ drifted: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectWrongPhaseDrift({ task = {}, workstream = {}, expectedPhase = "" } = {}) {
  if (!expectedPhase) {
    return { drifted: false, type: null, code: "no_expected_phase", message: "No expected phase provided.", detail: null };
  }
  const taskPhase = task.phase || task.execution_policy?.phase || "";
  if (!taskPhase) {
    return { drifted: true, type: DRIFT_TYPE.WRONG_PHASE, code: "task_phase_missing", message: "Task has no phase assigned.", detail: { task_id: task.id, expected_phase: expectedPhase, task_phase: null } };
  }
  if (taskPhase !== expectedPhase) {
    return { drifted: true, type: DRIFT_TYPE.WRONG_PHASE, code: "task_phase_mismatch", message: `Task phase "${taskPhase}" does not match expected phase "${expectedPhase}".`, detail: { task_id: task.id, expected_phase: expectedPhase, task_phase: taskPhase } };
  }
  return { drifted: false, type: null, code: "phase_matches", message: null, detail: null };
}

/**
 * Check for wrong scope drift — when task scope/area doesn't match the
 * workstream deliverable.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.workstream
 * @param {string[]} options.expectedScopes - Allowed scope values
 * @returns {{ drifted: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectWrongScopeDrift({ task = {}, workstream = {}, expectedScopes = [] } = {}) {
  if (expectedScopes.length === 0) {
    return { drifted: false, type: null, code: "no_scopes_defined", message: "No expected scopes defined.", detail: null };
  }
  const taskScope = task.scope || task.mode || task.execution_policy?.scope || "";
  if (!taskScope) {
    return { drifted: true, type: DRIFT_TYPE.WRONG_SCOPE, code: "task_scope_missing", message: "Task has no scope assigned.", detail: { task_id: task.id, task_scope: null, expected_scopes: expectedScopes } };
  }
  if (!expectedScopes.includes(taskScope)) {
    return { drifted: true, type: DRIFT_TYPE.WRONG_SCOPE, code: "task_scope_outside_expected", message: `Task scope "${taskScope}" is outside expected scopes: ${expectedScopes.join(", ")}.`, detail: { task_id: task.id, task_scope: taskScope, expected_scopes: expectedScopes } };
  }
  return { drifted: false, type: null, code: "scope_matches", message: null, detail: null };
}

/**
 * Check for stale progress — when progress has not changed for an extended period.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} [options.progress={}] - progress.json content
 * @param {number} [options.staleThresholdHours=2] - Hours without progress change before stale
 * @returns {{ drifted: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectStaleProgressDrift({ task = {}, progress = {}, staleThresholdHours = 2 } = {}) {
  const now = Date.now();
  const lastUpdate = progress.updated_at || task.updated_at || task.created_at || null;
  const hoursSinceUpdate = hoursAgo(lastUpdate, now);

  if (hoursSinceUpdate > staleThresholdHours && task.status !== "completed" && task.status !== "failed") {
    return {
      drifted: true,
      type: DRIFT_TYPE.STALE_PROGRESS,
      code: "stale_progress",
      message: `Progress has not been updated in ${hoursSinceUpdate.toFixed(1)} hours (threshold: ${staleThresholdHours}h).`,
      detail: {
        task_id: task.id,
        last_update_iso: lastUpdate,
        hours_since_update: Math.round(hoursSinceUpdate * 10) / 10,
        stale_threshold_hours: staleThresholdHours,
        current_status: task.status,
      },
    };
  }
  return { drifted: false, type: null, code: "progress_active", message: null, detail: null };
}

/**
 * Check for terminal task / non-terminal queue drift — when a terminal task
 * exists but the workstream goal or parent task is not terminal.
 *
 * @param {object} options
 * @param {object} options.task - The terminal task
 * @param {object} options.parentTask - The parent task or workstream goal
 * @returns {{ drifted: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectTerminalQueueMismatchDrift({ task = {}, parentTask = {} } = {}) {
  const terminalStatuses = new Set(["completed", "failed", "timed_out", "cancelled"]);
  const isTaskTerminal = terminalStatuses.has(task.status);
  const isParentTerminal = terminalStatuses.has(parentTask.status) || parentTask.status === "closed" || parentTask.status === "integrated";

  if (isTaskTerminal && !isParentTerminal) {
    return {
      drifted: true,
      type: DRIFT_TYPE.TERMINAL_QUEUE_MISMATCH,
      code: "terminal_task_non_terminal_parent",
      message: `Task "${task.id}" is terminal (${task.status}) but parent/workstream is not (${parentTask.status || "unknown"}).`,
      detail: {
        task_id: task.id,
        task_status: task.status,
        parent_id: parentTask.id || null,
        parent_status: parentTask.status || null,
      },
    };
  }
  return { drifted: false, type: null, code: "queue_consistent", message: null, detail: null };
}

// ---------------------------------------------------------------------------
// Composite drift check
// ---------------------------------------------------------------------------

/**
 * Run all drift checks and return composite result.
 *
 * @param {object} options
 * @param {object} [options.task={}]
 * @param {object} [options.workstream={}]
 * @param {object} [options.parentTask={}]
 * @param {object} [options.progress={}]
 * @param {string} [options.expectedPhase=""]
 * @param {string[]} [options.expectedScopes=[]]
 * @param {number} [options.staleThresholdHours=2]
 * @returns {{
 *   drifted: boolean,
 *   findings: object[],
 *   drift_count: number,
 *   idempotency_key: string
 * }}
 */
export function detectDrift({
  task = {},
  workstream = {},
  parentTask = {},
  progress = {},
  expectedPhase = "",
  expectedScopes = [],
  staleThresholdHours = 2,
} = {}) {
  const findings = [];

  const phaseCheck = detectWrongPhaseDrift({ task, workstream, expectedPhase });
  if (phaseCheck.drifted) findings.push({ ...phaseCheck, detail: phaseCheck.detail });

  const scopeCheck = detectWrongScopeDrift({ task, workstream, expectedScopes });
  if (scopeCheck.drifted) findings.push({ ...scopeCheck, detail: scopeCheck.detail });

  const progressCheck = detectStaleProgressDrift({ task, progress, staleThresholdHours });
  if (progressCheck.drifted) findings.push({ ...progressCheck, detail: progressCheck.detail });

  const queueCheck = detectTerminalQueueMismatchDrift({ task, parentTask });
  if (queueCheck.drifted) findings.push({ ...queueCheck, detail: queueCheck.detail });

  const codeParts = findings.map((f) => f.code).sort().join("|");
  const idempotencyKey = findings.length > 0 ? `drift:${codeParts}` : "drift:none";

  return {
    drifted: findings.length > 0,
    findings,
    drift_count: findings.length,
    idempotency_key: idempotencyKey,
    summary: findings.length > 0
      ? `${findings.length} drift condition(s) detected: ${findings.map((f) => f.code).join(", ")}.`
      : "No drift detected.",
  };
}

export default {
  detectDrift,
  detectWrongPhaseDrift,
  detectWrongScopeDrift,
  detectStaleProgressDrift,
  detectTerminalQueueMismatchDrift,
  DRIFT_TYPE,
};
