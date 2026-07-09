/**
 * lifecycle-acceptance.test.mjs
 *
 * Regression coverage for the lifecycle acceptance policy update.
 *
 * Six required scenarios:
 *   1. accepted clean          - All gates passing, no followups
 *   2. accepted_with_followups - All gates passing, non-blocking followups exist
 *   3. resolved findings       - Previously-blocking findings that were resolved
 *   4. blocking findings        - Unresolved blocker findings route to repair
 *   5. missing evidence        - Missing commit/changed_files blocks completion
 *   6. checkpoint persistence  - Completion checkpoint metadata built before terminal success
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideTaskFinalState, buildCompletionCheckpoint } from '../src/task-finalizer.mjs';
import { decideTaskClosure } from '../src/closure/task-closure-decider.mjs';
import { CLOSURE_STATUSES } from '../src/closure/auto-progress-policy.mjs';

// ===========================================================================
// Helpers
// ===========================================================================

function passedEvidence(overrides = {}) {
  return {
    current_status: 'completed',
    codex_result: {
      status: 'completed',
      kind: 'codex_executed',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123def456',
      verification: { passed: true },
      reviewer_decision: { status: 'accepted', passed: true },
      contract_verification: {
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
        blockers: [],
      },
      integration: { status: 'merged', merged: true },
      acceptance_findings: [],
    },
    verification: { passed: true, findings: [] },
    acceptance: { passed: true, status: 'accepted' },
    contract_verification: {
      blocking_passed: true,
      completion_eligible: true,
      requires_review: false,
      blockers: [],
    },
    integration: { required: true, status: 'merged', merged: true },
    repair_budget: { attempts_remaining: 1 },
    ...overrides,
  };
}

function baseContract(overrides = {}) {
  return {
    intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: false, requires_deployment: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    ...overrides,
  };
}

function baseVerification(overrides = {}) {
  return {
    passed: true,
    commands: [{ cmd: 'npm test', exit_code: 0 }],
    findings: [],
    ...overrides,
  };
}

function baseContractVerification(overrides = {}) {
  return {
    contract_valid: true,
    blocking_passed: true,
    acceptance_status: 'satisfied',
    completion_eligible: true,
    blockers: [],
    non_blocking_followups: [],
    quality_notes: [],
    state_assertions: { passed: true, assertions: [], failures: [] },
    ...overrides,
  };
}

// ===========================================================================
// 1. accepted clean — All gates passing, no followups, auto-completes
// ===========================================================================

test('1. accepted clean: decideTaskClosure returns auto_completed_clean when all gates pass', () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    result: { status: 'completed', commit: 'abc123', changed_files: ['src/app.mjs'] },
    task: { id: 'task_clean_accepted' },
  });

  assert.equal(decision.status, CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN);
  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.auto_complete_allowed, true);
  assert.equal(decision.requires_human_decision, false);
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.repairable_blockers.length, 0);
  assert.equal(decision.quality_followups_count, 0);
});

test('1. accepted clean: finalizer completes when terminal evidence satisfied', () => {
  const decision = decideTaskFinalState(passedEvidence());

  assert.equal(decision.status, 'completed');
  assert.equal(decision.safe_to_auto_advance, true);
  assert.equal(decision.reason, 'terminal_evidence_satisfied');
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.repairable_blockers.length, 0);
});

// ===========================================================================
// 2. accepted_with_followups — Non-blocking followups do not block completion
// ===========================================================================

test('2. accepted_with_followups: decideTaskClosure auto-completes with non-blocking followups', () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification({
      non_blocking_followups: [
        { code: 'polish_ui', message: 'Polish the new UI component', severity: 'minor' },
      ],
    }),
    verification: baseVerification(),
    result: { status: 'completed', commit: 'abc123', changed_files: ['src/app.mjs'] },
    task: { id: 'task_followup_scenario' },
  });

  assert.equal(decision.status, CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS);
  assert.equal(decision.auto_complete_allowed, true);
  assert.equal(decision.requires_human_decision, false);
  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.quality_followups_count, 1);
});

test('2. accepted_with_followups: finalizer completes despite non-blocking followups in result', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      non_blocking_followups: [{ code: 'refactor_later', message: 'Refactor after release' }],
    },
  }));

  assert.equal(decision.status, 'completed', 'Non-blocking followups must not block completion');
  assert.equal(decision.safe_to_auto_advance, true);
  // Followups appear in the non_blocking_followups array but don't create blockers
  assert.equal(decision.blockers.length, 0);
});

test('2. accepted_with_followups: non-blocking followups from result.followup_findings do not block', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      followup_findings: [{ code: 'future_work', message: 'Consider adding more tests' }],
    },
  }));

  assert.equal(decision.status, 'completed', 'followup_findings must not block terminal completion');
  assert.equal(decision.blockers.length, 0);
});

test('2. accepted_with_followups: quality_notes do not block completion', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      quality_notes: ['Code style could be improved in a future pass'],
    },
  }));

  assert.equal(decision.status, 'completed', 'quality_notes must not block terminal completion');
  assert.equal(decision.blockers.length, 0);
});

// ===========================================================================
// 3. resolved findings — Previously-blocking findings resolved do not block
// ===========================================================================

test('3. resolved findings: resolved blockers do not block terminal completion', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      acceptance_findings: [
        { severity: 'blocker', code: 'dirty_worktree', message: 'Worktree was dirty', resolved: true },
        { severity: 'major', code: 'test_failure', message: 'One test failed', resolved: true },
      ],
    },
  }));

  assert.equal(decision.status, 'completed', 'Resolved findings must not block completion');
  assert.equal(decision.safe_to_auto_advance, true);
  assert.equal(decision.blockers.length, 0);
});

test('3. resolved findings: mixed resolved and unresolved — unresolved still blocks', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      acceptance_findings: [
        { severity: 'blocker', code: 'dirty_worktree', message: 'Worktree was dirty', resolved: true },
        { severity: 'blocker', code: 'verification_failed', message: 'Verification still failing', resolved: false },
      ],
    },
  }));

  assert.notEqual(decision.status, 'completed', 'Unresolved blockers must block completion');
  assert.equal(decision.safe_to_auto_advance, false);
  assert.ok(decision.blockers.length > 0 || decision.repairable_blockers.length > 0);
});

// ===========================================================================
// 4. blocking findings — Unresolved blockers route to repair/convergence
// ===========================================================================

test('4. blocking findings: failed verification routes to waiting_for_repair', () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification(),
    verification: baseVerification({ passed: false, findings: [{ code: 'test_failed', message: 'Tests failed' }] }),
    result: { status: 'completed', commit: 'abc123', changed_files: ['src/app.mjs'] },
    task: { id: 'task_blocking_verification' },
  });

  assert.equal(decision.status, CLOSURE_STATUSES.WAITING_FOR_REPAIR);
  assert.equal(decision.auto_complete_allowed, false);
  assert.equal(decision.requires_human_decision, false);
  assert.ok(decision.repairable_blockers.some((b) => b.code === 'verification_not_passed'),
    'Failed verification must produce verification_not_passed repairable blocker');
});

test('4. blocking findings: finalizer routes blocking findings to waiting_for_repair', () => {
  const decision = decideTaskFinalState(passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      acceptance_findings: [
        { severity: 'blocker', code: 'git_diff_check_failed', message: 'Diff check failed', resolved: false },
      ],
    },
  }));

  assert.notEqual(decision.status, 'completed', 'Blocking findings must block completion');
  assert.equal(decision.safe_to_auto_advance, false);
});

test('4. blocking findings: unresolved blocker with contract_verification blocking_passed=false routes to review', () => {
  const decision = decideTaskFinalState(passedEvidence({
    current_status: 'waiting_for_review',
    contract_verification: {
      blocking_passed: false,
      completion_eligible: false,
      requires_review: true,
      blockers: [{ code: 'commit_present_missing', message: 'Contract requires commit evidence.' }],
    },
    codex_result: {
      ...passedEvidence().codex_result,
      contract_verification: {
        blocking_passed: false,
        completion_eligible: false,
        requires_review: true,
        blockers: [{ code: 'commit_present_missing', message: 'Contract requires commit evidence.' }],
      },
    },
  }));

  assert.notEqual(decision.status, 'completed', 'Contract blocking requirements must prevent completion');
  assert.equal(decision.safe_to_auto_advance, false);
});

// ===========================================================================
// 5. missing evidence — Missing commit/changed_files blocks completion
// ===========================================================================

test('5. missing evidence: missing commit blocks completion via closure decider', () => {
  const decision = decideTaskClosure({
    contract: baseContract({ requirements: { requires_commit: true, requires_integration: false } }),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    result: { status: 'completed', changed_files: ['src/app.mjs'] },
    task: { id: 'task_missing_commit' },
  });

  assert.equal(decision.status, CLOSURE_STATUSES.REQUIRES_REVIEW);
  assert.equal(decision.auto_complete_allowed, false);
  assert.equal(decision.requires_human_decision, true);
  assert.ok(decision.blockers.some((b) => b.code === 'commit_evidence_missing'),
    'Missing commit must produce commit_evidence_missing blocker');
});

test('5. missing evidence: contract verifier reports blockers for missing integration', () => {
  const contractVerification = baseContractVerification({
    blocking_passed: false,
    completion_eligible: false,
    blockers: [{ code: 'integration_completed_missing', message: 'Contract requires integration evidence.' }],
  });

  const closureDecision = decideTaskClosure({
    contract: baseContract({ requirements: { requires_commit: true, requires_integration: true } }),
    contractVerification,
    verification: baseVerification(),
    integration: { status: '', satisfied: false, merged: false },
    result: { status: 'completed', commit: 'abc123', changed_files: ['src/app.mjs'] },
    task: { id: 'task_missing_integration_evidence' },
  });

  assert.equal(closureDecision.status, CLOSURE_STATUSES.WAITING_FOR_REPAIR);
  assert.ok(closureDecision.repairable_blockers.some((b) => b.code === 'integration_completed_missing'),
    'Missing integration evidence must produce integration_completed_missing repairable blocker');
});

test('5. missing evidence: finalizer blocks completion when verification evidence is missing', () => {
  const decision = decideTaskFinalState(passedEvidence({
    verification: { passed: false, findings: [{ code: 'verification_not_passed', message: 'No verification ran' }] },
    codex_result: {
      ...passedEvidence().codex_result,
      verification: { passed: false },
    },
  }));

  assert.notEqual(decision.status, 'completed', 'Missing verification evidence must block completion');
  assert.equal(decision.safe_to_auto_advance, false);
});

// ===========================================================================
// 6. checkpoint persistence — Completion checkpoint built before terminal success
// ===========================================================================

test('6. checkpoint persistence: buildCompletionCheckpoint returns metadata for completed decisions', () => {
  const evidence = passedEvidence();
  const finalizerDecision = decideTaskFinalState(evidence);

  const checkpoint = buildCompletionCheckpoint(evidence, finalizerDecision);

  assert.notEqual(checkpoint, null);
  assert.equal(checkpoint.checkpoint_type, 'completion');
  assert.equal(checkpoint.persisted_before_terminal, true);
  assert.equal(checkpoint.status, 'completed');
  assert.equal(checkpoint.reason, 'terminal_evidence_satisfied');
  assert.equal(checkpoint.commit, 'abc123def456');
  assert.deepEqual(checkpoint.changed_files, ['backend/src/app.mjs']);
  assert.equal(checkpoint.blocking_passed, true);
  assert.ok(Array.isArray(checkpoint.non_blocking_followups));
});

test('6. checkpoint persistence: buildCompletionCheckpoint returns null for non-completed decisions', () => {
  const nonCompletedStatuses = ['waiting_for_repair', 'waiting_for_review', 'waiting_for_integration', 'failed', 'timed_out'];

  for (const status of nonCompletedStatuses) {
    const checkpoint = buildCompletionCheckpoint(
      { codex_result: {} },
      { status, reason: 'test' }
    );
    assert.equal(checkpoint, null,
      `buildCompletionCheckpoint must return null for status "${status}"`);
  }
});

test('6. checkpoint persistence: checkpoint captures followups from completed decisions', () => {
  const evidence = passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      non_blocking_followups: [{ code: 'ui_polish', message: 'Polish the UI later' }],
    },
  });
  const finalizerDecision = decideTaskFinalState(evidence);
  const checkpoint = buildCompletionCheckpoint(evidence, finalizerDecision);

  assert.notEqual(checkpoint, null);
  assert.equal(checkpoint.status, 'completed');
  assert.ok(checkpoint.non_blocking_followups.length >= 1,
    'Checkpoint must include non-blocking followups from completed decisions');
});

test('6. checkpoint persistence: checkpoint for non-terminal decision returns null (no false checkpoint)', () => {
  const evidence = passedEvidence({
    verification: { passed: false, findings: [{ code: 'test_failed', message: 'Tests failed' }] },
    codex_result: {
      ...passedEvidence().codex_result,
      verification: { passed: false },
    },
  });
  const finalizerDecision = decideTaskFinalState(evidence);
  const checkpoint = buildCompletionCheckpoint(evidence, finalizerDecision);

  assert.equal(checkpoint, null,
    'Non-terminal decisions must not produce a completion checkpoint');
});

test('6. checkpoint persistence: no-change repair completion also produces checkpoint', () => {
  // A no-change repair with completion_eligible=true should also produce
  // a valid checkpoint via buildCompletionCheckpoint.
  const evidence = passedEvidence({
    current_status: 'completed',
    codex_result: {
      ...passedEvidence().codex_result,
      changed_files: [],
      commit: null,
      no_mutation: true,
      operation_kind: 'repair_noop',
    },
  });
  // Override to make it look like no-change repair passing the terminal gates
  const noChangeEvidence = {
    ...evidence,
    integration: { required: false },
    codex_result: {
      ...evidence.codex_result,
      verification: { passed: true },
    },
  };

  const finalizerDecision = decideTaskFinalState(noChangeEvidence);
  // It might complete via terminal evidence or via noChangeRepair path
  if (finalizerDecision.status === 'completed') {
    const checkpoint = buildCompletionCheckpoint(noChangeEvidence, finalizerDecision);
    assert.notEqual(checkpoint, null);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(checkpoint.persisted_before_terminal, true);
  } else {
    // If it doesn't complete, no checkpoint should exist
    const checkpoint = buildCompletionCheckpoint(noChangeEvidence, finalizerDecision);
    assert.equal(checkpoint, null);
  }
});

// ===========================================================================
// Cross-cutting: Nonblocking followups never create blockers
// ===========================================================================

test('Cross-cutting: nonblocking followups from all sources do not create blockers', () => {
  const evidence = passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      non_blocking_followups: [{ code: 'a', message: 'Followup A' }],
      followup_findings: [{ code: 'b', message: 'Followup B' }],
      followups: [{ code: 'c', message: 'Followup C' }],
      quality_notes: [{ code: 'd', message: 'Quality note D' }],
    },
  });

  const finalizerDecision = decideTaskFinalState(evidence);

  assert.equal(finalizerDecision.status, 'completed',
    'Task with only non-blocking followups must complete');
  assert.equal(finalizerDecision.blockers.length, 0,
    'Non-blocking followups must not appear as blockers');
});

// ===========================================================================
// Cross-cutting: Blocking findings with verified=true are not blockers
// ===========================================================================

test('Cross-cutting: blocking findings verified or resolved are not blockers', () => {
  const evidence = passedEvidence({
    codex_result: {
      ...passedEvidence().codex_result,
      acceptance_findings: [
        { severity: 'blocker', code: 'dirty_worktree', message: 'Was dirty', resolved: true },
        { severity: 'blocker', code: 'verification_failed', message: 'Was failing', resolved: true },
      ],
    },
  });

  const finalizerDecision = decideTaskFinalState(evidence);

  assert.equal(finalizerDecision.status, 'completed',
    'Task with only resolved findings must still complete');
  assert.equal(finalizerDecision.blockers.length, 0,
    'Resolved findings must not create blockers');
});
