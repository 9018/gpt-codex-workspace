/**
 * supervisor-checkpoint-schema.mjs — SupervisorCheckpoint schema.
 *
 * A checkpoint captures a point-in-time snapshot of an ExecutionRun's
 * state for later analysis, correction, or takeover.  Checkpoints are
 * referenced by run.checkpoint_ids and run.active_checkpoint_id.
 *
 * @module supervisor-checkpoint-schema
 */

import { randomUUID } from "node:crypto";

/** Allowed checkpoint actions (next step after checkpoint evaluation). */
export const CHECKPOINT_ACTIONS = Object.freeze([
  "continue_codex",           // Keep Codex working (no action needed)
  "send_correction",          // Send a correction to the running TUI
  "run_deterministic_repair", // Run a deterministic repair script
  "resume_native_session",    // Resume via native session ID
  "chatgpt_takeover",         // Request ChatGPT takeover
  "wait_for_chatgpt",         // Wait for ChatGPT to respond
  "evaluate_terminal",        // Evaluate whether the run has terminated
]);

/** Allowed checkpoint verdict types. */
export const CHECKPOINT_VERDICTS = Object.freeze([
  "accepted",      // Evidence accepted, continue
  "repair_needed", // Minor repair needed
  "review_needed", // Needs human review
  "takeover",      // Needs ChatGPT takeover
  "terminal",      // Run is terminal, evaluate
]);

/** Allowed checkpoint trigger sources. */
export const CHECKPOINT_TRIGGER_SOURCES = Object.freeze([
  "tui_idle",
  "git_diff",
  "test_completed",
  "no_progress",
  "interval",
  "manual",
  "startup",
  "evidence_ready",
]);

/**
 * Create a SupervisorCheckpoint.
 *
 * @param {object} input
 * @param {string} [input.id] - Explicit checkpoint ID
 * @param {string} input.run_id - Associated ExecutionRun ID
 * @param {number} [input.run_version] - Run version when checkpoint was taken
 * @param {string} input.trigger_source - Trigger source
 * @param {object} [input.evidence_snapshot] - Evidence at checkpoint time
 * @param {string} [input.verdict] - Evaluation verdict
 * @param {string} [input.action] - Determined action
 * @param {string} [input.takeover_by] - Who took over (null if not taken over)
 * @param {string} [input.takeover_reason] - Why takeover was triggered
 * @param {object} [input.context] - Additional context data
 * @param {string} [input.created_at]
 * @returns {object} SupervisorCheckpoint
 */
export function createSupervisorCheckpoint(input = {}) {
  if (!input.run_id) throw new Error("run_id is required");

  const triggerSource = CHECKPOINT_TRIGGER_SOURCES.includes(input.trigger_source)
    ? input.trigger_source
    : "manual";

  const verdict = CHECKPOINT_VERDICTS.includes(input.verdict)
    ? input.verdict
    : null;

  const action = CHECKPOINT_ACTIONS.includes(input.action)
    ? input.action
    : null;

  return {
    schema_version: 1,
    id: input.id || `cp_${randomUUID()}`,
    run_id: input.run_id,
    run_version: input.run_version ?? 1,
    trigger_source: triggerSource,
    evidence_snapshot: input.evidence_snapshot
      ? structuredClone(input.evidence_snapshot)
      : null,
    verdict,
    action,
    takeover_by: input.takeover_by || null,
    takeover_reason: input.takeover_reason || null,
    context: input.context ? structuredClone(input.context) : {},
    created_at: input.created_at || new Date().toISOString(),
  };
}
