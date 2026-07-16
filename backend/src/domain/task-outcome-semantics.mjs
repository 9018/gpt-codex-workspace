import { acceptanceAllowsCompletion } from "./acceptance-semantics.mjs";
import { integrationAllowsCompletion } from "./integration-semantics.mjs";

export function taskOutcomeAllowsCompletion(facts = {}) {
  return acceptanceAllowsCompletion(facts) && integrationAllowsCompletion(facts.integration);
}
