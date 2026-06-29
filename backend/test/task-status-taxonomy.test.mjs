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
  isFailedTerminalStatus,
  isHumanReviewStatus,
  isKnownTaskStatus,
  isNonTerminalWaitStatus,
  isRepairStatus,
  isTerminalStatus,
  normalizeTaskStatus,
} from '../src/task-status-taxonomy.mjs';

const expectedStatuses = [
  'assigned',
  'queued',
  'running',
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
    'assigned',
    'queued',
    'running',
    'waiting_for_integration',
    'waiting_for_lock',
  ]);
  for (const status of ACTIVE_EXECUTION_STATUSES) assert.equal(isActiveExecutionStatus(` ${status.toUpperCase()} `), true);
  assert.equal(isActiveExecutionStatus('waiting_for_review'), false);
  assert.equal(isActiveExecutionStatus('completed'), false);
});

test('review, repair, and wait statuses classify correctly', () => {
  assert.deepEqual([...HUMAN_REVIEW_STATUSES], ['waiting_for_review']);
  assert.deepEqual([...REPAIR_STATUSES], ['waiting_for_repair']);
  assert.deepEqual([...NON_TERMINAL_WAIT_STATUSES].sort(), [
    'waiting_for_integration',
    'waiting_for_lock',
    'waiting_for_repair',
    'waiting_for_review',
  ]);
  assert.equal(isHumanReviewStatus(' WAITING_FOR_REVIEW '), true);
  assert.equal(isRepairStatus('waiting_for_repair'), true);
  assert.equal(isNonTerminalWaitStatus('waiting_for_integration'), true);
  assert.equal(isNonTerminalWaitStatus('running'), false);
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
