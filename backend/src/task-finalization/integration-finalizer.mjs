import {
  applyFailedAutoIntegrationCompletion,
  applySuccessfulAutoIntegrationCompletion,
  classifyIntegrationQueueResult,
} from "../auto-integration-completion.mjs";

export function classifyFinalizationIntegrationResult(integrationResult = {}) {
  return classifyIntegrationQueueResult(integrationResult);
}

export function applySuccessfulIntegrationCompletion({ taskResult = {}, integrationResult = {}, autoCompletion = {} } = {}) {
  return applySuccessfulAutoIntegrationCompletion({ taskResult, integrationResult, autoCompletion });
}

export function applyFailedIntegrationCompletion({ taskResult = {}, autoCompletion = {} } = {}) {
  return applyFailedAutoIntegrationCompletion({ taskResult, autoCompletion });
}
