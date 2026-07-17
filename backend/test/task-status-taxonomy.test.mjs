import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_EXECUTION_STATUSES,
  FAILED_TERMINAL_STATUSES,
  HUMAN_REVIEW_STATUSES,
  NON_TERMINAL_WAIT_STATUSES,
  REPAIR_STATUSES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  isActiveExecutionStatus,
  isCompletedStatus,
  isFailedTerminalStatus,
  isHumanReviewStatus,
  isKnownTaskStatus,
  isNonTerminalWaitStatus,
  isTrueHumanReviewStatus,
  isTypedReviewStatus,
  isMachineRepairableReviewStatus,
  isReviewOrRepairStatus,
  isRepairStatus,
  isTerminalStatus,
  normalizeTaskStatus,
} from '../src/task-status-taxonomy.mjs';

const expectedStatuses = [
  'human_interrupted_for_repair_budget_exhausted',
  'waiting_for_evidence_missing',
  'waiting_for_human_required',
  'waiting_for_human_review',
  'waiting_for_integration_recovery',
  'waiting_for_integration_uncertain',
  'waiting_for_policy_uncertain',
  'waiting_for_provider_unavailable',
  'waiting_for_supervisor',
  'waiting_for_repair_budget_exhausted',
  'waiting_for_manual_terminal_decision',
  'waiting_for_missing_evidence_repair',
  'waiting_for_noop_evidence',
  'waiting_for_result_contract_repair',
  'assigned',
  'queued',
  'running',
  'starting',
  'collecting',
  'accepting',
  'repairing',
  'integrating',
  'needs_decision',
  'waiting_for_lock',
  'waiting_for_review',
  'waiting_for_repair',
  'waiting_for_integration',
  'completed',
  'failed',
  'timed_out',
  'blocked',
  'cancelled',
];

test('exports all expected canonical task statuses', () => {
  assert.deepEqual([...Object.values(TASK_STATUSES)].sort(), [...expectedStatuses].sort());
  for (const status of expectedStatuses) assert.equal(isKnownTaskStatus(status), true);
});

test('normalizeTaskStatus handles nullish, non-string, uppercase, and whitespace', () => {
  assert.equal(normalizeTaskStatus(null), '');
  assert.equal(normalizeTaskStatus(undefined), '');
  assert.equal(normalizeTaskStatus(123), '');
  assert.equal(normalizeTaskStatus({ status: 'running' }), '');
  assert.equal(normalizeTaskStatus('  RUNNING  '), 'running');
  assert.equal(normalizeTaskStatus('\tWaiting_For_Review\n'), 'waiting_for_review');
});

test('active execution statuses classify correctly', () => {
  assert.deepEqual([...ACTIVE_EXECUTION_STATUSES].sort(), [
    'accepting',
    'assigned',
    'collecting',
    'integrating',
    'queued',
    'repairing',
    'running',
    'starting',
    'waiting_for_integration',
    'waiting_for_lock',
  ]);
  for (const status of ACTIVE_EXECUTION_STATUSES) assert.equal(isActiveExecutionStatus(` ${status.toUpperCase()} `), true);
  assert.equal(isActiveExecutionStatus('waiting_for_review'), false);
  assert.equal(isActiveExecutionStatus('completed'), false);
});

test('review, repair, and wait statuses classify correctly', () => {
  assert.deepEqual([...HUMAN_REVIEW_STATUSES].sort(), [  'needs_decision', 'waiting_for_review', 'waiting_for_supervisor',  'waiting_for_evidence_missing',  'waiting_for_human_required',  'waiting_for_human_review',  'waiting_for_integration_recovery',  'waiting_for_integration_uncertain',  'waiting_for_policy_uncertain',  'waiting_for_provider_unavailable',  'waiting_for_repair_budget_exhausted',  'waiting_for_result_contract_repair',  'waiting_for_noop_evidence',  'waiting_for_missing_evidence_repair',  'waiting_for_manual_terminal_decision',  'human_interrupted_for_repair_budget_exhausted',].sort());
  assert.deepEqual([...REPAIR_STATUSES], ['waiting_for_repair']);
  assert.deepEqual([...NON_TERMINAL_WAIT_STATUSES].sort(), [
    'waiting_for_integration',
    'waiting_for_lock',
    'waiting_for_repair',
    'waiting_for_review',
    'waiting_for_supervisor',
  ]);
  assert.equal(isHumanReviewStatus(' WAITING_FOR_REVIEW '), true);
  // P0-03: New canonical review states should be classified as human review statuses
  assert.equal(isHumanReviewStatus('waiting_for_evidence_missing'), true);
  assert.equal(isHumanReviewStatus('waiting_for_human_required'), true);
  assert.equal(isHumanReviewStatus('waiting_for_policy_uncertain'), true);
  assert.equal(isHumanReviewStatus('waiting_for_integration_uncertain'), true);
  assert.equal(isHumanReviewStatus('waiting_for_provider_unavailable'), true);
  assert.equal(isHumanReviewStatus('waiting_for_repair_budget_exhausted'), true);
  // P0-03: New states should be recognizable as typed review states
  assert.equal(isTypedReviewStatus('waiting_for_evidence_missing'), true);
  assert.equal(isTypedReviewStatus('waiting_for_human_required'), true);
  assert.equal(isTypedReviewStatus('waiting_for_policy_uncertain'), true);
  assert.equal(isTypedReviewStatus('waiting_for_integration_uncertain'), true);
  assert.equal(isTypedReviewStatus('waiting_for_provider_unavailable'), true);
  assert.equal(isTypedReviewStatus('waiting_for_repair_budget_exhausted'), true);
  // P0-03: Machine-repairable new states are not true human review
  assert.equal(isTrueHumanReviewStatus('waiting_for_evidence_missing'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_policy_uncertain'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_integration_uncertain'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_provider_unavailable'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_repair_budget_exhausted'), true);
  assert.equal(isTrueHumanReviewStatus('waiting_for_human_required'), true);
  assert.equal(isRepairStatus('waiting_for_repair'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_integration'), true);
  assert.equal(isNonTerminalWaitStatus('running'), false);
  assert.equal(isNonTerminalWaitStatus('waiting_for_evidence_missing'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_human_required'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_repair_budget_exhausted'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_supervisor'), true);
  assert.equal(isTrueHumanReviewStatus('waiting_for_supervisor'), true);
});

test('completed status classifies distinctly from terminal failures', () => {
  assert.equal(isCompletedStatus(' COMPLETED '), true);
  assert.equal(isCompletedStatus('failed'), false);
  assert.equal(isCompletedStatus('waiting_for_review'), false);
});

test('review or repair statuses classify operator-attention states', () => {
  assert.equal(isReviewOrRepairStatus('waiting_for_review'), true);
  assert.equal(isReviewOrRepairStatus('WAITING_FOR_REPAIR'), true);
  assert.equal(isReviewOrRepairStatus('waiting_for_integration'), false);
  assert.equal(isReviewOrRepairStatus('failed'), false);
});

test('terminal and failed-terminal statuses classify correctly', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['blocked', 'cancelled', 'completed', 'failed', 'timed_out']);
  assert.deepEqual([...FAILED_TERMINAL_STATUSES].sort(), ['blocked', 'cancelled', 'failed', 'timed_out']);
  for (const status of TERMINAL_STATUSES) assert.equal(isTerminalStatus(` ${status.toUpperCase()} `), true);
  for (const status of FAILED_TERMINAL_STATUSES) assert.equal(isFailedTerminalStatus(status), true);
  assert.equal(isFailedTerminalStatus('completed'), false);
  assert.equal(isTerminalStatus('running'), false);
});

test('unknown statuses return false for every classifier', () => {
  for (const status of ['', 'unknown', 'needs_review', null, undefined, 0]) {
    assert.equal(isKnownTaskStatus(status), false);
    assert.equal(isTerminalStatus(status), false);
    assert.equal(isFailedTerminalStatus(status), false);
    assert.equal(isActiveExecutionStatus(status), false);
    assert.equal(isHumanReviewStatus(status), false);
    assert.equal(isRepairStatus(status), false);
    assert.equal(isNonTerminalWaitStatus(status), false);
  }
});

// ===========================================================================
// Typed review states (P0-C2)
// ===========================================================================

test('TASK_STATUSES includes all typed review states', () => {
  assert.equal(TASK_STATUSES.WAITING_FOR_HUMAN_REVIEW, 'waiting_for_human_review');
  assert.equal(TASK_STATUSES.WAITING_FOR_MISSING_EVIDENCE_REPAIR, 'waiting_for_missing_evidence_repair');
  assert.equal(TASK_STATUSES.WAITING_FOR_INTEGRATION_RECOVERY, 'waiting_for_integration_recovery');
  assert.equal(TASK_STATUSES.WAITING_FOR_RESULT_CONTRACT_REPAIR, 'waiting_for_result_contract_repair');
  assert.equal(TASK_STATUSES.WAITING_FOR_NOOP_EVIDENCE, 'waiting_for_noop_evidence');
  assert.equal(TASK_STATUSES.WAITING_FOR_MANUAL_TERMINAL_DECISION, 'waiting_for_manual_terminal_decision');
  assert.equal(TASK_STATUSES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED, 'human_interrupted_for_repair_budget_exhausted');
});

test('HUMAN_REVIEW_STATUSES includes both legacy and typed states', () => {
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_review'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_human_review'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_missing_evidence_repair'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_integration_recovery'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_result_contract_repair'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_noop_evidence'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_manual_terminal_decision'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('human_interrupted_for_repair_budget_exhausted'), true);
  assert.equal(HUMAN_REVIEW_STATUSES.has('completed'), false);
  assert.equal(HUMAN_REVIEW_STATUSES.has('waiting_for_repair'), false);
});

test('TRUE_HUMAN_REVIEW_STATUSES excludes machine-repairable typed states', () => {
  assert.equal(isTrueHumanReviewStatus('waiting_for_review'), true);
  assert.equal(isTrueHumanReviewStatus('waiting_for_human_review'), true);
  assert.equal(isTrueHumanReviewStatus('waiting_for_manual_terminal_decision'), true);
  assert.equal(isTrueHumanReviewStatus('human_interrupted_for_repair_budget_exhausted'), true);
  assert.equal(isTrueHumanReviewStatus('waiting_for_missing_evidence_repair'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_integration_recovery'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_result_contract_repair'), false);
  assert.equal(isTrueHumanReviewStatus('waiting_for_noop_evidence'), false);
  assert.equal(isTrueHumanReviewStatus('completed'), false);
});

test('isTypedReviewStatus identifies typed review states', () => {
  assert.equal(isTypedReviewStatus('waiting_for_human_review'), true);
  assert.equal(isTypedReviewStatus('waiting_for_missing_evidence_repair'), true);
  assert.equal(isTypedReviewStatus('waiting_for_review'), false);
  assert.equal(isTypedReviewStatus('completed'), false);
});

test('isMachineRepairableReviewStatus correctly identifies machine-repairable states', () => {
  assert.equal(isMachineRepairableReviewStatus('waiting_for_missing_evidence_repair'), true);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_integration_recovery'), true);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_result_contract_repair'), true);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_noop_evidence'), true);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_human_review'), false);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_manual_terminal_decision'), false);
  assert.equal(isMachineRepairableReviewStatus('human_interrupted_for_repair_budget_exhausted'), false);
  assert.equal(isMachineRepairableReviewStatus('waiting_for_review'), false);
});

test('isNonTerminalWaitStatus includes typed review states', () => {
  assert.equal(isNonTerminalWaitStatus('waiting_for_human_review'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_missing_evidence_repair'), true);
  assert.equal(isNonTerminalWaitStatus('human_interrupted_for_repair_budget_exhausted'), true);
  assert.equal(isNonTerminalWaitStatus('completed'), false);
});

test('isNonTerminalWaitStatus excludes typed review states when includeTypedReview=false', () => {
  assert.equal(isNonTerminalWaitStatus('waiting_for_human_review', { includeTypedReview: false }), false);
  assert.equal(isNonTerminalWaitStatus('waiting_for_missing_evidence_repair', { includeTypedReview: false }), false);
  // Legacy waiting_for_review is always included in NON_TERMINAL_WAIT_STATUSES
  assert.equal(isNonTerminalWaitStatus('waiting_for_review', { includeTypedReview: false }), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_lock', { includeTypedReview: false }), true);
});
