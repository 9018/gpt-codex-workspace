/**
 * execution-intent-classifier.mjs — Heuristic intent classifier.
 *
 * Given a raw request (or partially populated ExecutionIntent), this module
 * guesses the operation_kind and mutation_scope from the request text.  It
 * does NOT execute any work, select a provider, or create resources.
 *
 * @module execution-intent-classifier
 */

import { normalizeExecutionIntent, OPERATION_KINDS, MUTATION_SCOPES } from "./execution-intent-schema.mjs";

const OPERATION_KIND_SET = new Set(OPERATION_KINDS);
const MUTATION_SCOPE_SET = new Set(MUTATION_SCOPES);

/**
 * Check if `text` contains any of the given substrings (case-insensitive).
 * For English keywords, we also try a word-boundary match to avoid false
 * positives like "test" matching within "latest".
 */
function containsAny(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

/**
 * Check if `text` contains a keyword as a whole word (bounded by non-word
 * characters or start/end of string).
 */
function containsWord(text, word) {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
  return pattern.test(text);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match against a list of whole words (word-boundary sensitive).
 */
function containsAnyWord(text, words) {
  return words.some((w) => containsWord(text, w));
}

/**
 * Normalize an explicit (pre-set) operation_kind and mutation_scope.
 */
function normalizeExplicitIntent(input) {
  const kind = input.operation_kind;
  if (!OPERATION_KIND_SET.has(kind)) {
    return { operation_kind: "question", mutation_scope: "none", confidence: "low" };
  }

  const scope = MUTATION_SCOPE_SET.has(input.mutation_scope)
    ? input.mutation_scope
    : inferMutationScope(kind);

  return { operation_kind: kind, mutation_scope: scope, confidence: "high" };
}

/**
 * Infer default mutation_scope for a given operation_kind.
 */
function inferMutationScope(kind) {
  switch (kind) {
    case "code_change":
    case "docs_change":
    case "config_change":
      return "repo";
    case "runtime_operation":
      return "runtime";
    case "external_operation":
      return "external_system";
    default:
      return "none";
  }
}

/**
 * Classify a user request into an intent fragment.
 *
 * @param {object} [input={}] - Raw input
 * @param {string} [input.request_text] - The user's natural language request
 * @param {string} [input.operation_kind] - Explicit kind override
 * @param {string} [input.mutation_scope] - Explicit scope override
 * @returns {object} { operation_kind, mutation_scope, confidence, requires_planner_confirmation? }
 */
export function classifyExecutionIntent(input = {}) {
  const text = String(input.request_text || "").toLowerCase();

  if (input.operation_kind) {
    return normalizeExplicitIntent(input);
  }

  // --- code_change ---
  if (containsAny(text, ["修改代码", "修复", "重构"])) {
    return { operation_kind: "code_change", mutation_scope: "repo", confidence: "high" };
  }
  if (containsAnyWord(text, ["refactor", "implement", "fix", "feature"])) {
    return { operation_kind: "code_change", mutation_scope: "repo", confidence: "high" };
  }

  // --- docs_change ---
  if (containsAny(text, ["更新文档", "修改文档", "docs"])) {
    // "docs" also works via substring for "docs: update readme" etc
    return { operation_kind: "docs_change", mutation_scope: "repo", confidence: "high" };
  }
  if (containsAnyWord(text, ["readme", "documentation"])) {
    return { operation_kind: "docs_change", mutation_scope: "repo", confidence: "high" };
  }

  // --- test_only ---
  if (containsAny(text, ["运行测试", "测试代码", "run tests", "execute tests", "coverage"])) {
    return { operation_kind: "test_only", mutation_scope: "none", confidence: "high" };
  }
  if (containsWord(text, "test")) {
    return { operation_kind: "test_only", mutation_scope: "none", confidence: "high" };
  }

  // --- code_review ---
  if (containsAny(text, ["评审"])) {
    return { operation_kind: "code_review", mutation_scope: "none", confidence: "high" };
  }
  if (containsAnyWord(text, ["code review", "review"])) {
    return { operation_kind: "code_review", mutation_scope: "none", confidence: "high" };
  }

  // --- planning ---
  if (containsAny(text, ["设计"])) {
    return { operation_kind: "planning", mutation_scope: "none", confidence: "medium" };
  }
  if (containsAnyWord(text, ["plan", "planning", "design", "architecture"])) {
    return { operation_kind: "planning", mutation_scope: "none", confidence: "medium" };
  }

  // --- question / diagnostic ---
  if (containsAny(text, ["分析", "是什么", "为什么", "距离产品化"])) {
    return { operation_kind: "question", mutation_scope: "none", confidence: "medium" };
  }
  if (containsAnyWord(text, ["analyze", "explain", "diagnose", "what is", "why does"])) {
    return { operation_kind: "question", mutation_scope: "none", confidence: "medium" };
  }

  // --- fallback ---
  return {
    operation_kind: "question",
    mutation_scope: "none",
    confidence: "low",
    requires_planner_confirmation: true,
  };
}

/**
 * Classify and normalize in one call.
 *
 * @param {object} input
 * @returns {object} Full ExecutionIntent
 */
export function classifyAndNormalize(input = {}) {
  const classification = classifyExecutionIntent(input);

  return normalizeExecutionIntent({
    ...input,
    operation_kind: classification.operation_kind,
    mutation_scope: classification.mutation_scope,
  });
}
