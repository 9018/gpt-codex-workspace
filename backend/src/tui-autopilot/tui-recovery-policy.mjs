const RECOVERY_SEQUENCE = ["probe", "correct", "interrupt", "resume"];

export function decideTuiRecovery({ recoveryAttempt = 0 } = {}) {
  const type = RECOVERY_SEQUENCE[Number(recoveryAttempt)] || "checkpoint_supervisor";
  return { type, reason_code: type === "checkpoint_supervisor" ? "autopilot_recovery_budget_exhausted" : `no_progress_${type}` };
}
