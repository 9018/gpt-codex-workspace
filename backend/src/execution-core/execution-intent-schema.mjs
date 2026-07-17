/**
 * execution-intent-schema.mjs — ExecutionIntent data schema and normalizer.
 *
 * This file defines the canonical shape of an ExecutionIntent: the pure
 * description of what a user (or upstream system) wants done.  It does NOT
 * select a provider, create a worktree, modify a Task, execute commands,
 * or judge completion.  Its sole job is validation and normalization.
 *
 * @module execution-intent-schema
 */

import { randomUUID } from "node:crypto";

/** Known categories of user-facing operation. */
export const OPERATION_KINDS = Object.freeze([
  "code_change",
  "docs_change",
  "test_only",
  "question",
  "diagnostic",
  "code_review",
  "planning",
  "config_change",
  "runtime_operation",
  "external_operation",
]);

/** Known mutation scopes, from safest to riskiest. */
export const MUTATION_SCOPES = Object.freeze([
  "none",
  "repo",
  "filesystem",
  "runtime",
  "external_system",
]);

const OPERATION_KIND_SET = new Set(OPERATION_KINDS);
const MUTATION_SCOPE_SET = new Set(MUTATION_SCOPES);

/** Default context budget for a single execution run (1.31M tokens). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 1_310_720;

/**
 * Normalize a raw input object into a canonical ExecutionIntent.
 *
 * @param {object} [input={}] - Raw intent input
 * @param {string}   input.id
 * @param {string}   input.request_text
 * @param {string}   [input.operation_kind]
 * @param {string}   [input.mutation_scope]
 * @param {string}   [input.goal_id]
 * @param {string}   [input.task_id]
 * @param {string}   [input.workstream_id]
 * @param {string[]} [input.expected_outputs]
 * @param {object}   [input.constraints]
 * @param {string}   [input.acceptance_profile]
 * @param {object}   [input.execution_policy]
 * @param {object}   [input.context_policy]
 * @param {string}   [input.created_at]
 * @returns {object} Canonical ExecutionIntent
 * @throws {Error} If request_text is missing or empty
 */
export function normalizeExecutionIntent(input = {}) {
  if (!input.request_text?.trim()) {
    throw new Error("request_text is required");
  }

  return {
    id: input.id || `intent_${randomUUID()}`,
    request_text: input.request_text.trim(),
    operation_kind: OPERATION_KIND_SET.has(input.operation_kind) ? input.operation_kind : null,
    mutation_scope: MUTATION_SCOPE_SET.has(input.mutation_scope) ? input.mutation_scope : "none",
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    workstream_id: input.workstream_id || null,
    expected_outputs: Array.isArray(input.expected_outputs)
      ? [...input.expected_outputs]
      : [],
    constraints: input.constraints && typeof input.constraints === "object"
      ? structuredClone(input.constraints)
      : {},
    acceptance_profile: input.acceptance_profile || input.operation_kind || null,
    execution_policy: {
      preferred_provider: input.execution_policy?.preferred_provider || "codex_tui",
      fallback_allowed: input.execution_policy?.fallback_allowed === true,
      interaction_mode: input.execution_policy?.interaction_mode || "automatic",
      max_attempts: input.execution_policy?.max_attempts ?? 3,
    },
    context_policy: {
      max_tokens: input.context_policy?.max_tokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      retrieval_mode: input.context_policy?.retrieval_mode || "indexed",
      include_history: input.context_policy?.include_history !== false,
    },
    created_at: input.created_at || new Date().toISOString(),
  };
}
