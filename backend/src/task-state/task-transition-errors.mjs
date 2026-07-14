/**
 * task-transition-errors.mjs — Stable error types and error codes
 * for the canonical task transition kernel.
 *
 * All transition errors share a common base:
 *   - code:      machine-readable error code string
 *   - message:   human-readable description
 *   - details:   optional additional metadata (expected, actual, etc.)
 *
 * @module task-transition-errors
 */

/**
 * Error codes used across the transition kernel.
 */
export const ERROR_CODES = Object.freeze({
  TASK_NOT_FOUND: "task_not_found",
  TASK_TRANSITION_INVALID: "task_transition_invalid",
  TASK_TRANSITION_CONFLICT: "task_transition_conflict",
  TASK_TRANSITION_IDEMPOTENCY_CONFLICT: "task_transition_idempotency_conflict",
  TASK_TRANSITION_MISSING_CANONICAL_DECISION: "task_transition_missing_canonical_decision",
  TASK_TRANSITION_NOT_ALLOWED: "task_transition_not_allowed",
  TASK_TRANSITION_STORE_ERROR: "task_transition_store_error",
});

/**
 * Base error class for all task transition errors.
 *
 * @param {string} code    — One of ERROR_CODES values
 * @param {string} message — Human-readable description
 * @param {object} [details={}] — Optional contextual metadata
 */
export class TaskTransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskTransitionError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Factory: create a "task not found" error.
 * @param {string} taskId
 * @returns {TaskTransitionError}
 */
export function taskNotFoundError(taskId) {
  return new TaskTransitionError(
    ERROR_CODES.TASK_NOT_FOUND,
    `Task not found: ${taskId}`,
    { task_id: taskId },
  );
}

/**
 * Factory: create a "transition not allowed" error.
 * @param {string} currentStatus
 * @param {string} event
 * @param {string} reason
 * @returns {TaskTransitionError}
 */
export function transitionNotAllowedError(currentStatus, event, reason) {
  return new TaskTransitionError(
    ERROR_CODES.TASK_TRANSITION_NOT_ALLOWED,
    `Transition not allowed: ${currentStatus} → ${event} (${reason})`,
    { current_status: currentStatus, event, reason },
  );
}

/**
 * Factory: create a "status conflict" error.
 * @param {string[]} expected
 * @param {string} actual
 * @returns {TaskTransitionError}
 */
export function statusConflictError(expected, actual) {
  return new TaskTransitionError(
    ERROR_CODES.TASK_TRANSITION_CONFLICT,
    `Expected task status to be one of [${expected.join(", ")}] but was "${actual}"`,
    { expected, actual },
  );
}

/**
 * Factory: create an "idempotency conflict" error.
 * @param {string} idempotencyKey
 * @returns {TaskTransitionError}
 */
export function idempotencyConflictError(idempotencyKey) {
  return new TaskTransitionError(
    ERROR_CODES.TASK_TRANSITION_IDEMPOTENCY_CONFLICT,
    `Idempotency key collision (different payload): ${idempotencyKey}`,
    { idempotency_key: idempotencyKey },
  );
}

/**
 * Factory: create a "missing canonical decision" error.
 * @param {object} options
 * @returns {TaskTransitionError}
 */
export function missingCanonicalDecisionError({ taskId, event } = {}) {
  return new TaskTransitionError(
    ERROR_CODES.TASK_TRANSITION_MISSING_CANONICAL_DECISION,
    `Event "${event}" for task "${taskId}" requires payload.unified_decision`,
    { task_id: taskId, event },
  );
}
