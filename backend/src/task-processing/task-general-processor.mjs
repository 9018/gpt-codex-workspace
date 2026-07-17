import { runTaskProcessingPipeline } from "./task-processing-pipeline.mjs";

export { normalizeTuiEvidenceToTaskResult } from "./task-result-normalizer.mjs";

export async function processGeneralTask(store, config, task, context, github) {
  return runTaskProcessingPipeline(store, config, task, context, github, {});
}

export async function processGeneralTaskWithDeps(store, config, task, context, github, deps = {}) {
  return runTaskProcessingPipeline(store, config, task, context, github, deps);
}
