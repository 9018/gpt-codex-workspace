export const TASK_STATUSES = Object.freeze({
  ASSIGNED: 'assigned',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_LOCK: 'waiting_for_lock',
  WAITING_FOR_REVIEW: 'waiting_for_review',
  WAITING_FOR_REPAIR: 'waiting_for_repair',
  WAITING_FOR_INTEGRATION: 'waiting_for_integration',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
});

export const ACTIVE_EXECUTION_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.QUEUED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
]));

export const HUMAN_REVIEW_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
]));

export const REPAIR_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_REPAIR,
]));

export const TERMINAL_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.TIMED_OUT,
  TASK_STATUSES.BLOCKED,
  TASK_STATUSES.CANCELLED,
]));

export const FAILED_TERMINAL_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.FAILED,
  TASK_STATUSES.TIMED_OUT,
  TASK_STATUSES.BLOCKED,
  TASK_STATUSES.CANCELLED,
]));

export const NON_TERMINAL_WAIT_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
]));

const KNOWN_TASK_STATUSES = Object.freeze(new Set(Object.values(TASK_STATUSES)));

export function normalizeTaskStatus(status) {
  if (typeof status !== 'string') return '';
  return status.trim().toLowerCase();
}

export function isKnownTaskStatus(status) {
  return KNOWN_TASK_STATUSES.has(normalizeTaskStatus(status));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeTaskStatus(status));
}

export function isCompletedStatus(status) {
  return normalizeTaskStatus(status) === TASK_STATUSES.COMPLETED;
}

export function isFailedTerminalStatus(status) {
  return FAILED_TERMINAL_STATUSES.has(normalizeTaskStatus(status));
}

export function isActiveExecutionStatus(status) {
  return ACTIVE_EXECUTION_STATUSES.has(normalizeTaskStatus(status));
}

export function isHumanReviewStatus(status) {
  return HUMAN_REVIEW_STATUSES.has(normalizeTaskStatus(status));
}

export function isRepairStatus(status) {
  return REPAIR_STATUSES.has(normalizeTaskStatus(status));
}

export function isReviewOrRepairStatus(status) {
  return isHumanReviewStatus(status) || isRepairStatus(status);
}

export function isNonTerminalWaitStatus(status) {
  return NON_TERMINAL_WAIT_STATUSES.has(normalizeTaskStatus(status));
}
