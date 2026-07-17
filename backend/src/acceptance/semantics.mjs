import {
  DEFAULT_COMPLETION_POLICY,
  KNOWN_EXECUTION_MODES,
  KNOWN_MUTATION_SCOPES,
  KNOWN_OPERATION_KINDS,
  KNOWN_SEMANTIC_CONFIDENCES,
  addReviewReason,
  assertionIds,
  cloneJson,
  disableAutoCompletion,
  normalizeContractCustomFields,
  normalizeList,
  normalizeReviewPolicy,
  requirementIds
} from "./contract-schema.mjs";

const AMBIGUOUS_CLOSURE_FIELDS = new Set(["ok", "done", "success", "safe", "passed"]);

function err(code, message) {
  return { code, message };
}

function hasRequirement(contract, id) {
  return requirementIds(contract).has(id);
}

function hasEvidenceText(contract, pattern) {
  const haystack = JSON.stringify({
    blocking_requirements: normalizeList(contract.blocking_requirements),
    state_assertions: normalizeList(contract.state_assertions)
  }).toLowerCase();
  return pattern.test(haystack);
}

function requirementHasOnlyAmbiguousClosureSignals(item) {
  const values = [item?.id, item?.field, item?.name, ...normalizeList(item?.evidence)]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return false;
  return values.every((value) => AMBIGUOUS_CLOSURE_FIELDS.has(value));
}

function meansMerged(assertion) {
  return String(assertion?.means || assertion?.description || assertion?.value || "").toLowerCase().includes("merged");
}

export function validateContractSemantics(contract = {}) {
  const normalized = cloneJson(contract) || {};
  // Phase 3: Normalize any top-level custom fields that conflict with canonical intent block
  const customFieldWarnings = normalizeContractCustomFields(normalized);
  normalized.requirements = { ...(normalized.requirements || {}) };
  normalized.verification_plan = { ...(normalized.verification_plan || {}) };
  normalized.blocking_requirements = normalizeList(normalized.blocking_requirements);
  normalized.state_assertions = normalizeList(normalized.state_assertions);
  normalized.non_blocking_quality_expectations = normalizeList(normalized.non_blocking_quality_expectations);
  normalized.completion_policy = { ...DEFAULT_COMPLETION_POLICY, ...(normalized.completion_policy || {}) };
  normalized.review_policy = normalizeReviewPolicy(normalized.review_policy || {});

  const errors = [];
  const warnings = [...customFieldWarnings.warnings];
  const intent = normalized.intent || {};
  const operationKind = intent.operation_kind;
  const mutationScope = intent.mutation_scope;
  const executionMode = intent.execution_mode;
  const semanticConfidence = intent.semantic_confidence;

  if (!KNOWN_OPERATION_KINDS.has(operationKind)) errors.push(err("unknown_operation_kind", `unknown operation_kind: ${operationKind || "(missing)"}`));
  if (!KNOWN_MUTATION_SCOPES.has(mutationScope)) errors.push(err("unknown_mutation_scope", `unknown mutation_scope: ${mutationScope || "(missing)"}`));
  if (!KNOWN_EXECUTION_MODES.has(executionMode)) errors.push(err("unknown_execution_mode", `unknown execution_mode: ${executionMode || "(missing)"}`));
  if (!KNOWN_SEMANTIC_CONFIDENCES.has(semanticConfidence)) errors.push(err("unknown_semantic_confidence", `unknown semantic_confidence: ${semanticConfidence || "(missing)"}`));

  // operation_kind selects defaults only. Explicit requirements are authoritative,
  // so code_change does not itself force commit or integration policy.

  if (operationKind === "restart") {
    if (normalized.requirements.requires_commit === true) errors.push(err("restart_requires_commit_conflict", "restart contracts must not require commit evidence by default."));
    if (normalized.requirements.requires_integration === true) errors.push(err("restart_requires_integration_conflict", "restart contracts must not require repo integration evidence."));
    if (hasRequirement(normalized, "changed_files_reported") || hasEvidenceText(normalized, /changed_files/)) {
      errors.push(err("restart_changed_files_conflict", "restart contracts must not require changed_files evidence."));
    }
  }

  if (operationKind === "diagnostic") {
    if (normalized.requirements.requires_commit === true) errors.push(err("diagnostic_requires_commit_conflict", "diagnostic contracts must not require commit evidence."));
    if (normalized.requirements.requires_integration === true) errors.push(err("diagnostic_requires_integration_conflict", "diagnostic contracts must not require integration evidence."));
    if (mutationScope !== "none") {
      errors.push(err("diagnostic_readonly_conflict", "diagnostic contracts must be readonly with mutation_scope none."));
    }
  }

  if (operationKind === "deploy") {
    if (!hasRequirement(normalized, "deployment_health") && !hasEvidenceText(normalized, /health/)) {
      errors.push(err("deploy_missing_health", "deploy contracts must require health evidence."));
    }
    if (!hasRequirement(normalized, "runtime_version_evidence") && !hasEvidenceText(normalized, /runtime|version|release|image/)) {
      errors.push(err("deploy_missing_runtime", "deploy contracts must require runtime version evidence."));
    }
  }


  if (operationKind === "readonly_validation" || operationKind === "already_integrated") {
    if (normalized.requirements.requires_commit === true) errors.push(err("readonly_requires_commit_conflict", "readonly_validation/already_integrated contracts must not require commit evidence."));
    if (normalized.requirements.requires_integration === true) errors.push(err("readonly_requires_integration_conflict", "readonly_validation/already_integrated contracts must not require integration evidence."));
    if (mutationScope !== "none") {
      errors.push(err("readonly_scope_conflict", "readonly_validation/already_integrated contracts must be readonly with mutation_scope none."));
    }
  }
  if (operationKind === "integration") {
    if (normalized.requirements.requires_commit !== true) errors.push(err("integration_requires_commit", "integration contracts must require commit evidence."));
    if (normalized.requirements.requires_integration === true) errors.push(err("integration_requires_integration_conflict", "integration contracts must not require integration evidence (they are the integration)."));
  }
  // Repair tasks also inherit defaults, but explicit requirements may narrow
  // the mutation/integration scope without making the contract invalid.
  if (operationKind === "queue_admin") {
    if (normalized.requirements.requires_commit === true) errors.push(err("queue_admin_requires_commit_conflict", "queue_admin contracts must not require commit evidence."));
    if (normalized.requirements.requires_integration === true) errors.push(err("queue_admin_requires_integration_conflict", "queue_admin contracts must not require integration evidence."));
  }

  if (operationKind === "cleanup") {
    const assertions = assertionIds(normalized);
    if (!hasRequirement(normalized, "dry_run_evidence") && !assertions.has("dry_run_not_needed_reason")) {
      errors.push(err("cleanup_missing_dry_run", "cleanup contracts must require dry-run evidence or explicitly state why dry-run is not needed."));
    }
  }

  for (const requirement of normalized.blocking_requirements) {
    if (requirementHasOnlyAmbiguousClosureSignals(requirement)) {
      errors.push(err("ambiguous_closure_field", `ambiguous closure field cannot independently satisfy blocking requirements: ${requirement.id || "(unnamed)"}`));
    }
  }

  for (const assertion of normalized.state_assertions) {
    const id = String(assertion?.id || "");
    if ((id === "branch_pushed" || id === "pr_opened") && meansMerged(assertion)) {
      errors.push(err("integration_state_conflict", `${id} must not be treated as merged.`));
    }
  }

  if (semanticConfidence === "low") {
    addReviewReason(normalized, "semantic_ambiguity");
    disableAutoCompletion(normalized);
    warnings.push(err("semantic_ambiguity", "Low semantic confidence requires review before automatic completion."));
  }

  if (errors.length > 0) {
    addReviewReason(normalized, "contract_invalid");
    disableAutoCompletion(normalized);
  }

  normalized.semantic_validation = {
    valid: errors.length === 0,
    errors,
    warnings
  };

  return { valid: errors.length === 0, errors, warnings, normalized };
}
