/**
 * execution-status-taxonomy.mjs — Execution status definitions.
 *
 * Execution status is separate from Task status.  An execution can be
 * "evidence_ready" while the associated task is still "collecting".
 *
 * @module execution-status-taxonomy
 */

/** All possible execution statuses */
export const EXECUTION_STATUSES = Object.freeze({
  CREATED: "created",
  PREPARING: "preparing",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  COLLECTING: "collecting",
  EVIDENCE_READY: "evidence_ready",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  LOST: "lost",
});

/** Terminal execution statuses */
export const TERMINAL_EXECUTION_STATUSES = Object.freeze(new Set([
  EXECUTION_STATUSES.EVIDENCE_READY,
  EXECUTION_STATUSES.COMPLETED,
  EXECUTION_STATUSES.FAILED,
  EXECUTION_STATUSES.CANCELLED,
  EXECUTION_STATUSES.TIMED_OUT,
  EXECUTION_STATUSES.LOST,
]));

/** Active (non-terminal) execution statuses */
export const ACTIVE_EXECUTION_STATUSES = Object.freeze(new Set([
  EXECUTION_STATUSES.CREATED,
  EXECUTION_STATUSES.PREPARING,
  EXECUTION_STATUSES.STARTING,
  EXECUTION_STATUSES.RUNNING,
  EXECUTION_STATUSES.STOPPING,
  EXECUTION_STATUSES.COLLECTING,
]));

/** Allowed execution status transitions */
const EXECUTION_TRANSITION_MAP = Object.freeze({
  [EXECUTION_STATUSES.CREATED]: [
    EXECUTION_STATUSES.PREPARING,
    EXECUTION_STATUSES.FAILED,
    EXECUTION_STATUSES.CANCELLED,
  ],
  [EXECUTION_STATUSES.PREPARING]: [
    EXECUTION_STATUSES.STARTING,
    EXECUTION_STATUSES.FAILED,
    EXECUTION_STATUSES.CANCELLED,
  ],
  [EXECUTION_STATUSES.STARTING]: [
    EXECUTION_STATUSES.RUNNING,
    EXECUTION_STATUSES.FAILED,
    EXECUTION_STATUSES.CANCELLED,
  ],
  [EXECUTION_STATUSES.RUNNING]: [
    EXECUTION_STATUSES.STOPPING,
    EXECUTION_STATUSES.COLLECTING,
    EXECUTION_STATUSES.FAILED,
    EXECUTION_STATUSES.CANCELLED,
    EXECUTION_STATUSES.LOST,
  ],
  [EXECUTION_STATUSES.STOPPING]: [
    EXECUTION_STATUSES.COLLECTING,
    EXECUTION_STATUSES.FAILED,
    EXECUTION_STATUSES.CANCELLED,
  ],
  [EXECUTION_STATUSES.COLLECTING]: [
    EXECUTION_STATUSES.EVIDENCE_READY,
    EXECUTION_STATUSES.FAILED,
  ],
  [EXECUTION_STATUSES.EVIDENCE_READY]: [EXECUTION_STATUSES.COMPLETED],
});

/**
 * Check whether an execution status is terminal.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalExecutionStatus(status) {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

/**
 * Check whether a transition from 'from' to 'to' is allowed.
 * @param {string} from - Current execution status
 * @param {string} to - Target execution status
 * @returns {boolean}
 */
export function canTransitionExecution(from, to) {
  const allowed = EXECUTION_TRANSITION_MAP[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
