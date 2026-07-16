function base(decision, action, payload) {
  return {
    task_id: decision.task_id,
    goal_id: decision.goal_id || null,
    decision_revision: decision.revision ?? decision.decision_revision,
    action,
    payload,
  };
}

export function buildProgressionCommands(decision = {}) {
  if (!decision.task_id) throw new TypeError("decision.task_id is required");
  if (decision.revision === undefined && decision.decision_revision === undefined) {
    throw new TypeError("decision revision is required");
  }
  const commands = [];
  if (decision.requires_repair === true) {
    commands.push(base(decision, "create_repair_task", {
      parent_task_id: decision.task_id,
      blockers: decision.repairable_blockers || decision.blockers || [],
      repair_budget_revision: decision.repair_budget_revision ?? 0,
    }));
    return commands;
  }
  if (decision.integration_effect?.required === true && decision.integration_effect?.terminal !== true) {
    if (decision.integration?.source_commit && decision.integration?.target_branch) {
      commands.push(base(decision, "integrate_change", {
        task_id: decision.task_id,
        source_commit: decision.integration.source_commit,
        target_branch: decision.integration.target_branch,
      }));
    }
    return commands;
  }
  if (decision.status !== "completed") return commands;

  commands.push(base(decision, "complete_task", {
    task_id: decision.task_id,
    unified_decision: decision,
  }));
  if (decision.goal_id && decision.goal_effect?.complete_goal === true) {
    commands.push(base(decision, "propagate_goal", {
      task_id: decision.task_id,
      goal_id: decision.goal_id,
    }));
  }
  if (decision.safe_to_auto_advance === true && decision.queue_effect?.unblock_dependents === true) {
    commands.push(base(decision, "advance_queue", { task_id: decision.task_id }));
  }
  return commands;
}
