import { assertValidUnifiedDecision } from "../domain/unified-decision-validator.mjs";

export function assertValidInputUnifiedDecision(taskResult = {}) {
  const unifiedDecision = taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision;
  if (!unifiedDecision || typeof unifiedDecision !== "object") return;
  assertValidUnifiedDecision(unifiedDecision);
}
