import { REVIEW_STATES, TYPED_REVIEW_STATES } from '../task-review-status-taxonomy.mjs';

export const CLOSURE_STATUSES = Object.freeze({
  AUTO_COMPLETED_CLEAN: "auto_completed_clean",
  AUTO_COMPLETED_WITH_FOLLOWUPS: "auto_completed_with_followups",
  WAITING_FOR_REPAIR: "waiting_for_repair",
  REQUIRES_REVIEW: "requires_review",
  FAILED: "failed",
  WAITING_FOR_HUMAN_REVIEW: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
  HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED: REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED,
});
export function mapClosureStatusToTaskStatus(status, config = {}) {
  if (status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN) return "completed";
  if (status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS) return "completed";
  if (status === CLOSURE_STATUSES.WAITING_FOR_REPAIR) return config.waitingForRepairTaskStatus || "waiting_for_repair";
  if (status === CLOSURE_STATUSES.REQUIRES_REVIEW) return config.waitingForReviewTaskStatus || "waiting_for_review";
  if (status === CLOSURE_STATUSES.WAITING_FOR_HUMAN_REVIEW) return config.waitingForHumanReviewTaskStatus || REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW;
  if (status === CLOSURE_STATUSES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED) return config.humanInterruptedForRepairBudgetExhaustedTaskStatus || REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED;
  if (status === CLOSURE_STATUSES.FAILED) return "failed";
  return config.defaultFallbackTaskStatus || "waiting_for_review";
}
export function closureAllowsAutoComplete(status) {
  return status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN
    || status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
}

