/**
 * supervisor-plan-schema.mjs — SupervisorPlan schema.
 *
 * A SupervisorPlan captures the user's intent, architecture decisions,
 * execution steps, acceptance contract, TUI strategy, autonomy budget,
 * checkpoint policy, and takeover policy for a single ExecutionRun.
 *
 * The plan is referenced by run.supervisor_plan_id.  It is immutable
 * once created; any revision creates a new plan instance.
 *
 * @module supervisor-plan-schema
 */

import { randomUUID } from "node:crypto";

/** Allowed checkpoint trigger strategies. */
export const CHECKPOINT_TRIGGER_MODES = Object.freeze([
  "interval",       // Time-based (every N seconds)
  "idle_detected",  // TUI idle / no-progress
  "git_diff",       // Repository state changed
  "test_result",    // Test run completed
  "manual",         // Explicit trigger
  "no_progress",    // No meaningful output for N seconds
]);

/** Allowed takeover policies. */
export const TAKEOVER_POLICIES = Object.freeze([
  "automatic",      // Auto-takeover when correction budget exceeded
  "manual_only",    // Only manual (ChatGPT) takeover
  "never",          // No takeover allowed
]);

/**
 * Create a SupervisorPlan.
 *
 * @param {object} input
 * @param {string} [input.id] - Explicit plan ID
 * @param {string} input.run_id - Associated ExecutionRun ID
 * @param {string} [input.user_goal] - The original user goal text
 * @param {object[]} [input.execution_steps] - Ordered execution steps
 * @param {string} [input.acceptance_contract_ref] - Reference to acceptance contract
 * @param {object} [input.tui_strategy] - TUI strategy config
 * @param {object} [input.autonomy_budget] - Max autonomous actions
 * @param {object} [input.checkpoint_policy] - Checkpoint trigger config
 * @param {object} [input.takeover_policy] - Takeover policy config
 * @param {string} [input.created_at]
 * @returns {object} SupervisorPlan
 */
export function createSupervisorPlan(input = {}) {
  if (!input.run_id) throw new Error("run_id is required");

  return {
    schema_version: 1,
    id: input.id || `sp_${randomUUID()}`,
    run_id: input.run_id,
    user_goal: input.user_goal || "",
    architecture_decisions: Array.isArray(input.architecture_decisions)
      ? [...input.architecture_decisions]
      : [],
    execution_steps: Array.isArray(input.execution_steps)
      ? input.execution_steps.map((step, i) => ({
          order: step.order ?? i,
          description: step.description || "",
          action: step.action || null,
          expected_outcome: step.expected_outcome || null,
          verification: step.verification || null,
        }))
      : [],
    acceptance_contract_ref: input.acceptance_contract_ref || null,
    tui_strategy: {
      preferred_mode: input.tui_strategy?.preferred_mode || "automatic",
      autopilot_enabled: input.tui_strategy?.autopilot_enabled ?? true,
      max_autopilot_actions: input.tui_strategy?.max_autopilot_actions ?? 100,
      frame_stable_ms: input.tui_strategy?.frame_stable_ms ?? 500,
      no_progress_seconds: input.tui_strategy?.no_progress_seconds ?? 120,
    },
    autonomy_budget: {
      max_attempts: input.autonomy_budget?.max_attempts ?? 3,
      max_corrections: input.autonomy_budget?.max_corrections ?? 5,
      max_supervisor_rounds: input.autonomy_budget?.max_supervisor_rounds ?? 3,
      same_failure_retry_limit: input.autonomy_budget?.same_failure_retry_limit ?? 2,
    },
    checkpoint_policy: {
      triggers: Array.isArray(input.checkpoint_policy?.triggers)
        ? input.checkpoint_policy.triggers.filter((t) => CHECKPOINT_TRIGGER_MODES.includes(t))
        : ["no_progress"],
      interval_seconds: input.checkpoint_policy?.interval_seconds ?? 300,
      max_unattended_minutes: input.checkpoint_policy?.max_unattended_minutes ?? 60,
    },
    takeover_policy: {
      mode: TAKEOVER_POLICIES.includes(input.takeover_policy?.mode)
        ? input.takeover_policy.mode
        : "automatic",
      notify_on_correction_exceeded: input.takeover_policy?.notify_on_correction_exceeded ?? true,
      notify_on_timeout: input.takeover_policy?.notify_on_timeout ?? true,
    },
    created_at: input.created_at || new Date().toISOString(),
  };
}
