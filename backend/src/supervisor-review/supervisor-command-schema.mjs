/**
 * supervisor-command-schema.mjs — SupervisorCommand schema.
 *
 * A SupervisorCommand is the durable, idempotent execution unit derived
 * from a SupervisorDecision. Commands are persisted in the CommandStore
 * and executed by the CommandExecutor under controller lease protection.
 *
 * @module supervisor-review/supervisor-command-schema
 */

import crypto from "node:crypto";

/** Allowed command states. */
export const COMMAND_STATES = Object.freeze([
  "pending",
  "claimed",
  "applying",
  "applied",
  "retryable_failed",
  "terminal_failed",
  "superseded",
]);

/**
 * Build a command payload from a decision.
 *
 * @param {object} decision - Normalized SupervisorDecision
 * @returns {object} Command payload
 */
function buildCommandPayload(decision) {
  switch (decision.action) {
    case "send_correction":
      return {
        objective: decision.correction.objective,
        observed_drift: decision.correction.observed_drift,
        required_changes: decision.correction.required_changes,
        forbidden_changes: decision.correction.forbidden_changes,
        allowed_files: decision.correction.allowed_files,
        required_commands: decision.correction.required_commands,
        completion_evidence: decision.correction.completion_evidence,
      };

    case "pause_codex":
      return { action: "pause_codex" };

    case "chatgpt_takeover":
      return {
        reason: decision.takeover.reason,
        expected_scope: decision.takeover.expected_scope,
        return_conditions: decision.takeover.return_conditions,
      };

    case "handoff_to_codex":
      return {
        action: "handoff_to_codex",
        handoff_receipt: decision.payload?.handoff_receipt || {},
      };

    case "resume_and_send_correction":
      return decision.correction ? {
        objective: decision.correction.objective,
        observed_drift: decision.correction.observed_drift,
        required_changes: decision.correction.required_changes,
        forbidden_changes: decision.correction.forbidden_changes,
        allowed_files: decision.correction.allowed_files,
        required_commands: decision.correction.required_commands,
        completion_evidence: decision.correction.completion_evidence,
      } : { action: "resume_and_send_correction" };

    case "wait":
      return { no_op: true };

    default:
      return { action: decision.action };
  }
}

/**
 * Create a SupervisorCommand from a SupervisorDecision and the current Run.
 *
 * @param {object} decision - Normalized SupervisorDecision
 * @param {object} run - Current ExecutionRun
 * @returns {object} SupervisorCommand
 */
export function commandFromDecision(decision, run) {
  const idempotencyKey = [
    run.id,
    decision.review_revision_id,
    decision.action,
  ].join(":");

  return {
    id: crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    run_id: run.id,
    decision_id: decision.id,
    review_revision_id: decision.review_revision_id,
    action: decision.action,
    payload: buildCommandPayload(decision),
    preconditions: {
      expected_run_version: run.version,
      expected_controller_owner: run.supervision?.controller_owner || "workmcp_autopilot",
      expected_worktree_path: run.workspace_ref?.worktree_path || null,
      expected_session_id: run.active_session_id || null,
      expected_native_session_id: run.native_session_id || null,
    },
    status: "pending",
    attempt: 0,
    claimed_by: null,
    claim_expires_at: null,
    result: null,
    failure: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
