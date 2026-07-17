/**
 * acceptance-decision-schema.mjs — AcceptanceDecision schema.
 *
 * An AcceptanceDecision is the single authoritative judgment about whether
 * the evidence gathered during an ExecutionRun satisfies the requirements
 * for the operation kind.  Only this module decides "accepted" vs
 * "repair_required" vs "rejected".
 *
 * @module acceptance-decision-schema
 */

import { randomUUID } from "node:crypto";

/** Allowed decision outcomes. */
export const ACCEPTANCE_DECISIONS = Object.freeze([
  "accepted",
  "repair_required",
  "review_required",
  "rejected",
]);

const DECISION_SET = new Set(ACCEPTANCE_DECISIONS);

/**
 * Create an acceptance decision.
 *
 * @param {object} input
 * @returns {object} AcceptanceDecision
 */
export function createAcceptanceDecision(input = {}) {
  if (!input.run_id) throw new Error("run_id is required");
  if (!DECISION_SET.has(input.decision)) {
    throw new Error(`decision must be one of: ${ACCEPTANCE_DECISIONS.join(", ")}`);
  }

  return {
    id: input.id || `decision_${randomUUID()}`,
    run_id: input.run_id,
    evidence_bundle_id: input.evidence_bundle_id || null,
    decision: input.decision,
    summary: input.summary || "",
    missing_items: Array.isArray(input.missing_items) ? [...input.missing_items] : [],
    rejected_claims: Array.isArray(input.rejected_claims) ? [...input.rejected_claims] : [],
    review_scope: input.review_scope || null,
    created_at: input.created_at || new Date().toISOString(),
  };
}

/**
 * Evaluate whether evidence satisfies requirements for the given operation.
 *
 * @param {object} options
 * @param {string} options.operationKind
 * @param {object} options.evidenceBundle
 * @returns {object} { decision, missing_items, rejected_claims }
 */
export function evaluateEvidence({ operationKind, evidenceBundle } = {}) {
  const missing = [];
  const rejected = [];

  if (!evidenceBundle) {
    return { decision: "rejected", missing_items: ["evidence_bundle"], rejected_claims: [] };
  }

  // Check operation-specific requirements
  switch (operationKind) {
    case "code_change":
      if (!evidenceBundle.repository?.commit_sha) missing.push("commit_sha");
      if (!evidenceBundle.repository?.changed_files?.length) missing.push("changed_files");
      break;
    case "docs_change":
      if (!evidenceBundle.repository?.commit_sha) missing.push("commit_sha");
      break;
    case "test_only":
      // No commit required, but must have test commands
      if (!evidenceBundle.commands?.length) missing.push("test_commands");
      break;
    case "question":
      // No commit, no commands required, but must have no mutation
      break;
    default:
      break;
  }

  // Reject unverifiable claims
  if (evidenceBundle.rejected_claims?.length) {
    rejected.push(...evidenceBundle.rejected_claims);
  }

  // Check for unverifiable provider claims that should have been reconciled
  if (evidenceBundle.provider_claims?.length) {
    missing.push("unreconciled_claims");
  }

  if (missing.length > 0 || rejected.length > 0) {
    return { decision: "repair_required", missing_items: missing, rejected_claims: rejected };
  }

  return { decision: "accepted", missing_items: [], rejected_claims: [] };
}
