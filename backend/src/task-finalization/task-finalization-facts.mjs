export function collectTaskFinalizationFacts({ task = {}, goal = null, taskStatus, taskResult = {}, config = {} } = {}) {
  const maxAttempts = Number.isInteger(task.max_attempts)
    ? task.max_attempts
    : Number.isInteger(task.maxAttempts)
      ? task.maxAttempts
      : Number.isInteger(config.maxRepairAttempts)
        ? config.maxRepairAttempts
        : 2;
  const attempt = Number.isInteger(task.attempt)
    ? task.attempt
    : Number.isInteger(taskResult.attempt)
      ? taskResult.attempt
      : Number.isInteger(taskResult.repair_attempt)
        ? taskResult.repair_attempt
        : 0;
  const integrationRequired = taskResult.needs_integration === true
    || goal?.acceptance_contract?.requirements?.requires_integration === true
    || goal?.acceptance_contract?.completion_policy?.requires_integration === true;
  return Object.freeze({
    current_status: taskStatus,
    previous_status: task.status || null,
    task,
    goal,
    codex_result: taskResult,
    verification: taskResult.verification || taskResult.final_verification || null,
    acceptance: taskResult.acceptance_gate || taskResult.acceptance || null,
    contract_verification: taskResult.contract_verification || taskResult.verification?.contract_verification || taskResult.final_verification?.contract_verification || null,
    integration: {
      ...(taskResult.integration || {}),
      required: integrationRequired || taskResult.integration?.required === true,
    },
    runtime_guard: taskResult.runtime_guard || taskResult.restart_guard || taskResult.runtime || null,
    repair_budget: {
      attempt,
      max_attempts: maxAttempts,
      attempts_remaining: Math.max(0, maxAttempts - attempt - 1),
    },
    queue_context: {
      auto_start: task.auto_start,
      goal_id: goal?.id || task.goal_id || null,
    },
  });
}

export const collectTaskFinalizerEvidence = collectTaskFinalizationFacts;
