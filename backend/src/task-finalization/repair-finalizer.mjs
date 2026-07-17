import { classifyNoChangeRepairOutcome } from "../no-change-repair-classifier.mjs";

export function applyNoChangeRepairCompletionSummary({ task = {}, taskResult = {} } = {}) {
  const classification = classifyNoChangeRepairOutcome({ task, taskResult });
  if (!classification.is_no_change_repair) return taskResult;
  return {
    ...taskResult,
    no_change_repair_completion: classification,
    no_change_repair_completion_summary: {
      kind: classification.kind,
      completion_eligible: classification.completion_eligible,
      reason: classification.reason,
      changed_files_empty_acceptable: classification.completion_eligible === true,
      explanation: classification.completion_eligible === true
        ? "changed_files=[] is acceptable for this repair because existing canonical state already satisfies the target, verification passed, acceptance passed, no unresolved blocker remains, and integration is not required or already satisfied."
        : "changed_files=[] remains blocked until repair/noop, target-state, verification, acceptance, blocker, and integration evidence are all present.",
      evidence: classification.evidence,
      blockers: classification.blockers,
    },
  };
}
