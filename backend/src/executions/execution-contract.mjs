/**
 * execution-contract.mjs — Execution request validation and normalization.
 *
 * Defines the protocol for creating execution requests.  The primary
 * identifier is `intent_id` (or an inline `intent`), allowing questions
 * and other non-task operations to flow through the same pipeline.
 *
 * Backward-compatible: old callers that pass only `task_id` + `provider`
 * still work — the normalizer fills in defaults.
 *
 * @module execution-contract
 */
/**
 * @deprecated Wave 10R — 旧 execution 路径。
 * 新代码应使用 execution-core/ 模块：
 *   ExecutionRunService → execution-core/execution-run-service.mjs
 *   ExecutionRunStore → execution-core/execution-run-store.mjs
 * 将在下次大版本中移除。
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
 * Supports both new-style (intent_id/intent) and legacy (task_id + provider).
 *
 * @param {object} input - Raw request input
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExecutionRequest(input) {
  const errors = [];

  if (!input || typeof input !== "object") {
    return { valid: false, errors: ["input must be a non-null object"] };
  }

  // New-style: intent or intent_id is required
  if (!input?.intent_id && !input?.intent) {
    // Legacy fallback — allow task_id alone for backward compatibility
    if (!input.task_id || typeof input.task_id !== "string") {
      errors.push("intent_id or intent is required");
    }
  }

  if (input.task_id != null && typeof input.task_id !== "string") {
    errors.push("task_id must be a string when provided");
  }

  // Provider is optional now (defaults to "auto")
  const requestedProvider =
    input.execution_policy?.preferred_provider || input.provider || "codex_tui";

  if (requestedProvider !== "auto" && !EXECUTION_PROVIDERS.includes(requestedProvider)) {
    errors.push(`provider must be one of: auto, ${EXECUTION_PROVIDERS.join(", ")}`);
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
 * Create a canonical request_id.
 * @returns {string}
 */
function createRequestId() {
  return `req_${randomUUID()}`;
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
    request_id: input.request_id || createRequestId(),
    intent_id: input.intent_id || (input.intent ? input.intent.id : null),
    intent: input.intent || null,
    task_id: input.task_id || null,
    goal_id: input.goal_id || null,
    workstream_id: input.workstream_id || null,
    execution_policy: {
      preferred_provider:
        input.execution_policy?.preferred_provider || input.provider || "codex_tui",
      fallback_allowed: input.execution_policy?.fallback_allowed === true,
      interaction_mode:
        input.execution_policy?.interaction_mode || input.interaction_mode || "automatic",
    },
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
