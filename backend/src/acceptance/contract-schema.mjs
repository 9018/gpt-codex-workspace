export const ACCEPTANCE_CONTRACT_SCHEMA_VERSION = 1;

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
  "noop"
]);

export const MUTATION_SCOPES = Object.freeze(["repo", "runtime", "filesystem", "external_system", "none"]);
export const EXECUTION_MODES = Object.freeze(["worktree", "canonical", "readonly", "admin", "deploy"]);
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
