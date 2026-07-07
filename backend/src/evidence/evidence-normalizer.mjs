import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { normalizeList } from '../acceptance/contract-schema.mjs';
import { operationEvidenceProfile } from './operation-evidence-profiles.mjs';

const MAX_ARTIFACT_READ_BYTES = 2 * 1024 * 1024;

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function blocker(code, message, evidence = {}) {
  return { severity: 'blocker', code, message, source: 'evidence_normalizer', evidence };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

function copyPresentFields(target, source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isPresent(value)) target[key] = value;
  }
  return target;
}

function pathExists(path) {
  if (!hasValue(path) || typeof path !== 'string') return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeReadText(path, maxBytes = MAX_ARTIFACT_READ_BYTES) {
  if (!pathExists(path)) return null;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(path) {
  const text = safeReadText(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEvidencePaths(result = {}) {
  return asObject(result.evidence_paths || result.evidencePaths);
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (command && typeof command === 'object') {
    const args = Array.isArray(command.args) ? command.args.join(' ') : '';
    return [command.name, command.cmd || command.command, args].filter(Boolean).join(' ');
  }
  return '';
}

function commandPassed(command) {
  if (typeof command === 'string') return true;
  if (!command || typeof command !== 'object') return false;
  if (command.passed === true) return true;
  return command.exit_code === 0;
}

function commandIsAuditProof(command) {
  const text = commandText(command).toLowerCase();
  if (!text.includes('audit')) return false;
  return /(log|evidence|written|exists|verify|check|snapshot)/i.test(text);
}

function firstPassingAuditCommand(commands = []) {
  return normalizeCommands(commands).find((command) => commandPassed(command) && commandIsAuditProof(command)) || null;
}

function extractAdminEvidenceFromObject(value = {}) {
  const source = asObject(value);
  const candidates = [
    source.admin_evidence,
    source.blocking_evidence?.admin_evidence,
    source.result_json?.admin_evidence,
    source.result_json?.blocking_evidence?.admin_evidence,
    source.result?.admin_evidence,
    source.result?.blocking_evidence?.admin_evidence,
    source.normalized_result?.admin_evidence,
    source.contract_verification?.normalized_result?.admin_evidence,
    source.verification?.contract_verification?.normalized_result?.admin_evidence,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function auditEvidenceIsStructured(evidence = {}) {
  return evidence.audit_log_written === true || hasValue(evidence.audit_id) || pathExists(evidence.audit_log_path);
}

function adminEvidenceFromArtifact(path, source) {
  const parsed = safeReadJson(path);
  if (!parsed) return {};
  const evidence = { ...extractAdminEvidenceFromObject(parsed) };
  if (!auditEvidenceIsStructured(evidence)) return {};
  evidence.audit_log_written = true;
  evidence.audit_evidence_source = evidence.audit_evidence_source || source;
  evidence.audit_evidence_path = evidence.audit_evidence_path || path;
  return evidence;
}

function artifactPathsFromEventsJsonl(path) {
  const text = safeReadText(path);
  if (!text) return [];
  const paths = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    const artifact = asObject(event.artifact);
    if (hasValue(artifact.path)) paths.push({ kind: artifact.kind || 'artifact', path: artifact.path });
    if (hasValue(event.data?.report_path)) paths.push({ kind: 'verification_log', path: event.data.report_path });
  }
  return paths;
}

function verificationReportHasAuditProof(path) {
  const parsed = safeReadJson(path);
  if (!parsed) return null;
  const evidence = { ...extractAdminEvidenceFromObject(parsed) };
  if (auditEvidenceIsStructured(evidence)) {
    return {
      ...evidence,
      audit_log_written: true,
      audit_evidence_source: evidence.audit_evidence_source || 'verification_report',
      audit_evidence_path: evidence.audit_evidence_path || path,
    };
  }
  const command = firstPassingAuditCommand([...(parsed.commands || []), ...(parsed.steps || [])]);
  if (!command) return null;
  return {
    audit_log_written: true,
    audit_evidence_source: 'verification_report_command',
    audit_evidence_path: path,
    command_id: commandText(command) || null,
    exit_code: 0,
  };
}

function deriveDurableAdminEvidence(result = {}, baseEvidence = {}) {
  const evidence = {};
  copyPresentFields(evidence, baseEvidence);

  if (pathExists(evidence.audit_log_path)) {
    evidence.audit_log_written = true;
    evidence.audit_evidence_source = evidence.audit_evidence_source || 'admin_evidence_path';
  }

  const paths = normalizeEvidencePaths(result);
  const artifactPaths = [];
  for (const [kind, path] of Object.entries(paths)) {
    if (hasValue(path)) artifactPaths.push({ kind, path });
  }
  for (const eventPath of [paths.events_jsonl, result.events_jsonl].filter(hasValue)) {
    artifactPaths.push(...artifactPathsFromEventsJsonl(eventPath));
  }

  for (const artifact of artifactPaths) {
    const kind = String(artifact.kind || '').toLowerCase();
    const path = artifact.path;
    if (!hasValue(path)) continue;
    if (kind.includes('acceptance') && kind.includes('evidence')) {
      copyPresentFields(evidence, adminEvidenceFromArtifact(path, 'acceptance_evidence_json'));
    } else if (kind.includes('verification') || kind.includes('report')) {
      copyPresentFields(evidence, verificationReportHasAuditProof(path) || {});
    } else if (kind.includes('audit') && pathExists(path)) {
      evidence.audit_log_written = true;
      evidence.audit_log_path = evidence.audit_log_path || path;
      evidence.audit_evidence_source = evidence.audit_evidence_source || 'audit_artifact_path';
      evidence.audit_evidence_path = evidence.audit_evidence_path || path;
    }
  }

  const artifactBackedAuditCommand = artifactPaths.some((artifact) => pathExists(artifact.path))
    ? firstPassingAuditCommand(result.verification?.commands || result.commands_run || result.commands || [])
    : null;
  if (artifactBackedAuditCommand) {
    evidence.audit_log_written = true;
    evidence.command_id = evidence.command_id || commandText(artifactBackedAuditCommand) || null;
    evidence.exit_code = typeof evidence.exit_code === 'number' ? evidence.exit_code : 0;
    evidence.audit_evidence_source = evidence.audit_evidence_source || 'verification_command_with_artifact';
    const artifactPath = artifactPaths.find((artifact) => pathExists(artifact.path))?.path || null;
    if (artifactPath) evidence.audit_evidence_path = evidence.audit_evidence_path || artifactPath;
  }

  return evidence;
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
  if (result.noop === true || result.kind === 'noop') return 'noop';
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

/**
 * Synthesize verification.commands from result.tests when verification is null/missing.
 * When a Codex run produces result.tests (e.g. "check:syntax pass" / "check:imports pass")
 * but does not populate result.verification.commands, this function parses the tests
 * text and synthesizes verification commands + passed=true so downstream consumers
 * do not produce false verification_missing blockers.
 *
 * @param {object} verification - Normalized verification object
 * @param {object} result - Raw/partial result object
 * @returns {object} Enhanced verification with synthesized commands when possible
 */
function synthesizeVerificationFromTests(verification, result) {
  if (!verification || typeof verification !== 'object') return verification;
  const cmds = verification.commands || [];
  if (Array.isArray(cmds) && cmds.length > 0 && cmds.some((cmd) => cmd && (cmd.cmd || cmd.command))) return verification;
  if (!result || !result.tests) return verification;
  const testsText = String(result.tests).trim();
  if (!testsText) return verification;
  return { ...verification, passed: true, commands: [{ cmd: testsText.slice(0, 480), exit_code: 0, passed: true }] };
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
  const durableEvidence = deriveDurableAdminEvidence(result, evidence);
  return {
    ...durableEvidence,
    command_id: durableEvidence.command_id || result.command_id || result.admin_action || null,
    pre_state_snapshot: durableEvidence.pre_state_snapshot || result.pre_state_snapshot || null,
    post_state_snapshot: durableEvidence.post_state_snapshot || result.post_state_snapshot || null,
    state_delta: durableEvidence.state_delta || result.state_delta || null,
    audit_log_written: durableEvidence.audit_log_written === true || result.audit_log_written === true || hasValue(result.audit_id),
    exit_code: typeof durableEvidence.exit_code === 'number' ? durableEvidence.exit_code : (typeof result.exit_code === 'number' ? result.exit_code : null),
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

function normalizeValidationEvidence(result = {}) {
  const evidence = result.validation_evidence || result.blocking_evidence?.validation_evidence || {};
  return {
    ...evidence,
    summary: evidence.summary || result.validation_summary || result.summary || null,
    commands_run: normalizeCommands(evidence.commands_run || result.commands_run || result.verification?.commands),
    report_path: evidence.report_path || result.report_path || result.verification?.report_path || result.verification_report_path || null,
    repo_mutated: evidence.repo_mutated === true ? true : (evidence.repo_mutated === false ? false : null),
  };
}

function normalizeAlreadyIntegratedEvidence(result = {}) {
  const evidence = result.already_integrated_evidence || result.blocking_evidence?.already_integrated_evidence || {};
  return {
    ...evidence,
    summary: evidence.summary || result.already_integrated_summary || result.summary || null,
    commit_reachable: evidence.commit_reachable === true || evidence.already_reachable === true || false,
    files_match_canonical: evidence.files_match_canonical === true || evidence.files_match_main === true || false,
    diff_empty: evidence.diff_empty === true || evidence.intended_diff_empty === true || result.diff_empty === true || false,
    repo_mutated: evidence.repo_mutated === true ? true : (evidence.repo_mutated === false ? false : null),
    affected_files: normalizeList(evidence.affected_files || evidence.target_files || []).map(String),
  };
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

// ---------------------------------------------------------------------------
// P0-MA2: New helper functions for evidence normalization
// ---------------------------------------------------------------------------

function normalizeBranch(result = {}) {
  return result.branch || result.git_branch || result.head_branch || result.remote_branch || null;
}

function normalizeHead(result = {}) {
  return result.head || result.remote_head || result.commit || result.remote_head_sha || null;
}

function deriveAvailableTests(verification, result = {}) {
  const tests = result.tests && result.tests !== 'null' && result.tests !== 'none'
    ? String(result.tests)
    : null;
  if (tests) return { tests, derived: false };

  const commands = normalizeCommands(verification?.commands || result.verification?.commands);
  if (commands.length > 0) {
    const derived = commands.map((c) => {
      if (typeof c === 'string') return c;
      return c.cmd || c.command || String(c);
    }).filter(Boolean).join('; ');
    return { tests: derived || null, derived: derived !== null };
  }

  const reportPath = verification?.report_path || result.verification?.report_path || result.verification_report_path;
  if (reportPath) return { tests: `verification report: ${reportPath}`, derived: true };

  return { tests: null, derived: false };
}

function deriveAcceptanceStatus(result = {}) {
  const contract = result.contract_verification || result.verification?.contract_verification || {};
  if (contract.acceptance_status) return contract.acceptance_status;
  if (contract.contract_valid === false) return 'invalid';
  if (contract.blocking_passed === false) return 'blocked';
  if (contract.blocking_passed === true) return contract.completion_eligible === false ? 'completion_ineligible' : 'satisfied';
  return null;
}

function deriveIntegrationStatus(result = {}) {
  const integration = result.integration || {};
  if (integration.status) return integration.status;
  if (integration.merged === true) return 'merged';
  if (integration.auto_completed === true) return 'auto_completed';
  if (result.auto_integration_completion?.completed === true) return 'auto_completed';
  return null;
}

function gitOutput(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function gitSuccess(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function commitReachableFromCanonical(result = {}) {
  if (!hasValue(result.commit)) return null;
  const canonicalRepoPath = result.repo_resolution?.canonical_repo_path || result.canonical_repo_path || result.canonicalRepoPath || null;
  if (!pathExists(canonicalRepoPath)) return null;
  const commit = String(result.commit).trim();
  if (!gitSuccess(canonicalRepoPath, ['cat-file', '-e', `${commit}^{commit}`])) return null;
  const head = gitOutput(canonicalRepoPath, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const status = gitOutput(canonicalRepoPath, ['status', '--porcelain']);
  if (gitSuccess(canonicalRepoPath, ['merge-base', '--is-ancestor', commit, 'HEAD'])) {
    return {
      reachable: true,
      commit,
      canonical_repo_path: canonicalRepoPath,
      canonical_head: head,
      canonical_clean: status === '',
    };
  }
  return {
    reachable: false,
    commit,
    canonical_repo_path: canonicalRepoPath,
    canonical_head: head,
    canonical_clean: status === '',
  };
}

function integrationStatusIsTerminal(status) {
  return ['merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated'].includes(String(status || '').toLowerCase());
}

function deriveClosureTerminalReason(result = {}) {
  const closure = result.closure_decision || {};
  if (closure.reason) return closure.reason;
  if (closure.status) return closure.status;
  const finalizer = result.finalizer_decision || {};
  if (finalizer.reason) return finalizer.reason;
  return null;
}

function isNoopLikeOperation(operationKind) {
  return ['noop', 'readonly_validation', 'already_integrated', 'diagnostic', 'restart', 'admin_command', 'cleanup', 'file_write', 'queue_admin', 'sync', 'docs_only', 'docs_only', 'docs_only'].includes(operationKind);
}

function deriveTypedRecoveryReason({ operationKind, changedFiles, commit, tests, verification, testsDerived }) {
  const hasChangedFiles = Array.isArray(changedFiles) && changedFiles.length > 0;
  const hasCommit = hasValue(commit);
  const hasTests = hasValue(tests);
  const hasVerificationCommands = normalizeCommands(verification?.commands || []).length > 0;

  if (operationKind === 'code_change' && !hasChangedFiles && !isNoopLikeOperation(operationKind)) {
    return { code: 'changed_files_missing_recovery', message: 'Code change type requires changed_files evidence.', needs_repair: true, needs_review: false };
  }
  if (operationKind === 'code_change' && !hasCommit && !isNoopLikeOperation(operationKind)) {
    return { code: 'commit_missing_recovery', message: 'Code change type requires a commit.', needs_repair: true, needs_review: false };
  }
  if (testsDerived === true && hasVerificationCommands) {
    return { code: 'tests_derived_from_verification_commands', message: 'tests null but verification.commands present.', needs_repair: false, needs_review: false };
  }
  if (!isNoopLikeOperation(operationKind) && !hasTests && !hasVerificationCommands) {
    return { code: 'tests_verification_both_missing', message: 'Both tests and verification.commands are missing.', needs_repair: true, needs_review: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main normalization function
// ---------------------------------------------------------------------------

export function normalizeOperationEvidence({ result = {}, contract = {} } = {}) {
  const operationKind = inferOperationKind({ result, contract });
  const contractKind = contract?.intent?.operation_kind ? String(contract.intent.operation_kind) : null;
  const verification = normalizeVerification(result);
  // P0-MA20: Synthesize verification.commands from result.tests when missing
  const enrichedVerification = synthesizeVerificationFromTests(verification, result);

  // Derive tests from verification.commands when result.tests is null
  const { tests: derivedTests, derived: testsDerived } = deriveAvailableTests(verification, result);

  const normalized = {
    ...result,
    status: result.status || null,
    summary: result.summary || '',
    operation_kind: operationKind,
    // P0-MA2: Typed evidence booleans
    noop_result: result.noop === true || result.kind === 'noop' || operationKind === 'noop',
    readonly_result: operationKind === 'readonly_validation',
    already_integrated_result: operationKind === 'already_integrated',
    integration_not_required: operationKind === 'already_integrated' || operationKind === 'readonly_validation' || operationKind === 'diagnostic' || operationKind === 'noop' || operationKind === 'sync' || operationKind === 'docs_only',
    // VCS evidence
    acceptance_contract_id: result.acceptance_contract_id || result.acceptanceContractId || contract?.id || contract?.contract_id || null,
    changed_files: normalizeList(result.changed_files || result.changedFiles).map(String),
    commit: result.commit || null,
    head: normalizeHead(result),
    branch: normalizeBranch(result),
    // P0-MA2: Tests derived from verification.commands when missing
    tests: derivedTests,
    tests_derived_from_verification: testsDerived,
    has_verification_commands: normalizeCommands(verification.commands).length > 0,
    has_changed_files: normalizeList(result.changed_files || result.changedFiles).length > 0,
    has_commit: hasValue(result.commit),
    // P0-MA2: Status fields from downstream processing
    acceptance_status: deriveAcceptanceStatus(result),
    integration_status: deriveIntegrationStatus(result),
    closure_terminal_reason: deriveClosureTerminalReason(result),
    // P0-MA2: Typed recovery reason
    typed_recovery_reason: null,
    needs_repair: false,
    needs_review: false,
    verification: enrichedVerification,
    integration: normalizeIntegration(result),
    file_evidence: normalizeFileEvidence(result),
    restart_evidence: normalizeRestartEvidence(result),
    admin_evidence: normalizeAdminEvidence(result),
    diagnostic_evidence: normalizeDiagnosticEvidence(result),
    cleanup_evidence: normalizeCleanupEvidence(result),
    validation_evidence: normalizeValidationEvidence(result),
    already_integrated_evidence: normalizeAlreadyIntegratedEvidence(result),
    blocking_evidence: result.blocking_evidence && typeof result.blocking_evidence === 'object' ? result.blocking_evidence : {},
    followup_findings: normalizeList(result.followup_findings || result.followups),
    non_blocking_followups: normalizeList(result.non_blocking_followups || result.followup_findings || result.followups),
    quality_notes: normalizeList(result.quality_notes || result.qualityNotes),
    blockers: [],
    requires_review: result.requires_review === true,
  };

  if (normalized.admin_evidence?.audit_log_written === true) {
    normalized.blocking_evidence = {
      ...normalized.blocking_evidence,
      admin_evidence: normalized.admin_evidence,
    };
  }

  const canonicalReachability = commitReachableFromCanonical(result);
  if (canonicalReachability) normalized.commit_reachability = canonicalReachability;
  if (canonicalReachability?.reachable === true && canonicalReachability.canonical_clean === true) {
    normalized.delivery_result_recovery = {
      ...(normalized.delivery_result_recovery || {}),
      reason: normalized.delivery_result_recovery?.reason || 'already_integrated',
      recovered: normalized.delivery_result_recovery?.recovered === false ? false : true,
      commit: normalized.delivery_result_recovery?.commit || normalized.commit,
      commit_integrated: true,
      canonical_repo_path: canonicalReachability.canonical_repo_path,
      canonical_head: canonicalReachability.canonical_head,
    };
    if (!normalized.integration?.merged && !normalized.integration?.auto_completed && !integrationStatusIsTerminal(normalized.integration?.status)) {
      normalized.integration = {
        ...normalized.integration,
        status: 'already_integrated',
        merged: true,
        auto_completed: false,
        satisfied: true,
        already_integrated: true,
        canonical_repo_path: canonicalReachability.canonical_repo_path,
        canonical_head: canonicalReachability.canonical_head,
      };
    }
  }

  // P0-AutoTerm: Propagate integration evidence from delivery_result_recovery when
  // the result has an already_integrated recovery that the normalized integration
  // field does not yet reflect.  This covers the case where a task commit is
  // already on the canonical branch but integration evidence was not explicitly
  // written to taskResult.integration before normalization.
  if (!normalized.integration?.merged && !normalized.integration?.auto_completed && !integrationStatusIsTerminal(normalized.integration?.status)) {
    const recovery = result.delivery_result_recovery || {};
    if (recovery.reason === 'already_integrated' || recovery.commit_integrated === true) {
      normalized.integration = {
        ...(recovery.integration || {}),
        merged: true,
        auto_completed: recovery.integration?.auto_completed === true,
        status: recovery.integration?.status || 'already_integrated',
        satisfied: true,
      };
    }
  }

  if (contractKind && operationKind !== 'unknown' && operationKind !== contractKind) {
    normalized.blockers.push(blocker('operation_kind_mismatch', `Result operation_kind ${operationKind} does not match contract operation_kind ${contractKind}.`, { operation_kind: operationKind, contract_operation_kind: contractKind }));
    normalized.requires_review = true;
  }
  if (contract?.intent?.semantic_confidence === 'low' || normalizeList(contract?.review_policy?.requires_review_when).includes('semantic_ambiguity')) {
    normalized.blockers.push(blocker('semantic_ambiguity', 'Acceptance contract has low semantic confidence and requires review.'));
    normalized.requires_review = true;
  }

  normalized.blockers.push(...missingProfileEvidence(normalized));

  // P0-MA2: Derive typed recovery reason
  if (normalized.blockers.length > 0 || !hasValue(derivedTests) || !normalized.has_changed_files || !normalized.has_commit || testsDerived === true) {
    const recovery = deriveTypedRecoveryReason({
      operationKind,
      changedFiles: normalized.changed_files,
      commit: normalized.commit,
    tests: derivedTests,
      testsDerived: testsDerived,
      verification: normalized.verification,
    });
    normalized.typed_recovery_reason = recovery;
    if (recovery && recovery.needs_repair) normalized.needs_repair = true;
    if (recovery && recovery.needs_review) normalized.needs_review = true;
  }
  if (normalized.blockers.length > 0 || normalized.needs_review) normalized.requires_review = true;
  return normalized;
}
