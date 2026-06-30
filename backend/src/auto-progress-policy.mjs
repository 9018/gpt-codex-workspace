export const CLOSURE_STATUSES = Object.freeze({
  AUTO_COMPLETED_CLEAN: "auto_completed_clean",
  AUTO_COMPLETED_WITH_FOLLOWUPS: "auto_completed_with_followups",
  WAITING_FOR_REPAIR: "waiting_for_repair",
  REQUIRES_REVIEW: "requires_review",
  FAILED: "failed",
});

export function mapClosureStatusToTaskStatus(status, config = {}) {
  if (status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN) return "completed";
  if (status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS) return "completed";
  if (status === CLOSURE_STATUSES.WAITING_FOR_REPAIR) return config.waitingForRepairTaskStatus || "waiting_for_repair";
  if (status === CLOSURE_STATUSES.REQUIRES_REVIEW) return "waiting_for_review";
  if (status === CLOSURE_STATUSES.FAILED) return "failed";
  return "waiting_for_review";
}

export function closureAllowsAutoComplete(status) {
  return status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN
    || status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
}

