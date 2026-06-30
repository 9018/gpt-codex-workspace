import { normalizeList } from './acceptance-contract-schema.mjs';

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
  return ['merged', 'ff_only_merged', 'not_required', 'skipped'].includes(status);
}

function verificationProvided(result = {}) {
  const verification = result.verification || {};
  if (verification.passed === true && (commandList(verification.commands).length > 0 || hasValue(verification.report_path))) return true;
  if (verification.passed === true && hasValue(result.tests)) return true;
  if (hasValue(result.verification_report_path) || hasValue(result.evidence_paths?.verification_report)) return true;
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
    satisfied: (result) => diagnosticEvidence(result).repo_mutated === false || result.repo_mutated === false || result.no_mutation === true,
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
});

export function getRequirementCheck(id) {
  return GENERIC_REQUIREMENTS[String(id || '')] || null;
}

export function operationEvidenceProfile(operationKind) {
  return OPERATION_EVIDENCE_PROFILES[String(operationKind || '')] || null;
}

export { integrationSatisfied, healthPassed, verificationProvided };
