const TERMINAL_INTEGRATION_STATUSES = new Set(['merged', 'ff_only_merged', 'skipped', 'not_required']);

// P0-MA22: No-mutation profile set — tasks where changed_files=[] is a
// legitimate terminal state (sync-only, verification-only, diagnostic, etc.).
const NO_MUTATION_PROFILES = new Set([
  'diagnostic', 'noop', 'readonly_validation', 'already_integrated',
  'repair_noop', 'network_retry', 'verification_only', 'sync_only',
  'github_sync_only',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function bool(value) {
  return value === true;
}

function compactStrings(values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function textOf({ task = {}, result = {}, integrationResult = {} } = {}) {
  return compactStrings([
    task.title,
    task.summary,
    task.description,
    result.summary,
    result.reason,
    result.noop_reason,
    result.kind,
    result.operation_kind,
    result.acceptance_profile,
    result.convergence?.profile,
    integrationResult.reason,
    integrationResult.status,
  ]).join('\n').toLowerCase();
}

function hasRepairContext(task = {}, result = {}) {
  if (task.repair_of_task_id || task.repair_of_goal_id || task.parent_task_id || task.root_task_id) return true;
  if (result.repair_of_task_id || result.repair_of_goal_id || result.parent_task_id || result.root_task_id) return true;
  if (/^\s*repair\b/i.test(String(task.title || result.title || ''))) return true;
  return false;
}

function hasDiagnosticContext(task = {}, result = {}) {
  // P0-MA22: No-mutation tasks (sync-only, verification-only, diagnostic,
  // noop, already-integrated, etc.) with empty changed_files should be
  // treated as first-class valid completions, not missing-evidence failures.
  const operationKind = result.operation_kind || task.operation_kind || '';
  const mutationScope = result.mutation_scope || task.mutation_scope || '';
  const profile = result.acceptance_profile || '';
  const contract = result.acceptance_contract || task.acceptance_contract || {};
  const contractKind = contract.intent?.operation_kind || '';
  // P0-MA22: Use the no-mutation profile set.  Only check explicit profile/kind
  // markers.  Generic flags like needs_integration or closure_type are not reliable
  // for identifying no-mutation contexts.
  return NO_MUTATION_PROFILES.has(operationKind)
    || NO_MUTATION_PROFILES.has(profile)
    || NO_MUTATION_PROFILES.has(contractKind)
    || mutationScope === 'none';
}

function hasDiagnosticOutcomeEvidence({ task = {}, result = {}, integrationResult = {} } = {}) {
  // For diagnostic tasks, outcome evidence is the no_mutation and
  // diagnostic_report specified in the acceptance contract.
  if (bool(result.no_mutation) || result.repo_mutated === false) return true;
  if (result.kind === 'diagnostic_report' || result.acceptance_profile === 'diagnostic') return true;
  if (bool(result.diagnostic_evidence?.report) || bool(result.diagnostic_evidence?.findings)) return true;
  if (bool(result.no_mutation_evidence) || bool(result.diagnostic_report)) return true;
  const text = textOf({ task, result, integrationResult });
  return /diagnostic[_ ]?report|no[_ ]mutation|readonly[_ ]?analysis|no code changes needed/.test(text);
}


function hasOutcomeMarker({ task = {}, result = {}, integrationResult = {} } = {}) {
  const evidence = asObject(result.no_change_repair_evidence || result.no_change_repair || result.already_integrated_evidence);
  if (bool(result.repair_noop) || bool(result.already_integrated) || bool(result.no_code_changes_needed)) return true;
  if (result.kind === 'repair_noop' || result.acceptance_profile === 'repair_noop' || result.convergence?.profile === 'repair_noop') return true;
  if (bool(evidence.repair_noop) || bool(evidence.already_integrated) || bool(evidence.no_code_changes_needed)) return true;
  if (bool(integrationResult.already_integrated) || bool(integrationResult.noop_repair)) return true;
  const text = textOf({ task, result, integrationResult });
  return /already[-_ ]integrated|already in main|no code changes needed|no changes needed|existing main state|conflict resolved by existing main|repair[_ -]?noop/.test(text);
}

function verificationPassed(result = {}) {
  const verification = asObject(result.verification || result.final_verification);
  if (verification.passed === true) return true;
  if (result.auto_integration_completion?.completed === true && result.auto_integration_completion?.verification_report?.passed !== false) return true;
  return false;
}

function acceptancePassed(result = {}) {
  const reviewer = asObject(result.reviewer_decision);
  const acceptance = asObject(result.acceptance_gate || result.acceptance);
  if (acceptance.passed === true || acceptance.status === 'accepted') return true;
  if (reviewer.passed === true || reviewer.status === 'accepted' || reviewer.decision === 'accepted') return true;
  if (reviewer.decision?.passed === true || reviewer.decision?.status === 'accepted' || reviewer.decision?.decision === 'accepted') return true;
  return false;
}

function unresolvedBlockers(result = {}) {
  return [
    ...list(result.acceptance_findings),
    ...list(result.findings),
    ...list(result.verification?.findings),
  ].filter((finding) => finding?.resolved !== true && (finding?.severity === 'blocker' || finding?.severity === 'major'));
}

function integrationSatisfied(result = {}, integrationResult = {}) {
  const integration = asObject(result.integration || integrationResult);
  if (result.needs_integration === false) return true;
  if (integration.required === false || integration.satisfied === true || integration.merged === true || integration.auto_completed === true) return true;
  if (result.auto_integration_completion?.completed === true && result.auto_integration_completion?.verification_report?.passed !== false) return true;
  return TERMINAL_INTEGRATION_STATUSES.has(String(integration.status || '').toLowerCase());
}

function evidenceObject(result = {}) {
  return asObject(result.no_change_repair_evidence || result.no_change_repair || result.already_integrated_evidence);
}

function affectedFiles(result = {}) {
  return [
    ...list(result.affected_files),
    ...list(result.original_target_files),
    ...list(result.target_files),
    ...list(evidenceObject(result).affected_files),
    ...list(evidenceObject(result).original_target_files),
    ...list(evidenceObject(result).target_files),
  ].map(String).filter(Boolean);
}

function targetEvidence(result = {}, integrationResult = {}) {
  const evidence = evidenceObject(result);
  const files = affectedFiles(result);
  const filesMatchCanonical = bool(evidence.files_match_canonical)
    || bool(evidence.affected_files_match_main)
    || bool(evidence.files_match_main)
    || bool(result.files_match_canonical)
    || bool(result.affected_files_match_main);
  const commitReachable = bool(evidence.commit_reachable)
    || bool(evidence.task_commit_reachable)
    || bool(evidence.already_reachable)
    || bool(result.commit_reachable)
    || bool(result.task_commit_reachable)
    || bool(integrationResult.already_integrated);
  const diffEmpty = bool(evidence.diff_empty)
    || bool(evidence.intended_diff_empty)
    || bool(result.diff_empty)
    || bool(result.intended_diff_empty)
    || result.diff_summary === 'empty'
    || result.diff === '';
  return {
    affected_files: [...new Set(files)],
    files_match_canonical: filesMatchCanonical,
    commit_reachable: commitReachable,
    diff_empty: diffEmpty,
    present: filesMatchCanonical || commitReachable || diffEmpty,
  };
}

export function classifyNoChangeRepairOutcome({ task = {}, taskResult = {}, result = taskResult, integrationResult = taskResult.integration || {} } = {}) {
  const changedFiles = list(result.changed_files);
  const target = targetEvidence(result, integrationResult);
  const repairContext = hasRepairContext(task, result);
  const outcomeMarker = hasOutcomeMarker({ task, result, integrationResult });
  const diagnosticContext = hasDiagnosticContext(task, result);
  const diagnosticOutcome = diagnosticContext ? hasDiagnosticOutcomeEvidence({ task, result, integrationResult }) : false;
  const verification = verificationPassed(result);
  const acceptance = acceptancePassed(result);
  const unresolved = unresolvedBlockers(result);
  const integration = integrationSatisfied(result, integrationResult);
  const blockers = [];

  // Diagnostic/no-mutation tasks should be treated as first-class completions
  // when they have proper diagnostic outcome evidence.  The repair-task-only
  // restrictions do not apply because diagnostic tasks are explicitly
  // recognized as valid changed_files=[]
  const isDiagnosticCompletion = diagnosticContext && diagnosticOutcome && changedFiles.length === 0;
  const repairOrDiagnostic = repairContext || isDiagnosticCompletion;

  if (changedFiles.length > 0) blockers.push({ code: 'changed_files_present', message: 'No-change repair completion only applies when changed_files is empty.' });
  if (!repairOrDiagnostic) blockers.push({ code: 'repair_context_missing', message: 'Task is not a repair task nor a diagnostic task.' });
  if (!repairOrDiagnostic && !outcomeMarker) blockers.push({ code: 'no_change_outcome_missing', message: 'No deterministic repair_noop or already-integrated outcome marker is present.' });
  if (!repairOrDiagnostic && !target.present) blockers.push({ code: 'already_integrated_target_evidence_missing', message: 'No commit reachability, empty intended diff, or canonical file-match evidence is present.' });
  // For diagnostic completions, verification is optional (contract says
  // required_commands=[] and report_must_be_clean=false).
  if (!isDiagnosticCompletion && !verification) blockers.push({ code: 'verification_not_passed', message: 'No passed verification evidence is present.' });
  if (!acceptance) blockers.push({ code: 'acceptance_not_passed', message: 'No accepted reviewer or acceptance verdict is present.' });
  if (unresolved.length > 0) blockers.push({ code: 'unresolved_blockers_present', message: 'Unresolved blocker or major findings are present.', findings: unresolved });
  if (!integration) blockers.push({ code: 'integration_not_satisfied', message: 'Integration is still required and is not terminal.' });

  const alreadyIntegrated = target.commit_reachable || target.files_match_canonical || bool(result.already_integrated) || bool(integrationResult.already_integrated);
  return {
    kind: alreadyIntegrated ? 'already_integrated' : 'repair_noop',
    is_no_change_repair: repairContext && outcomeMarker && changedFiles.length === 0,
    completion_eligible: blockers.length === 0,
    reason: blockers.length === 0 ? 'no_change_repair_evidence_satisfied' : blockers[0].code,
    blockers,
    evidence: {
      repair_context: repairContext,
      outcome_marker: outcomeMarker,
      changed_files_empty: changedFiles.length === 0,
      verification_passed: verification,
      acceptance_passed: acceptance,
      unresolved_blockers: unresolved,
      integration_satisfied: integration,
      ...target,
    },
  };
}
