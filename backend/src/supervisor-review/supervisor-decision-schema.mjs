/**
 * supervisor-decision-schema.mjs — SupervisorDecision normalization.
 *
 * A SupervisorDecision is the structured output of ChatGPT's semantic
 * review. It captures the verdict, action, and supporting evidence.
 * Decisions are immutable once recorded.
 *
 * @module supervisor-review/supervisor-decision-schema
 */

import crypto from "node:crypto";

/** Allowed decision actions. */
export const DECISION_ACTIONS = Object.freeze([
  "continue_codex",
  "send_correction",
  "pause_codex",
  "chatgpt_takeover",
  "handoff_to_codex",
  "resume_and_send_correction",
  "wait",
  "evaluate_terminal",
  "start_repair_cycle",
]);

/** Allowed verdict labels. */
export const DECISION_VERDICTS = Object.freeze([
  "aligned",
  "minor_drift",
  "major_drift",
  "blocked",
  "terminal",
]);

/**
 * Normalize and validate a raw decision input.
 *
 * @param {object} input - Raw decision from ChatGPT
 * @param {string} input.review_revision_id - Required: revision this decision applies to
 * @param {string} input.run_id - Run ID
 * @param {string} input.action - One of DECISION_ACTIONS
 * @param {string} input.verdict - One of DECISION_VERDICTS
 * @param {string} [input.confidence] - confidence level
 * @param {object} [input.correction] - Correction payload (required if action=send_correction)
 * @param {object} [input.takeover] - Takeover payload (required if action=chatgpt_takeover)
 * @returns {object} Normalized SupervisorDecision
 * @throws {Error} If validation fails
 */
export function normalizeSupervisorDecision(input = {}) {
  if (!input.review_revision_id) {
    throw new Error("review_revision_id is required");
  }
  if (!DECISION_ACTIONS.includes(input.action)) {
    throw new Error(`invalid action: ${input.action}`);
  }

  // Validate action-specific requirements
  if (input.action === "send_correction") {
    if (!input.correction?.objective) {
      throw new Error("send_correction requires correction.objective");
    }
    if (!input.correction?.required_changes?.length) {
      throw new Error("send_correction requires at least one required_change");
    }
  }

  if (input.action === "chatgpt_takeover") {
    if (!input.takeover?.reason) {
      throw new Error("chatgpt_takeover requires takeover.reason");
    }
  }

  return {
    schema_version: 1,
    id: input.id || crypto.randomUUID(),
    run_id: input.run_id || null,
    review_revision_id: input.review_revision_id,
    verdict: input.verdict || null,
    action: input.action,
    confidence: input.confidence || "medium",
    reason_codes: input.reason_codes || [],
    analysis_summary: input.analysis_summary || "",

    correction: input.action === "send_correction"
      ? {
          objective: input.correction.objective,
          observed_drift: input.correction.observed_drift || [],
          required_changes: input.correction.required_changes,
          forbidden_changes: input.correction.forbidden_changes || [],
          allowed_files: input.correction.allowed_files || [],
          required_commands: input.correction.required_commands || [],
          completion_evidence: input.correction.completion_evidence || [],
        }
      : null,

    takeover: input.action === "chatgpt_takeover"
      ? {
          reason: input.takeover.reason,
          expected_scope: input.takeover.expected_scope || [],
          return_conditions: input.takeover.return_conditions || [],
        }
      : null,

    decided_by: "chatgpt",
    decided_at: new Date().toISOString(),
  };
}
