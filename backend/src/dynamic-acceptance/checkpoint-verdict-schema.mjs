/**
 * checkpoint-verdict-schema.mjs — Checkpoint Verdict schema.
 *
 * A verdict determines what action to take after evaluating a checkpoint.
 * Verdicts only decide the next action — they never directly write
 * "completed" on the run.
 *
 * @module checkpoint-verdict-schema
 */

/** Allowed verdict types. */
export const CHECKPOINT_VERDICT_TYPES = Object.freeze([
  "continue_codex",           // Keep going, no issues
  "send_correction",          // Minor correction needed
  "run_deterministic_repair", // Run a deterministic fix
  "resume_native_session",    // Resume via native Codex session
  "chatgpt_takeover",         // Escalate to ChatGPT
  "wait_for_chatgpt",         // Wait for ChatGPT response
  "evaluate_terminal",        // Check if the run reached a terminal state
  "start_repair_cycle",  // Goal completed with remaining work – create repair + new cycle
]);

/** Allowed trigger sources matching the policy. */
export const CHECKPOINT_TRIGGER_SOURCES = Object.freeze([
  "tui_idle",
  "git_diff",
  "test_completed",
  "no_progress",
  "interval",
  "manual",
]);

/**
 * Create a checkpoint verdict.
 *
 * @param {object} input
 * @param {string} input.checkpoint_id - Source checkpoint ID
 * @param {string} input.trigger_source - What triggered the checkpoint
 * @param {string} input.verdict - One of CHECKPOINT_VERDICT_TYPES
 * @param {string} [input.reason] - Why this verdict was chosen
 * @param {object} [input.evidence_snapshot] - Evidence at evaluation time
 * @param {object} [input.correction] - Correction details if applicable
 * @param {string} [input.created_at]
 * @returns {object}
 */
export function createCheckpointVerdict(input = {}) {
  if (!input.checkpoint_id) throw new Error("checkpoint_id is required");
  if (!CHECKPOINT_VERDICT_TYPES.includes(input.verdict)) {
    throw new Error(`Invalid verdict: ${input.verdict}. Must be one of: ${CHECKPOINT_VERDICT_TYPES.join(", ")}`);
  }

  return {
    schema_version: 1,
    id: input.id || `verdict_${input.checkpoint_id}`,
    checkpoint_id: input.checkpoint_id,
    run_id: input.run_id || null,
    trigger_source: CHECKPOINT_TRIGGER_SOURCES.includes(input.trigger_source)
      ? input.trigger_source
      : "manual",
    verdict: input.verdict,
    reason: input.reason || "",
    evidence_snapshot: input.evidence_snapshot ? structuredClone(input.evidence_snapshot) : null,
    correction: input.correction ? structuredClone(input.correction) : null,
    created_at: input.created_at || new Date().toISOString(),
  };
}
