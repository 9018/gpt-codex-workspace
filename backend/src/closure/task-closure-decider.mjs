import { normalizeList } from '../acceptance/contract-schema.mjs';
import { CLOSURE_STATUSES, mapClosureStatusToTaskStatus, closureAllowsAutoComplete } from './auto-progress-policy.mjs';
import { healthPassed } from '../evidence/operation-evidence-profiles.mjs';

export { CLOSURE_STATUSES, mapClosureStatusToTaskStatus, closureAllowsAutoComplete };

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function blocker(code, message, evidence = {}, source = 'task_closure_decider') {
  return { severity: 'blocker', code, message, source, evidence };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function statusDecision({ status, reason, blockingPassed = false, blockers = [], repairableBlockers = [], followups = [], qualityNotes = [], config = {} }) {
  const autoCompleteAllowed = closureAllowsAutoComplete(status);
  return {
    status,
    reason,
    blocking_passed: blockingPassed,
    quality_followups_count: followups.length + qualityNotes.length,
    auto_complete_allowed: autoCompleteAllowed,
    requires_human_decision: status === CLOSURE_STATUSES.REQUIRES_REVIEW,
    task_status: mapClosureStatusToTaskStatus(status, config),
    blockers,
    repairable_blockers: repairableBlockers,
    non_blocking_followups: followups,
    quality_notes: qualityNotes,
  };
}

function contractRequires(contract = {}, key) {
  return contract?.requirements?.[key] === true || contract?.completion_policy?.[key] === true;
}

function semanticAmbiguous(contract = {}, contractVerification = {}) {
  const reviewWhen = normalizeList(contract?.review_policy?.requires_review_when).map(String);
  return contract?.intent?.semantic_confidence === 'low'
    || reviewWhen.includes('semantic_ambiguity')
    // P0-AFC3: acceptance_status no longer produces 'indeterminate' independently.
    // Semantic ambiguity is detected via semantic_confidence and review_policy.
    || contractVerification.semantic_ambiguity === true;
}

function integrationIsSatisfied(integration = {}, result = {}) {
  const source = { ...asObject(result.integration), ...asObject(integration) };
  if (source.satisfied === true) return true;
  if (source.merged === true || source.auto_completed === true) return true;
  const status = String(source.status || '').toLowerCase();
  return ['merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated'].includes(status);
}

function postMergeVerificationPassed(integration = {}, result = {}, verification = {}) {
  const source = { ...asObject(result.integration), ...asObject(integration) };
  if (!integrationIsSatisfied(source, result)) return false;
  if (source.post_merge_verification?.passed === true) return true;
  if (result.auto_integration_completion?.completed === true) {
    if (result.auto_integration_completion.verification_report?.passed === false) return false;
    return true;
  }
  return verification?.passed === true || result.final_verification?.passed === true || result.verification?.passed === true;
}

function deploymentEvidence(result = {}, deployment = {}) {
  return asObject(deployment).status ? asObject(deployment) : asObject(result.deployment || result.runtime || result.restart_evidence || {});
}

function deploymentSatisfied({ contract = {}, result = {}, deployment = {} } = {}) {
  const evidence = deploymentEvidence(result, deployment);
  if (evidence.satisfied === true) return true;
  if (evidence.deployment_satisfied === true) return true;
  if (result.deployment_satisfied === true) return true;
  if (!contractRequires(contract, 'requires_deployment') && !contractRequires(contract, 'requires_runtime_health')) return true;

  const health = evidence.health_check || result.health_check || result.restart_evidence?.health_check || result.runtime?.health_check;
  if (!healthPassed(health || {})) return false;
  if (contractRequires(contract, 'requires_runtime_version') || contractRequires(contract, 'requires_runtime_health')) {
    const expected = evidence.expected_commit || result.expected_commit || result.commit || result.restart_evidence?.expected_commit;
    const running = evidence.running_commit || result.running_commit || result.runtime?.running_commit || result.restart_evidence?.running_commit;
    const runtimeMatches = evidence.runtime_commit_matches === true
      || result.restart_evidence?.runtime_commit_matches === true
      || (hasValue(expected) && hasValue(running) && expected === running);
    return runtimeMatches;
  }
  return true;
}

function operationSafetyBlockers({ contract = {}, result = {} } = {}) {
  const operationKind = String(result.operation_kind || contract?.intent?.operation_kind || 'unknown');
  const blockers = [];

  if (operationKind === 'restart' && contractRequires(contract, 'requires_runtime_health')) {
    if (!deploymentSatisfied({ contract, result })) {
      blockers.push(blocker('deployment_health_unsatisfied', 'Runtime health and version evidence did not satisfy restart completion.', { operation_kind: operationKind }));
    }
  }
  if ((operationKind === 'diagnostic' || operationKind === 'readonly_validation' || operationKind === 'already_integrated') && contractRequires(contract, 'requires_no_mutation')) {
    const evidenceKey = operationKind === 'diagnostic' ? 'diagnostic_evidence' : operationKind === 'readonly_validation' ? 'validation_evidence' : 'already_integrated_evidence';
    const noMutation = result.no_mutation === true || result.repo_mutated === false || (result[evidenceKey]?.repo_mutated === false);
    if (!noMutation) blockers.push(blocker('no_mutation_evidence_missing', operationKind + ' completion requires no-mutation evidence.', { operation_kind: operationKind }));
  }
  if (operationKind === 'queue_admin' && contractRequires(contract, 'requires_audit')) {
    const audit = result.audit_log_written === true || result.queue_admin_evidence?.audit_log_written === true || hasValue(result.audit_id);
    if (!audit) blockers.push(blocker('audit_evidence_missing', 'Queue admin completion requires audit evidence.', { operation_kind: operationKind }));
  }
  if (operationKind === 'admin_command' && contractRequires(contract, 'requires_audit')) {
    const audit = result.audit_log_written === true || result.admin_evidence?.audit_log_written === true || hasValue(result.audit_id);
    if (!audit) blockers.push(blocker('audit_evidence_missing', 'Admin command completion requires audit evidence.', { operation_kind: operationKind }));
  }
  return blockers;
}

function repairableFromContractBlockers(contractBlockers = []) {
  const repairableCodes = new Set([
    'verification_not_passed',
    'verification_command_failed',
    'verification_command_missing',
    'integration_completed_missing',
    'changed_files_reported_missing',
    'diff_reported_missing',
  ]);
  return contractBlockers.filter((entry) => repairableCodes.has(entry?.code));
}

function mergeNextTasks(existing = [], planned = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(planned) ? planned : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = `${item.title || ''}\n${item.reason || ''}\n${item.source_task_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function applyClosureDecisionToTaskResult({ taskStatus, taskResult = {}, closureDecision = {}, plannedFollowups = [], config = {} } = {}) {
  const mappedStatus = closureDecision.task_status || mapClosureStatusToTaskStatus(closureDecision.status, config);
  const nextTaskResult = { ...taskResult, closure_decision: closureDecision };

  if (closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN || closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS) {
    nextTaskResult.requires_review = false;
    nextTaskResult.reason = closureDecision.reason;
    nextTaskResult.next_tasks = mergeNextTasks(nextTaskResult.next_tasks, plannedFollowups);
    return { taskStatus: mappedStatus, taskResult: nextTaskResult };
  }
  if (closureDecision.status === CLOSURE_STATUSES.REQUIRES_REVIEW) {
    nextTaskResult.requires_review = true;
    nextTaskResult.reason = closureDecision.reason;
    return { taskStatus: mappedStatus, taskResult: nextTaskResult };
  }
  if (closureDecision.status === CLOSURE_STATUSES.WAITING_FOR_REPAIR) {
    nextTaskResult.requires_review = nextTaskResult.requires_review === true ? true : false;
    nextTaskResult.reason = closureDecision.reason;
    return { taskStatus: mappedStatus, taskResult: nextTaskResult };
  }
  if (closureDecision.status === CLOSURE_STATUSES.FAILED) {
    nextTaskResult.reason = closureDecision.reason;
    return { taskStatus: mappedStatus, taskResult: nextTaskResult };
  }
  return { taskStatus, taskResult: nextTaskResult };
}

export function decideTaskClosure({
  contract = null,
  contractVerification = null,
  verification = null,
  integration = null,
  deployment = null,
  result = {},
  task = {},
  config = {},
} = {}) {
  const contractObject = asObject(contract);
  const contractResult = asObject(contractVerification);
  const verifier = asObject(verification || result?.verification);
  const taskResult = asObject(result);
  const followups = [
    ...normalizeList(contractResult.non_blocking_followups),
    ...normalizeList(taskResult.non_blocking_followups),
    ...normalizeList(taskResult.followup_findings),
    ...normalizeList(taskResult.followups),
  ];
  const qualityNotes = [
    ...normalizeList(contractResult.quality_notes),
    ...normalizeList(taskResult.quality_notes),
  ];

  if (contractResult.contract_valid === false) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'contract_invalid',
      blockers: normalizeList(contractResult.blockers).length > 0 ? normalizeList(contractResult.blockers) : [blocker('contract_invalid', 'Acceptance contract is invalid.')],
      followups,
      qualityNotes,
      config,
    });
  }

  if (semanticAmbiguous(contractObject, contractResult)) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'semantic_ambiguity',
      blockers: [blocker('semantic_ambiguity', 'Acceptance semantics are ambiguous and require human review.', { task_id: task?.id || null })],
      followups,
      qualityNotes,
      config,
    });
  }

  if (verifier.passed === false) {
    const repairableBlockers = [blocker('verification_not_passed', 'Verification did not pass.', { findings: normalizeList(verifier.findings) })];
    return statusDecision({
      status: config.verificationFailureRequiresReview === true ? CLOSURE_STATUSES.REQUIRES_REVIEW : CLOSURE_STATUSES.WAITING_FOR_REPAIR,
      reason: 'verification_failed',
      blockers: config.verificationFailureRequiresReview === true ? repairableBlockers : [],
      repairableBlockers,
      followups,
      qualityNotes,
      config,
    });
  }

  if (contractResult.state_assertions?.passed === false) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'state_assertion_failed',
      blockers: normalizeList(contractResult.state_assertions.failures).map((failure) => blocker('state_assertion_failed', 'State assertion failed.', failure, 'state_assertion_runner')),
      followups,
      qualityNotes,
      config,
    });
  }

  const contractBlockers = normalizeList(contractResult.blockers);
  if (contractResult.blocking_passed === false || contractBlockers.length > 0 || contractResult.completion_eligible === false) {
    const repairableBlockers = repairableFromContractBlockers(contractBlockers);
    const status = repairableBlockers.length > 0 && repairableBlockers.length === contractBlockers.length
      ? CLOSURE_STATUSES.WAITING_FOR_REPAIR
      : CLOSURE_STATUSES.REQUIRES_REVIEW;
    return statusDecision({
      status,
      reason: status === CLOSURE_STATUSES.WAITING_FOR_REPAIR ? 'blocking_requirements_failed_repairable' : 'blocking_requirements_failed_requires_review',
      blockers: status === CLOSURE_STATUSES.REQUIRES_REVIEW ? contractBlockers : [],
      repairableBlockers: status === CLOSURE_STATUSES.WAITING_FOR_REPAIR ? repairableBlockers : [],
      followups,
      qualityNotes,
      config,
    });
  }

  if (contractRequires(contractObject, 'requires_commit') && !hasValue(taskResult.commit)) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'commit_evidence_missing',
      blockers: [blocker('commit_evidence_missing', 'Completion requires commit evidence.')],
      followups,
      qualityNotes,
      config,
    });
  }

  if (contractRequires(contractObject, 'requires_integration')) {
    if (!integrationIsSatisfied(integration, taskResult) || !postMergeVerificationPassed(integration, taskResult, verifier)) {
      // P0-C5: Differentiate integration_completed_missing from integration_unsatisfied.
      // When no integration status is set or it's explicitly unknown/pending, classify
      // as integration_completed_missing (a deterministic recovery path) rather than
      // a generic integration failure.
      const integrationStatus = String((integration || taskResult.integration || {}).status || '');
      const isMissingEvidence = integrationStatus === '' || integrationStatus === 'pending' || integrationStatus === 'queued' || integrationStatus === 'waiting';
      const blockerCode = isMissingEvidence ? 'integration_completed_missing' : 'integration_unsatisfied';
      const blockerMessage = isMissingEvidence
        ? 'Integration requirement is not satisfied because integration was never completed or attempted. Evidence is missing.'
        : 'Integration requirement is not satisfied by merged/post-merge verification evidence.';
      return statusDecision({
        status: CLOSURE_STATUSES.WAITING_FOR_REPAIR,
        reason: 'integration_unsatisfied',
        repairableBlockers: [blocker(blockerCode, blockerMessage, { integration: integration || taskResult.integration || null })],
        followups,
        qualityNotes,
        config,
      });
    }
  }

  if ((contractRequires(contractObject, 'requires_deployment') || contractRequires(contractObject, 'requires_runtime_health')) && !deploymentSatisfied({ contract: contractObject, result: taskResult, deployment })) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'deployment_unknown_or_unsatisfied',
      blockers: [blocker('deployment_health_unsatisfied', 'Deployment/runtime health evidence is missing or does not match required runtime/version evidence.')],
      followups,
      qualityNotes,
      config,
    });
  }

  const safetyBlockers = operationSafetyBlockers({ contract: contractObject, result: taskResult });
  if (safetyBlockers.length > 0) {
    return statusDecision({
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'operation_safety_evidence_missing',
      blockers: safetyBlockers,
      followups,
      qualityNotes,
      config,
    });
  }

  if (taskResult.status === 'failed') {
    return statusDecision({
      status: CLOSURE_STATUSES.FAILED,
      reason: 'result_failed',
      blockingPassed: false,
      blockers: [blocker('result_failed', taskResult.summary || 'Task result is failed.')],
      followups,
      qualityNotes,
      config,
    });
  }

  const hasFollowups = followups.length > 0 || qualityNotes.length > 0;
  return statusDecision({
    status: hasFollowups ? CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS : CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN,
    reason: hasFollowups ? 'blocking_gate_passed_with_non_blocking_followups' : 'blocking_gate_passed_clean',
    blockingPassed: true,
    followups,
    qualityNotes,
    config,
  });
}
