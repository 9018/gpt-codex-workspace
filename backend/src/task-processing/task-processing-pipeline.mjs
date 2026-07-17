import { runTaskExecution } from "./task-execution-runner.mjs";

export function prepareTaskExecution(input) {
  return { stage: "prepared", ...input };
}

export async function dispatchAndRun(prepared) {
  const result = await runTaskExecution(
    prepared.store,
    prepared.config,
    prepared.task,
    prepared.context,
    prepared.github,
    prepared.deps,
  );
  return { ...prepared, stage: "executed", result };
}

export function collectAndNormalizeResult(execution) {
  return { ...execution, stage: "normalized" };
}

export function verifyDelivery(normalized) {
  return { ...normalized, stage: "verified" };
}

export function recoverOrRepair(verification) {
  return { ...verification, stage: "recovered" };
}

export function finalizeProcessing(outcome) {
  return outcome.result;
}

export async function runTaskProcessingPipeline(store, config, task, context, github, deps = {}) {
  const prepared = prepareTaskExecution({ store, config, task, context, github, deps });
  const execution = await dispatchAndRun(prepared);
  const normalized = collectAndNormalizeResult(execution);
  const verification = verifyDelivery(normalized);
  const outcome = recoverOrRepair(verification);
  return finalizeProcessing(outcome);
}
