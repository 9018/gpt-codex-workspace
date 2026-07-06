import {
  REVIEW_STATES,
  TYPED_REVIEW_STATES,
  isTypedReviewState,
  isMachineRepairableReviewState,
} from './task-review-status-taxonomy.mjs';

export const TASK_STATUSES = Object.freeze({
  ASSIGNED: 'assigned',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_LOCK: 'waiting_for_lock',
  WAITING_FOR_REVIEW: 'waiting_for_review',
  // Typed review/recovery states
  WAITING_FOR_HUMAN_REVIEW: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
  WAITING_FOR_MISSING_EVIDENCE_REPAIR: REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR,
  WAITING_FOR_INTEGRATION_RECOVERY: REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY,
  WAITING_FOR_RESULT_CONTRACT_REPAIR: REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR,
  WAITING_FOR_NOOP_EVIDENCE: REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE,
  WAITING_FOR_MANUAL_TERMINAL_DECISION: REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION,
  // --- P0-03: 6 canonical review state statuses ---
  WAITING_FOR_EVIDENCE_MISSING: REVIEW_STATES.WAITING_FOR_EVIDENCE_MISSING,
  WAITING_FOR_POLICY_UNCERTAIN: REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN,
  WAITING_FOR_INTEGRATION_UNCERTAIN: REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN,
  WAITING_FOR_REPAIR_BUDGET_EXHAUSTED: REVIEW_STATES.WAITING_FOR_REPAIR_BUDGET_EXHAUSTED,
  WAITING_FOR_PROVIDER_UNAVAILABLE: REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE,
  WAITING_FOR_HUMAN_REQUIRED: REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED,
  HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED: REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED,
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

/** Human review statuses: includes both legacy waiting_for_review and typed states. */
export const HUMAN_REVIEW_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
  ...Object.values(REVIEW_STATES),
]));

/** Human review statuses that exclude machine-repairable typed states. */
export const TRUE_HUMAN_REVIEW_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
  REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
  REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION,
  REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED,
  REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED,
  REVIEW_STATES.WAITING_FOR_REPAIR_BUDGET_EXHAUSTED,
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

export function isTrueHumanReviewStatus(status) {
  return TRUE_HUMAN_REVIEW_STATUSES.has(normalizeTaskStatus(status));
}

export function isTypedReviewStatus(status) {
  return isTypedReviewState(normalizeTaskStatus(status));
}

export function isMachineRepairableReviewStatus(status) {
  return isMachineRepairableReviewState(normalizeTaskStatus(status));
}

export function isRepairStatus(status) {
  return REPAIR_STATUSES.has(normalizeTaskStatus(status));
}

export function isReviewOrRepairStatus(status) {
  return isHumanReviewStatus(status) || isRepairStatus(status);
}

export function isNonTerminalWaitStatus(status, { includeTypedReview = true } = {}) {
  const normalized = normalizeTaskStatus(status);
  if (NON_TERMINAL_WAIT_STATUSES.has(normalized)) return true;
  if (includeTypedReview && isTypedReviewState(normalized)) return true;
  return false;
}

export { REVIEW_STATES, TYPED_REVIEW_STATES, isTypedReviewState, isMachineRepairableReviewState } from './task-review-status-taxonomy.mjs';
