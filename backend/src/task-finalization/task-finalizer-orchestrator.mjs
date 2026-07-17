import { applyVerifiedDeliveryResultRecovery } from "./finalization-proofs.mjs";
import { finalizeWaitingForIntegration } from "./integration-finalizer.mjs";

export async function runTaskFinalizerOrchestration({
  taskStatus,
  taskResult,
  summary,
  deliveryResultRecovery = null,
  task,
  goal,
  store,
  config,
  resolvedRepo,
  runIntegrationQueueFn,
  runAutoIntegrationCompletionFn,
  shouldAttemptRepairFn,
  createRepairGoalFromFindingsFn,
  createGoalFn,
} = {}) {
  const integrationFinalization = await finalizeWaitingForIntegration({
    taskStatus,
    taskResult,
    task,
    goal,
    store,
    config,
    resolvedRepo,
    runIntegrationQueueFn,
    runAutoIntegrationCompletionFn,
    shouldAttemptRepairFn,
    createRepairGoalFromFindingsFn,
    createGoalFn,
  });

  return applyVerifiedDeliveryResultRecovery({
    taskStatus: integrationFinalization.taskStatus,
    taskResult: integrationFinalization.taskResult,
    summary,
    deliveryResultRecovery,
  });
}
