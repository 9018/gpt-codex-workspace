import { normalizeList } from '../acceptance/contract-schema.mjs';
import { AGENT_ROLE_ENUM } from '../agent-artifact-contract.mjs';

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

function commandList(value) {
  return normalizeList(value).filter((entry) => hasValue(entry));
}

function fileEvidence(result = {}) {
  return normalizeList(result.file_evidence || result.blocking_evidence?.file_evidence);
}

function restartEvidence(result = {}) {
  return result.restart_evidence || result.blocking_evidence?.restart_evidence || {};
}

function adminEvidence(result = {}) {
  return result.admin_evidence || result.blocking_evidence?.admin_evidence || {};
}

function diagnosticEvidence(result = {}) {
  return result.diagnostic_evidence || result.blocking_evidence?.diagnostic_evidence || {};
}

function cleanupEvidence(result = {}) {
  return result.cleanup_evidence || result.blocking_evidence?.cleanup_evidence || {};
}

function healthPassed(health = {}) {
  if (health.ok === true) return true;
  const status = Number(health.status);
  return Number.isFinite(status) && status >= 200 && status < 400;
}

function integrationSatisfied(result = {}) {
  const integration = result.integration || {};
  if (integration.merged === true || integration.auto_completed === true) return true;
  const status = String(integration.status || '').toLowerCase();
  return ['merged', 'ff_only_merged', 'not_required', 'skipped', 'already_integrated'].includes(status);
}

function verificationProvided(result = {}) {
  const verification = result.verification || {};
  if (verification.passed === true && (commandList(verification.commands).length > 0 || hasValue(verification.report_path))) return true;
  if (verification.passed === true && hasValue(result.tests)) return true;
  if (hasValue(result.verification_report_path) || hasValue(result.evidence_paths?.verification_report)) return true;
  return false;
}


function reviewerDecisionProvided(result = {}) {
  const decision = result.reviewer_decision
    || result.result?.reviewer_decision
    || result.contract_verification?.normalized_result?.reviewer_decision
    || {};
  if (decision.passed === true) return true;
  if (decision.decision === 'accepted') return true;
  if (decision.status === 'accepted') return true;
  return false;
}

function integrationArtifactProvided(result = {}) {
  const integration = result.integration
    || result.result?.integration
    || result.contract_verification?.normalized_result?.integration
    || {};
  if (integration.merged === true) return true;
  if (['merged', 'ff_only_merged', 'not_required', 'skipped', 'already_integrated'].includes(String(integration.status || '').toLowerCase())) return true;
  if (integration.auto_completed === true) return true;
  return false;
}
const GENERIC_REQUIREMENTS = Object.freeze({
  commit_present: {
    code: 'commit_present_missing',
    message: 'Blocking contract requires commit evidence.',
    satisfied: (result) => hasValue(result.commit),
  },
  changed_files_reported: {
    code: 'changed_files_reported_missing',
    message: 'Blocking contract requires changed_files evidence.',
    satisfied: (result) => normalizeList(result.changed_files).length > 0,
  },
  verification_report: {
    code: 'verification_report_missing',
    message: 'Blocking contract requires verification command or report evidence.',
    satisfied: verificationProvided,
  },
  integration_completed: {
    code: 'integration_completed_missing',
    message: 'Blocking contract requires completed integration evidence.',
    satisfied: integrationSatisfied,
  },
  file_exists: {
    code: 'file_exists_missing',
    message: 'Blocking contract requires file existence evidence.',
    satisfied: (result) => fileEvidence(result).some((item) => item?.exists === true && hasValue(item?.path)),
  },
  file_checksum: {
    code: 'file_checksum_missing',
    message: 'Blocking contract requires file checksum evidence.',
    satisfied: (result) => fileEvidence(result).some((item) => hasValue(item?.sha256) || hasValue(item?.checksum)),
  },
  diff_reported: {
    code: 'diff_reported_missing',
    message: 'Blocking contract requires diff or changed_files evidence.',
    satisfied: (result) => normalizeList(result.changed_files).length > 0 || hasValue(result.diff) || hasValue(result.diff_summary),
  },
  restart_performed: {
    code: 'restart_performed_missing',
    message: 'Blocking contract requires restart marker or restart action evidence.',
    satisfied: (result) => hasValue(restartEvidence(result).restart_marker) || result.restart_state === 'verified' || result.post_restart_verified === true,
  },
  process_status_evidence: {
    code: 'process_status_evidence_missing',
    message: 'Blocking contract requires process before/after evidence.',
    satisfied: (result) => {
      const evidence = restartEvidence(result);
      return evidence.pid_changed === true || (hasValue(evidence.before_pid) && hasValue(evidence.after_pid));
    },
  },
  runtime_health_evidence: {
    code: 'runtime_health_evidence_missing',
    message: 'Blocking contract requires runtime health evidence.',
    satisfied: (result) => healthPassed(restartEvidence(result).health_check || result.health_check || result.runtime?.health_check),
  },
  reviewer_decision: {
    code: 'reviewer_decision_missing',
    message: 'Blocking contract requires reviewer decision evidence.',
    satisfied: reviewerDecisionProvided,
  },
  integration_artifact: {
    code: 'integration_artifact_missing',
    message: 'Blocking contract requires integration artifact evidence.',
    satisfied: integrationArtifactProvided,
  },
  pre_state_snapshot: {
    code: 'pre_state_snapshot_missing',
    message: 'Blocking contract requires pre-state snapshot evidence.',
    satisfied: (result) => isPresent(adminEvidence(result).pre_state_snapshot),
  },
  command_result: {
    code: 'command_result_missing',
    message: 'Blocking contract requires command result evidence.',
    satisfied: (result) => hasValue(adminEvidence(result).command_id) && adminEvidence(result).exit_code === 0,
  },
  post_state_snapshot: {
    code: 'post_state_snapshot_missing',
    message: 'Blocking contract requires post-state snapshot evidence.',
    satisfied: (result) => isPresent(adminEvidence(result).post_state_snapshot),
  },
  audit_evidence: {
    code: 'audit_evidence_missing',
    message: 'Blocking contract requires audit evidence.',
    satisfied: (result) => adminEvidence(result).audit_log_written === true || cleanupEvidence(result).audit_log_written === true || result.audit_log_written === true,
  },
  diagnostic_report: {
    code: 'diagnostic_report_missing',
    message: 'Blocking contract requires diagnostic report evidence.',
    satisfied: (result) => hasValue(diagnosticEvidence(result).summary) || hasValue(diagnosticEvidence(result).report_path) || hasValue(result.report_path),
  },
  no_mutation_evidence: {
    code: 'no_mutation_evidence_missing',
    message: 'Blocking contract requires no-mutation evidence.',
    satisfied: (result) => {
      // Direct no-mutation flags take precedence (works for all profiles)
      if (result.no_mutation === true) return true;
      if (result.repo_mutated === false) return true;

      // Operation-specific evidence field checks:
      // diagnostic_evidence.repo_mutated, validation_evidence.repo_mutated,
      // already_integrated_evidence.repo_mutated
      if (result.diagnostic_evidence?.repo_mutated === false) return true;
      if (result.validation_evidence?.repo_mutated === false) return true;
      if (result.already_integrated_evidence?.repo_mutated === false) return true;
      return false;
    },
  },
  dry_run_evidence: {
    code: 'dry_run_evidence_missing',
    message: 'Blocking contract requires dry-run evidence.',
    satisfied: (result) => hasValue(cleanupEvidence(result).dry_run_summary) || hasValue(result.dry_run_summary),
  },
  apply_evidence: {
    code: 'apply_evidence_missing',
    message: 'Blocking contract requires apply evidence.',
    satisfied: (result) => hasValue(cleanupEvidence(result).apply_summary) || hasValue(result.apply_summary),
  },
  before_after_counts: {
    code: 'before_after_counts_missing',
    message: 'Blocking contract requires before/after count evidence.',
    satisfied: (result) => hasValue(cleanupEvidence(result).before_counts) && hasValue(cleanupEvidence(result).after_counts),
  },
  active_items_preserved: {
    code: 'active_items_preserved_missing',
    message: 'Blocking contract requires active item preservation evidence.',
    satisfied: (result) => cleanupEvidence(result).active_items_preserved === true,
  },
});

export const OPERATION_EVIDENCE_PROFILES = Object.freeze({
  code_change: {
    evidence_fields: ['changed_files', 'commit', 'verification', 'integration'],
    required_when_completed: ['changed_files', 'commit', 'verification', 'integration'],
  },
  docs_only: {
    // P0-AFC10: Docs-only tasks need changed_files, commit, and verification
    // but do NOT require integration (docs changes verified via syntax /
    // delivery-check evidence, not ff-only merge).
    evidence_fields: ['changed_files', 'commit', 'verification'],
    required_when_completed: ['changed_files', 'commit', 'verification'],
  },
  file_write: {
    evidence_fields: ['file_evidence', 'changed_files', 'commit'],
    required_when_completed: ['file_evidence'],
  },
  restart: {
    evidence_fields: ['restart_evidence'],
    required_when_completed: ['restart_evidence'],
  },
  admin_command: {
    evidence_fields: ['admin_evidence'],
    required_when_completed: ['admin_evidence'],
  },
  diagnostic: {
    evidence_fields: ['diagnostic_evidence'],
    required_when_completed: ['diagnostic_evidence'],
  },
  cleanup: {
    evidence_fields: ['cleanup_evidence'],
    required_when_completed: ['cleanup_evidence'],
  },
  readonly_validation: {
    evidence_fields: ['validation_evidence'],
    required_when_completed: ['validation_evidence'],
  },
  already_integrated: {
    evidence_fields: ['already_integrated_evidence'],
    required_when_completed: ['already_integrated_evidence'],
  },
  integration: {
    evidence_fields: ['changed_files', 'commit', 'verification'],
    required_when_completed: ['changed_files', 'commit', 'verification'],
  },
  repair: {
    evidence_fields: ['changed_files', 'commit', 'verification', 'integration', 'repair_evidence'],
    required_when_completed: ['changed_files', 'commit', 'verification', 'integration'],
  },
  queue_admin: {
    evidence_fields: ['queue_admin_evidence'],
    required_when_completed: ['queue_admin_evidence'],
  },
});

export function getRequirementCheck(id) {
  return GENERIC_REQUIREMENTS[String(id || '')] || null;
}

export function operationEvidenceProfile(operationKind) {
  return OPERATION_EVIDENCE_PROFILES[String(operationKind || '')] || null;
}

/**
 * ROLE_EVIDENCE_PROFILES — Maps each pipeline role to its required evidence fields.
 *
 * This is the per-role evidence contract that defines which evidence fields each
 * pipeline agent role must produce. Unlike OPERATION_EVIDENCE_PROFILES which
 * is keyed by operation_kind, these profiles are keyed by pipeline role name.
 *
 * Each profile lists:
 *   evidence_fields: All possible evidence fields the role can produce
 *   required_when_completed: Subset of fields that must be present when the role completes
 *   artifact_kinds: Artifact kinds from ARTIFACT_SCHEMA.required_by_role that this role needs
 */
export const ROLE_EVIDENCE_PROFILES = Object.freeze({
  context_curator: {
    evidence_fields: ['context_bundle', 'context_retrieval', 'context_manifest'],
    required_when_completed: ['context_bundle'],
    artifact_kinds: ['context_bundle'],
  },
  planner: {
    evidence_fields: ['plan'],
    required_when_completed: ['plan'],
    artifact_kinds: ['plan'],
  },
  builder: {
    evidence_fields: ['change_summary', 'changed_files', 'commit', 'verification'],
    required_when_completed: ['change_summary', 'changed_files', 'commit', 'verification'],
    artifact_kinds: ['change_summary'],
  },
  verifier: {
    evidence_fields: ['verification'],
    required_when_completed: ['verification'],
    artifact_kinds: ['verification'],
  },
  repairer: {
    evidence_fields: ['repair', 'change_summary', 'changed_files', 'commit', 'verification'],
    required_when_completed: ['repair'],
    artifact_kinds: ['repair'],
  },
  reviewer: {
    evidence_fields: ['reviewer_decision'],
    required_when_completed: ['reviewer_decision'],
    artifact_kinds: ['reviewer_decision'],
  },
  finalizer: {
    evidence_fields: ['result', 'changed_files', 'commit', 'verification', 'integration'],
    required_when_completed: ['result'],
    artifact_kinds: ['result'],
  },
  integrator: {
    evidence_fields: ['integration'],
    required_when_completed: ['integration'],
    artifact_kinds: ['integration'],
  },
});

/**
 * Get the role evidence profile for a given pipeline role.
 *
 * @param {string} role - Pipeline role name (canonical)
 * @returns {object|null} Evidence profile or null if not found
 */
export function roleEvidenceProfile(role) {
  if (!role || typeof role !== 'string') return null;
  return ROLE_EVIDENCE_PROFILES[role] || null;
}

/**
 * Check a normalized result for missing role evidence.
 * For each role in the provided list, checks that the required_when_completed
 * evidence fields are present in the result or its agent runs.
 *
 * @param {object} normalized - Normalized result
 * @param {string[]} [roles] - Roles to check; defaults to all AGENT_ROLE_ENUM
 * @returns {Array<object>} Blockers for missing role evidence
 */
export function missingRoleEvidence(normalized = {}, roles = []) {
  const checkRoles = Array.isArray(roles) && roles.length > 0 ? roles : AGENT_ROLE_ENUM;
  const blockers = [];
  for (const role of checkRoles) {
    const profile = roleEvidenceProfile(role);
    if (!profile || normalized.status !== 'completed') continue;
    for (const field of profile.required_when_completed) {
      if (hasRoleEvidenceField(normalized, field)) continue;
      blockers.push({
        severity: 'blocker',
        code: 'role_' + role + '_' + field + '_missing',
        message: 'Completed role "' + role + '" requires "' + field + '" evidence.',
        source: 'role_evidence_profiles',
        role: role,
        evidence_field: field,
      });
    }
  }
  return blockers;
}

/**
 * Check a completed agent run against its role evidence profile.
 * Returns blockers if required artifact kinds are missing from the run output.
 *
 * @param {object} agentRun - Completed agent run object
 * @returns {Array<object>} Blockers for missing artifact evidence
 */
export function missingAgentRunEvidence(agentRun = {}) {
  const role = agentRun.contract_role || agentRun.role;
  const profile = roleEvidenceProfile(role);
  if (!profile || agentRun.status !== 'completed') return [];
  const artifacts = [
    ...(Array.isArray(agentRun.output_artifacts) ? agentRun.output_artifacts : []),
    ...(Array.isArray(agentRun.input_artifacts) ? agentRun.input_artifacts : []),
  ];
  const artifactKinds = new Set(
    artifacts.map((a) => (a && typeof a === 'object' ? a.kind : a)).filter(Boolean)
  );
  return profile.artifact_kinds
    .filter((kind) => !artifactKinds.has(kind))
    .map((kind) => ({
      severity: 'blocker',
      code: 'agent_run_' + role + '_' + kind + '_missing',
      message: 'Completed ' + role + ' agent run missing required artifact kind: ' + kind,
      source: 'role_evidence_profiles',
      role: role,
      artifact_kind: kind,
    }));
}

/**
 * Check if a value or data structure has a given role evidence field.
 * Searches result, nested sub-results, and agent run artifact kinds.
 *
 * @param {object} result - Normalized or raw result
 * @param {string} field - Evidence field name
 * @returns {boolean}
 */
function hasRoleEvidenceField(result, field) {
  if (typeof result !== 'object' || result === null) return false;
  const direct = result[field];
  if (direct && typeof direct === 'object' && !Array.isArray(direct) && Object.keys(direct).length > 0) return true;
  if (direct === true) return true;
  if (Array.isArray(direct) && direct.length > 0) return true;
  if (typeof direct === 'string' && direct.trim()) return true;
  // Check nested sub-results (result.result, contract_verification.normalized_result)
  const nested = result.result || (result.contract_verification && result.contract_verification.normalized_result) || {};
  if (nested && typeof nested === 'object' && nested !== result) {
    const nestedField = nested[field];
    if (nestedField && typeof nestedField === 'object' && !Array.isArray(nestedField) && Object.keys(nestedField).length > 0) return true;
    if (nestedField === true) return true;
  }
  // Check agent run output artifact kinds
  const agentRuns = result.agent_runs || result.runs || [];
  if (Array.isArray(agentRuns)) {
    for (const run of agentRuns) {
      const artifacts = [...(run.output_artifacts || []), ...(run.input_artifacts || [])];
      for (const artifact of artifacts) {
        const kind = artifact && typeof artifact === 'object' ? artifact.kind : artifact;
        if (typeof kind === 'string' && kind === field) return true;
      }
    }
  }
  return false;
}


export { integrationSatisfied, healthPassed, verificationProvided };
