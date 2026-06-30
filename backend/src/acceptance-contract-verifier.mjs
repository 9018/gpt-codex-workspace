import { normalizeList } from './acceptance-contract-schema.mjs';
import { getDefaultAcceptanceContractProfile } from './acceptance-contract-profiles.mjs';
import { validateContractSemantics } from './acceptance-semantics.mjs';
import { normalizeOperationEvidence } from './evidence-normalizer.mjs';
import { getRequirementCheck } from './operation-evidence-profiles.mjs';

function blocker(code, message, evidence = {}, source = 'acceptance_contract_verifier') {
  return { severity: 'blocker', code, message, source, evidence };
}

function hasContract(contract) {
  return contract && typeof contract === 'object' && !Array.isArray(contract) && Object.keys(contract).length > 0;
}

function hydrateContract(contract = {}) {
  const kind = contract.intent?.operation_kind || 'noop';
  const defaults = getDefaultAcceptanceContractProfile(kind);
  return {
    ...defaults,
    ...contract,
    intent: { ...(defaults.intent || {}), ...(contract.intent || {}) },
    requirements: { ...(defaults.requirements || {}), ...(contract.requirements || {}) },
    verification_plan: { ...(defaults.verification_plan || {}), ...(contract.verification_plan || {}) },
    completion_policy: { ...(defaults.completion_policy || {}), ...(contract.completion_policy || {}) },
    review_policy: { ...(defaults.review_policy || {}), ...(contract.review_policy || {}) },
    blocking_requirements: normalizeList(contract.blocking_requirements).length > 0 ? contract.blocking_requirements : defaults.blocking_requirements,
    state_assertions: normalizeList(contract.state_assertions).length > 0 ? contract.state_assertions : defaults.state_assertions,
    non_blocking_quality_expectations: normalizeList(contract.non_blocking_quality_expectations).length > 0 ? contract.non_blocking_quality_expectations : defaults.non_blocking_quality_expectations,
  };
}

function normalizeFollowups(result = {}, contract = {}) {
  return [
    ...normalizeList(result.non_blocking_followups),
    ...normalizeList(result.followup_findings),
    ...normalizeList(result.followups),
    ...normalizeList(contract.non_blocking_followups),
  ];
}

function qualityNotes(result = {}, contract = {}) {
  return [
    ...normalizeList(result.quality_notes),
    ...normalizeList(result.qualityNotes),
    ...normalizeList(contract.quality_notes),
  ];
}

function requirementBlockers(contract, result) {
  const blockers = [];
  for (const requirement of normalizeList(contract.blocking_requirements)) {
    const id = String(requirement?.id || '').trim();
    if (!id) continue;
    const check = getRequirementCheck(id);
    if (!check) continue;
    if (check.satisfied(result, requirement)) continue;
    blockers.push(blocker(check.code, check.message, { requirement_id: id }));
  }
  return blockers;
}

function stateAssertionBlockers(stateAssertions = {}) {
  return normalizeList(stateAssertions.failures).map((failure) => blocker(
    'state_assertion_failed',
    `State assertion failed: ${failure.kind || 'unknown'}`,
    failure,
    'state_assertion_runner'
  ));
}

function verificationPlanBlockers(contract = {}, verification = {}, result = {}) {
  const blockers = [];
  const requiredCommands = normalizeList(contract.verification_plan?.required_commands).map(String).filter(Boolean);
  if (requiredCommands.length > 0) {
    const commandText = JSON.stringify([verification.commands, result.verification?.commands, result.tests]);
    for (const command of requiredCommands) {
      if (!commandText.includes(command)) {
        blockers.push(blocker('verification_command_missing', `Required verification command was not evidenced: ${command}`, { command }));
      }
    }
  }
  if (result.verification?.passed === false || verification.passed === false) {
    blockers.push(blocker('verification_not_passed', 'Verification did not pass.', { verification_passed: verification.passed, result_verification_passed: result.verification?.passed }));
  }
  return blockers;
}

export function verifyAcceptanceContract({
  contract = null,
  task = {},
  goal = {},
  result = {},
  verification = {},
  stateAssertions = { passed: true, assertions: [], failures: [] },
  repoState = {},
} = {}) {
  if (!hasContract(contract)) {
    return {
      contract_valid: false,
      blocking_passed: false,
      acceptance_status: 'indeterminate',
      completion_eligible: false,
      requires_review: true,
      blockers: [blocker('acceptance_contract_missing', 'No acceptance contract was provided for contract-aware verification.')],
      non_blocking_followups: normalizeFollowups(result),
      quality_notes: qualityNotes(result),
      normalized_result: normalizeOperationEvidence({ result, contract: {} }),
      state_assertions: stateAssertions,
      repo_state: repoState,
    };
  }

  const semantic = validateContractSemantics(hydrateContract(contract));
  const normalizedContract = semantic.normalized;
  const normalizedResult = normalizeOperationEvidence({ result, contract: normalizedContract });
  const blockers = [];

  if (!semantic.valid) {
    for (const error of semantic.errors) blockers.push(blocker(error.code, error.message, {}, 'acceptance_contract_semantics'));
  }
  blockers.push(...normalizedResult.blockers);
  blockers.push(...requirementBlockers(normalizedContract, normalizedResult));
  blockers.push(...verificationPlanBlockers(normalizedContract, verification, normalizedResult));
  if (stateAssertions.passed === false) blockers.push(...stateAssertionBlockers(stateAssertions));

  if (normalizedContract.requirements?.requires_commit === true && !normalizedResult.commit) {
    blockers.push(blocker('commit_present_missing', 'Contract requires commit evidence.', { requires_commit: true }));
  }
  if (normalizedContract.requirements?.requires_integration === true && !getRequirementCheck('integration_completed')?.satisfied(normalizedResult)) {
    blockers.push(blocker('integration_completed_missing', 'Contract requires integration evidence.', { requires_integration: true }));
  }

  const reviewReasons = normalizeList(normalizedContract.review_policy?.requires_review_when).map(String);
  const semanticReview = reviewReasons.includes('semantic_ambiguity') || normalizedContract.intent?.semantic_confidence === 'low';
  const contractInvalidReview = reviewReasons.includes('contract_invalid') && !semantic.valid;
  const blockingPassed = blockers.length === 0;
  const requiresReview = !blockingPassed || semanticReview || contractInvalidReview || normalizedResult.requires_review === true;
  const policy = normalizedContract.completion_policy || {};
  const completionEligible = blockingPassed && !requiresReview && policy.auto_complete_when_blocking_requirements_pass !== false;
  const acceptanceStatus = blockingPassed && !requiresReview
    ? 'satisfied'
    : (semanticReview || !semantic.valid ? 'indeterminate' : 'unsatisfied');

  return {
    contract_valid: semantic.valid,
    blocking_passed: blockingPassed,
    acceptance_status: acceptanceStatus,
    completion_eligible: completionEligible,
    requires_review: requiresReview,
    blockers,
    non_blocking_followups: normalizeFollowups(normalizedResult, normalizedContract),
    quality_notes: qualityNotes(normalizedResult, normalizedContract),
    normalized_result: normalizedResult,
    state_assertions: stateAssertions,
    semantic_validation: normalizedContract.semantic_validation,
    operation_kind: normalizedResult.operation_kind,
    acceptance_contract_id: normalizedResult.acceptance_contract_id,
    task_id: task?.id || null,
    goal_id: goal?.id || null,
    repo_state: repoState,
  };
}
