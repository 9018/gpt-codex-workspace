/**
 * execution-contract.mjs — Execution request validation and normalization.
 *
 * Defines the contract that both codex_exec and codex_tui providers must
 * satisfy when requesting an execution.  This is the shared protocol
 * between the Execution Runtime and all providers.
 *
 * @module execution-contract
 */

import { randomUUID } from "node:crypto";

/** Known execution providers */
export const EXECUTION_PROVIDERS = Object.freeze(["codex_exec", "codex_tui"]);

/** Known interaction modes */
export const INTERACTION_MODES = Object.freeze(["batch", "interactive"]);

/** Maximum allowed timeout (24 hours) */
export const MAX_TIMEOUT_MS = 86_400_000;

/** Default timeout (2 hours) */
export const DEFAULT_TIMEOUT_MS = 7_200_000;

/**
 * Validate an execution request object.
 *
 * @param {object} input - Raw request input
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExecutionRequest(input) {
  const errors = [];

  if (!input || typeof input !== "object") {
    return { valid: false, errors: ["input must be a non-null object"] };
  }

  if (!input.task_id || typeof input.task_id !== "string") {
    errors.push("task_id is required and must be a string");
  }

  if (!input.provider || !EXECUTION_PROVIDERS.includes(input.provider)) {
    errors.push(`provider must be one of: ${EXECUTION_PROVIDERS.join(", ")}`);
  }

  if (input.interaction_mode && !INTERACTION_MODES.includes(input.interaction_mode)) {
    errors.push(`interaction_mode must be one of: ${INTERACTION_MODES.join(", ")}`);
  }

  if (input.timeout_ms !== undefined && input.timeout_ms !== null) {
    const t = Number(input.timeout_ms);
    if (!Number.isFinite(t) || t < 0 || t > MAX_TIMEOUT_MS) {
      errors.push(`timeout_ms must be between 0 and ${MAX_TIMEOUT_MS}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Normalize a raw request into a canonical ExecutionRequest.
 *
 * @param {object} input - Raw request input
 * @returns {object} Normalized ExecutionRequest
 * @throws {Error} If validation fails
 */
export function normalizeExecutionRequest(input) {
  const { valid, errors } = validateExecutionRequest(input);
  if (!valid) {
    throw new Error(`Invalid execution request: ${errors.join("; ")}`);
  }

  return {
    request_id: input.request_id || `req_${randomUUID()}`,
    task_id: input.task_id,
    goal_id: input.goal_id || null,
    workstream_id: input.workstream_id || null,
    provider: input.provider,
    interaction_mode: input.interaction_mode || "batch",
    workspace_id: input.workspace_id || "hosted-default",
    repo_id: input.repo_id || null,
    context_ref: input.context_ref || null,
    acceptance_contract_ref: input.acceptance_contract_ref || null,
    timeout_ms: Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS,
    resource_budget: {
      concurrency_units: input.resource_budget?.concurrency_units ?? 1,
      max_output_bytes: input.resource_budget?.max_output_bytes ?? 10_485_760,
    },
    metadata: input.metadata || {},
  };
}
