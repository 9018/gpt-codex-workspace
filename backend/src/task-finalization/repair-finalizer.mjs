import { classifyNoChangeRepairOutcome } from "../no-change-repair-classifier.mjs";
import { applyRepairMetadata, taskWithRepairContext } from "../task-processing/task-repair-context.mjs";

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

export async function finalizeAcceptanceRepairCreation({
  closureDecision,
  taskResult = {},
  task,
  goal,
  store,
  config = {},
  resolvedRepo,
  shouldAttemptRepairFn,
  createRepairGoalFromFindingsFn,
  createGoalFn,
} = {}) {
  if (closureDecision?.status !== "waiting_for_repair" || taskResult.repair_goal_id || taskResult.repair_task_id) {
    return { closureDecision, taskResult };
  }

  const repairableBlockers = Array.isArray(closureDecision.repairable_blockers) ? closureDecision.repairable_blockers : [];
  const repairCheck = await shouldAttemptRepairFn({
    task,
    tasks: store.state?.tasks || [],
    maxAttempts: config.maxRepairAttempts || task.max_attempts || 2,
  });

  if (repairableBlockers.length > 0 && repairCheck.should_repair) {
    const failureClass = repairableBlockers[0]?.code || "acceptance_blocker";
    const repairGoal = await createRepairGoalFromFindingsFn({
      task: taskWithRepairContext(task, resolvedRepo),
      goal,
      findings: repairableBlockers,
      repairProposals: repairableBlockers.map((finding) => ({
        title: `Repair ${finding.code || "acceptance blocker"}`,
        proposed_action: finding.message || closureDecision.reason || "Fix the blocking acceptance finding and rerun verification.",
      })),
    });
    try {
      const created = await createGoalFn(store, config, applyRepairMetadata({
        user_request: repairGoal.user_request,
        goal_prompt: repairGoal.goal_prompt,
        title: `Repair: ${task.title || task.id} (acceptance blocker)`,
        project_id: task.project_id || goal?.project_id || "default",
        workspace_id: repairGoal.workspace_id || task.workspace_id || goal?.workspace_id || "hosted-default",
        mode: repairGoal.mode || task.mode || "full",
        assign_to_codex: true,
        skip_created_notification: false,
        attempt: repairGoal.attempt,
        repair_of_attempt: repairGoal.repair_of_attempt,
      }, repairGoal));
      taskResult.repair_goal = repairGoal;
      taskResult.repair_attempt = repairGoal.repair_attempt;
      taskResult.attempt = repairGoal.attempt;
      taskResult.repair_of_attempt = repairGoal.repair_of_attempt;
      taskResult.repair_goal_id = created.goal?.id || null;
      taskResult.repair_task_id = created.task?.id || null;
      taskResult.failure_class = taskResult.failure_class || failureClass;
    } catch (err) {
      closureDecision.status = "requires_review";
      closureDecision.task_status = "waiting_for_review";
      closureDecision.reason = "acceptance_repair_creation_failed";
      taskResult.repair_denied_reason = "Acceptance repair task creation failed: " + (err?.message || String(err));
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push(taskResult.repair_denied_reason);
    }
  } else if (repairableBlockers.length > 0 && !repairCheck.should_repair) {
    closureDecision.status = "requires_review";
    closureDecision.task_status = "waiting_for_review";
    closureDecision.reason = "acceptance_repair_budget_exhausted";
    taskResult.repair_denied_reason = repairCheck.reason;
  }

  return { closureDecision, taskResult };
}
