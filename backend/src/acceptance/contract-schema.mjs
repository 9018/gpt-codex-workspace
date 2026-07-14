export const ACCEPTANCE_CONTRACT_SCHEMA_VERSION = 2;

export const OPERATION_KINDS = Object.freeze([
  "code_change",
  "file_write",
  "docs_only",
  "config_change",
  "restart",
  "deploy",
  "admin_command",
  "diagnostic",
  "cleanup",
  "external_sync",
  "data_migration",
  "noop",
  "readonly_validation",
  "already_integrated",
  "integration",
  "repair",
  "queue_admin"
]);

export const MUTATION_SCOPES = Object.freeze(["repo", "runtime", "filesystem", "external_system", "none"]);
export const EXECUTION_MODES = Object.freeze(["full"]);
export const SEMANTIC_CONFIDENCES = Object.freeze(["high", "medium", "low"]);

export const KNOWN_OPERATION_KINDS = new Set(OPERATION_KINDS);
export const KNOWN_MUTATION_SCOPES = new Set(MUTATION_SCOPES);
export const KNOWN_EXECUTION_MODES = new Set(EXECUTION_MODES);
export const KNOWN_SEMANTIC_CONFIDENCES = new Set(SEMANTIC_CONFIDENCES);

export const DEFAULT_COMPLETION_POLICY = Object.freeze({
  auto_complete_when_blocking_requirements_pass: true,
  allow_completed_with_followups: true,
  do_not_block_on_quality_notes: true
});

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function normalizeList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

export function normalizeReviewPolicy(value = {}) {
  const reasons = Array.isArray(value.requires_review_when) ? value.requires_review_when.map(String) : [];
  return { ...value, requires_review_when: [...new Set(reasons)] };
}

export function addReviewReason(contract, reason) {
  contract.review_policy = normalizeReviewPolicy(contract.review_policy);
  if (!contract.review_policy.requires_review_when.includes(reason)) {
    contract.review_policy.requires_review_when.push(reason);
  }
}

export function disableAutoCompletion(contract) {
  contract.completion_policy = {
    ...DEFAULT_COMPLETION_POLICY,
    ...(contract.completion_policy || {}),
    auto_complete_when_blocking_requirements_pass: false
  };
}

export function requirementIds(contract) {
  return new Set(normalizeList(contract?.blocking_requirements).map((item) => String(item?.id || "")));
}

export function assertionIds(contract) {
  return new Set(normalizeList(contract?.state_assertions).map((item) => String(item?.id || "")));
}


/**
 * Normalize top-level custom fields that conflict with the canonical intent block.
 *
 * Some acceptance contracts have both:
 *   intent: { operation_kind: "diagnostic", execution_mode: "readonly", mutation_scope: "none" }
 * AND custom top-level:
 *   execution_mode: "implementation", mutation_scope: "code_tests_docs"
 *
 * This function detects the conflict and:
 * 1. Removes the conflicting top-level fields
 * 2. Adds a warning to contract warnings
 * 3. The intent block is the single source of truth
 *
 * @param {object} contract - The acceptance contract (mutated in place)
 * @returns {{ warnings: string[] }} Warnings about detected conflicts
 */
export function normalizeContractCustomFields(contract) {
  const warnings = [];
  if (!contract || typeof contract !== "object") return { warnings };

  const intent = contract.intent || {};
  const topLevelFields = [];

  if ("execution_mode" in contract && contract.execution_mode !== undefined) {
    topLevelFields.push({ field: "execution_mode", value: contract.execution_mode, intentField: intent.execution_mode || "readonly" });
  }
  if ("mutation_scope" in contract && contract.mutation_scope !== undefined) {
    topLevelFields.push({ field: "mutation_scope", value: contract.mutation_scope, intentField: intent.mutation_scope || "none" });
  }

  for (const { field, value, intentField } of topLevelFields) {
    if (String(value) !== String(intentField)) {
      warnings.push(
        "Top-level '" + field + ": " + value + "' conflicts with canonical intent." + field + ": " + intentField + ". " +
        "Removed top-level '" + field + "'. The intent block is the single source of truth."
      );
      delete contract[field];
    }
  }

  if (topLevelFields.length > 0) {
    warnings.push(
      "Top-level execution_mode/mutation_scope fields are legacy custom fields. " +
      "The canonical location is intent.execution_mode and intent.mutation_scope."
    );
  }

  return { warnings };
}
/**
 * Default contract for full execution mode.
 * Every contract is normalized to include these defaults,
 * with explicit fields overriding them.
 */
export const FULL_CONTRACT_DEFAULTS = Object.freeze({
  mode: "full",
  requires_commit: true,
  requires_integration: true,
  required_checks: [],
  mutation_scope: { include: ["backend/src/**", "backend/test/**", "docs/**"], exclude: [".gptwork/**", "node_modules/**"] },
  retry_policy: { max_attempts: 3, no_progress_timeout_ms: 180000, wake_grace_ms: 30000, backoff_ms: [0, 5000, 20000] },
  acceptance_policy: { auto_accept: true, fail_on_missing_evidence: true, recheck_after_integration: true },
  source_precedence: { explicit_fields: [], inherited_fields: [], inferred_fields: [] }
});
