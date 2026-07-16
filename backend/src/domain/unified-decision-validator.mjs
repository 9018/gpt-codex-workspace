import { integrationAllowsCompletion } from "./integration-semantics.mjs";
import { hasDecisionRevision, UNIFIED_DECISION_SCHEMA_VERSION } from "./unified-decision-schema.mjs";

export class UnifiedDecisionInvariantError extends Error {
  constructor(violations = [], decision = null) {
    super(`Unified decision invariant failed: ${violations.join(", ")}`);
    this.name = "UnifiedDecisionInvariantError";
    this.code = "unified_decision_invariant_failed";
    this.violations = [...violations];
    this.decision = decision;
  }
}

export function validateUnifiedDecision(decision) {
  const violations = [];
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { valid: false, violations: ["decision_not_object"] };
  }
  if (decision.schema_version !== UNIFIED_DECISION_SCHEMA_VERSION) violations.push("schema_version_invalid");
  if (typeof decision.task_id !== "string" || decision.task_id.length === 0) violations.push("task_id_missing");
  if (!hasDecisionRevision(decision.decision_revision)) violations.push("decision_revision_missing");
  if (!hasDecisionRevision(decision.evidence_revision)) violations.push("evidence_revision_missing");
  if (typeof decision.reason !== "string" && decision.reason !== null) violations.push("reason_type_invalid");
  if (!decision.effects || typeof decision.effects !== "object") violations.push("effects_missing");

  if (decision.status === "completed") {
    if (decision.facts?.verification?.passed !== true) violations.push("completed_without_verification");
    if (decision.facts?.acceptance?.passed !== true) violations.push("completed_without_acceptance");
    if (!integrationAllowsCompletion(decision.effects?.integration)) {
      violations.push("completed_without_terminal_integration");
    }
    if (decision.requires_review === true) violations.push("completed_requires_review");
    if (decision.requires_repair === true) violations.push("completed_requires_repair");
  }

  if (decision.safe_to_auto_advance === true
    && ((decision.blockers?.length || 0) > 0 || (decision.repairable_blockers?.length || 0) > 0)) {
    violations.push("auto_advance_with_blockers");
  }
  if (decision.effects?.queue?.unblock_dependents === true && decision.effects?.queue?.hold_queue === true) {
    violations.push("queue_effect_contradiction");
  }
  if (decision.effects?.task?.status && decision.effects.task.status !== decision.status) {
    violations.push("task_effect_status_mismatch");
  }
  if (decision.status === "completed" && decision.effects?.goal?.complete_goal !== true) {
    violations.push("completed_without_goal_projection");
  }

  return { valid: violations.length === 0, violations };
}

export function assertValidUnifiedDecision(decision) {
  const validation = validateUnifiedDecision(decision);
  if (!validation.valid) throw new UnifiedDecisionInvariantError(validation.violations, decision);
  return decision;
}
