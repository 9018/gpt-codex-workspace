import { applyTaskFinalStateDecision, decideTaskFinalState } from "../task-finalizer.mjs";

export function decideTaskFinalization(facts = {}) {
  return decideTaskFinalState(facts);
}

export { applyTaskFinalStateDecision, decideTaskFinalState };
