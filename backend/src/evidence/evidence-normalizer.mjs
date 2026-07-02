import { normalizeList } from '../acceptance/contract-schema.mjs';
import { operationEvidenceProfile } from './operation-evidence-profiles.mjs';

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function blocker(code, message, evidence = {}) {
  return { severity: 'blocker', code, message, source: 'evidence_normalizer', evidence };
}

function inferOperationKind({ result = {}, contract = {} } = {}) {
  if (hasValue(result.operation_kind)) return String(result.operation_kind);
  if (hasValue(result.operationKind)) return String(result.operationKind);
  if (hasValue(contract.intent?.operation_kind)) return String(contract.intent.operation_kind);
  if (result.restart_evidence || result.restart_state || result.restart_verified_at) return 'restart';
  if (result.admin_evidence || result.admin_action || result.audit_id) return 'admin_command';
  if (result.diagnostic_evidence || result.repo_mutated === false) return 'diagnostic';
  if (result.cleanup_evidence || result.dry_run_summary || result.apply_summary) return 'cleanup';
  if (result.file_evidence) return 'file_write';
  if (result.validation_evidence || result.validation_summary) return 'readonly_validation';
  if (result.already_integrated_evidence || result.noop_integration_evidence) return 'already_integrated';
  if (result.integration_only || result.integration_evidence?.ff_only_merged) return 'integration';
  if (result.repair_evidence || result.repair_marker) return 'repair';
  if (result.queue_admin_evidence || result.queue_operation) return 'queue_admin';
  if (normalizeList(result.changed_files).length > 0 || hasValue(result.commit)) return 'code_change';
  return 'unknown';
}

function normalizeCommands(value) {
  return normalizeList(value).filter((item) => hasValue(item));
}

function normalizeVerification(result = {}) {
  const verification = result.verification && typeof result.verification === 'object' && !Array.isArray(result.verification)
    ? result.verification
    : {};
  return {
    ...verification,
    passed: verification.passed === true ? true : (verification.passed === false ? false : null),
    profile: verification.profile || result.verification_profile || null,
    commands: normalizeCommands(verification.commands),
    report_path: verification.report_path || result.verification_report_path || result.evidence_paths?.verification_report || null,
  };
}

function normalizeIntegration(result = {}) {
  const integration = result.integration && typeof result.integration === 'object' && !Array.isArray(result.integration)
    ? result.integration
    : {};
  return {
    ...integration,
    status: integration.status || (integration.merged === true ? 'merged' : null),
    merged: integration.merged === true,
    auto_completed: integration.auto_completed === true,
  };
}

function normalizeRestartEvidence(result = {}) {
  const evidence = result.restart_evidence || result.blocking_evidence?.restart_evidence || {};
  return {
    ...evidence,
    restart_marker: evidence.restart_marker || result.restart_marker || null,
    before_pid: evidence.before_pid ?? result.before_pid ?? null,
    after_pid: evidence.after_pid ?? result.after_pid ?? null,
    pid_changed: evidence.pid_changed === true || (hasValue(evidence.before_pid) && hasValue(evidence.after_pid) && evidence.before_pid !== evidence.after_pid),
    health_check: evidence.health_check || result.health_check || result.runtime?.health_check || null,
    expected_commit: evidence.expected_commit || result.expected_commit || result.commit || null,
    running_commit: evidence.running_commit || result.running_commit || result.runtime?.running_commit || null,
    runtime_commit_matches: evidence.runtime_commit_matches === true || (hasValue(evidence.expected_commit) && evidence.expected_commit === evidence.running_commit),
  };
}

function normalizeAdminEvidence(result = {}) {
  const evidence = result.admin_evidence || result.blocking_evidence?.admin_evidence || {};
  return {
    ...evidence,
    command_id: evidence.command_id || result.command_id || result.admin_action || null,
    pre_state_snapshot: evidence.pre_state_snapshot || result.pre_state_snapshot || null,
    post_state_snapshot: evidence.post_state_snapshot || result.post_state_snapshot || null,
    state_delta: evidence.state_delta || result.state_delta || null,
    audit_log_written: evidence.audit_log_written === true || result.audit_log_written === true || hasValue(result.audit_id),
    exit_code: typeof evidence.exit_code === 'number' ? evidence.exit_code : (typeof result.exit_code === 'number' ? result.exit_code : null),
  };
}

function normalizeDiagnosticEvidence(result = {}) {
  const evidence = result.diagnostic_evidence || result.blocking_evidence?.diagnostic_evidence || {};
  return {
    ...evidence,
    summary: evidence.summary || result.diagnostic_summary || result.summary || null,
    commands_run: normalizeCommands(evidence.commands_run || result.commands_run || result.verification?.commands),
    report_path: evidence.report_path || result.report_path || result.verification?.report_path || result.verification_report_path || null,
    repo_mutated: evidence.repo_mutated === true ? true : (evidence.repo_mutated === false || result.repo_mutated === false ? false : null),
  };
}

function normalizeCleanupEvidence(result = {}) {
  const evidence = result.cleanup_evidence || result.blocking_evidence?.cleanup_evidence || {};
  return {
    ...evidence,
    dry_run_summary: evidence.dry_run_summary || result.dry_run_summary || null,
    apply_summary: evidence.apply_summary || result.apply_summary || null,
    before_counts: evidence.before_counts || result.before_counts || null,
    after_counts: evidence.after_counts || result.after_counts || null,
    active_items_preserved: evidence.active_items_preserved === true || result.active_items_preserved === true,
    audit_log_written: evidence.audit_log_written === true || result.audit_log_written === true,
  };
}

function normalizeFileEvidence(result = {}) {
  return normalizeList(result.file_evidence || result.blocking_evidence?.file_evidence).map((item) => ({
    path: item?.path || null,
    exists: item?.exists === true,
    bytes: typeof item?.bytes === 'number' ? item.bytes : null,
    sha256: item?.sha256 || item?.checksum || null,
    included_in_commit: item?.included_in_commit === true,
    ...item,
  }));
}

function missingProfileEvidence(normalized) {
  const profile = operationEvidenceProfile(normalized.operation_kind);
  if (!profile || normalized.status !== 'completed') return [];
  const blockers = [];
  for (const field of profile.required_when_completed) {
    if (!hasValue(normalized[field])) {
      blockers.push(blocker(`${field}_missing`, `Completed ${normalized.operation_kind} result requires ${field} evidence.`));
    }
  }
  return blockers;
}

export function normalizeOperationEvidence({ result = {}, contract = {} } = {}) {
  const operationKind = inferOperationKind({ result, contract });
  const contractKind = contract?.intent?.operation_kind ? String(contract.intent.operation_kind) : null;
  const normalized = {
    ...result,
    status: result.status || null,
    summary: result.summary || '',
    operation_kind: operationKind,
    acceptance_contract_id: result.acceptance_contract_id || result.acceptanceContractId || contract?.id || contract?.contract_id || null,
    changed_files: normalizeList(result.changed_files || result.changedFiles).map(String),
    commit: result.commit || null,
    verification: normalizeVerification(result),
    integration: normalizeIntegration(result),
    file_evidence: normalizeFileEvidence(result),
    restart_evidence: normalizeRestartEvidence(result),
    admin_evidence: normalizeAdminEvidence(result),
    diagnostic_evidence: normalizeDiagnosticEvidence(result),
    cleanup_evidence: normalizeCleanupEvidence(result),
    blocking_evidence: result.blocking_evidence && typeof result.blocking_evidence === 'object' ? result.blocking_evidence : {},
    followup_findings: normalizeList(result.followup_findings || result.followups),
    non_blocking_followups: normalizeList(result.non_blocking_followups || result.followup_findings || result.followups),
    quality_notes: normalizeList(result.quality_notes || result.qualityNotes),
    blockers: [],
    requires_review: result.requires_review === true,
  };

  if (contractKind && operationKind !== 'unknown' && operationKind !== contractKind) {
    normalized.blockers.push(blocker('operation_kind_mismatch', `Result operation_kind ${operationKind} does not match contract operation_kind ${contractKind}.`, { operation_kind: operationKind, contract_operation_kind: contractKind }));
    normalized.requires_review = true;
  }
  if (contract?.intent?.semantic_confidence === 'low' || normalizeList(contract?.review_policy?.requires_review_when).includes('semantic_ambiguity')) {
    normalized.blockers.push(blocker('semantic_ambiguity', 'Acceptance contract has low semantic confidence and requires review.'));
    normalized.requires_review = true;
  }

  normalized.blockers.push(...missingProfileEvidence(normalized));
  if (normalized.blockers.length > 0) normalized.requires_review = true;
  return normalized;
}
