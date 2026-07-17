/**
 * execution-run-schema.mjs — ExecutionRun data schema.
 *
 * An ExecutionRun represents the lifecycle of a single attempt to fulfill
 * an ExecutionIntent.  It is the "one source of truth" for execution state:
 * the Run transitions through a well-defined state machine, and other
 * systems (Task, Goal, Workstream) only project from it.
 *
 * @module execution-run-schema
 */

import { randomUUID } from "node:crypto";

/** All possible states of an ExecutionRun. */
export const EXECUTION_RUN_STATES = Object.freeze([
  "created",
  "planning",
  "ready",
  "running",
  "collecting",
  "evaluating",
  "waiting_for_repair",
  "checkpointing",
  "correcting",
  "resuming",
  "waiting_for_review",
  "waiting_for_supervisor",
  "waiting_for_supervisor_direct",
  "chatgpt_direct",
  "waiting_for_integration",
  "completed",
  "failed",
  "cancelled",
]);

/** States in which the Run is still making progress (non-terminal, non-paused). */
export const ACTIVE_RUN_STATES = new Set([
  "created",
  "planning",
  "ready",
  "running",
  "collecting",
  "evaluating",
  "correcting",
  "resuming",
]);

/** States in which the Run is paused, waiting for external action. */
export const WAITING_RUN_STATES = new Set([
  "waiting_for_repair",
  "checkpointing",
  "waiting_for_review",
  "waiting_for_supervisor",
  "waiting_for_supervisor_direct",
  "chatgpt_direct",
  "waiting_for_integration",
]);

/** Terminal states — once reached, a Run cannot transition further. */
export const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const now = () => new Date().toISOString();

/**
 * Create a new ExecutionRun with default values.
 *
 * @param {object} input
 * @param {string} [input.id] - Explicit run ID (auto-generated if omitted)
 * @param {string} input.intent_id - Required: link to the ExecutionIntent
 * @param {string} [input.goal_id]
 * @param {string} [input.task_id]
 * @param {string} [input.workstream_id]
 * @param {string} [input.plan_id]
 * @param {string} [input.acceptance_contract_id]
 * @param {string} [input.created_at] - Override default (used by store for determinism)
 * @param {string} [input.updated_at] - Override default (used by store for determinism)
 * @returns {object} A new ExecutionRun in "created" state
 */
export function createExecutionRun(input = {}) {
  if (!input.intent_id) {
    throw new Error("intent_id is required");
  }

  return {
    id: input.id || `run_${randomUUID()}`,
    intent_id: input.intent_id,
    request_id: input.request_id || null,
    idempotency_key: input.idempotency_key || null,
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    workstream_id: input.workstream_id || null,
    plan_id: input.plan_id || null,
    supervisor_plan_id: input.supervisor_plan_id || null,
    acceptance_contract_id: input.acceptance_contract_id || null,
    state: "created",
    outcome: null,
    active_attempt_id: null,
    attempt_ids: [],
    workspace_ref: null,
    context_ref: null,
    evidence_bundle_id: null,
    acceptance_decision_id: null,
    delivery_id: null,
    supervision: {
      controller_owner: "workmcp_autopilot",
      execution_mode: "native_tui",
      correction_cycles: 0,
      same_failure_retries: 0,
      native_resume_count: 0,
      chatgpt_takeover_count: 0,
      last_failure_signature: null,
      waiting_reason: null,
      takeover_reason: null,
      last_instruction_digest: null,
    },
    failure: null,
    active_checkpoint_id: null,
    checkpoint_ids: [],
    pending_effects: [],
    applied_mutation_keys: [],
    version: 1,
    created_at: input.created_at || now(),
    updated_at: input.updated_at || now(),
  };
}
