/**
 * auto-progress-policy.test.mjs — Closure status mapping and auto-complete rules
 *
 * Tests the closure status "records" defined in auto-progress-policy.mjs:
 *   1. CLOSURE_STATUSES constants match expected values
 *   2. mapClosureStatusToTaskStatus maps correctly for every status,
 *      including config overrides and fallback behavior
 *   3. closureAllowsAutoComplete correctly identifies clean and
 *      followup completion from non-terminal or blocking statuses
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSURE_STATUSES,
  mapClosureStatusToTaskStatus,
  closureAllowsAutoComplete,
} from '../src/closure/auto-progress-policy.mjs';

import { REVIEW_STATES } from '../src/task-review-status-taxonomy.mjs';

// ===========================================================================
// Section 1: CLOSURE_STATUSES constant values
// ===========================================================================

test('CLOSURE_STATUSES defines all expected status constants', () => {
  assert.equal(CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN, 'auto_completed_clean');
  assert.equal(CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS, 'auto_completed_with_followups');
  assert.equal(CLOSURE_STATUSES.WAITING_FOR_REPAIR, 'waiting_for_repair');
  assert.equal(CLOSURE_STATUSES.REQUIRES_REVIEW, 'requires_review');
  assert.equal(CLOSURE_STATUSES.FAILED, 'failed');
  assert.equal(CLOSURE_STATUSES.WAITING_FOR_HUMAN_REVIEW, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
  assert.equal(CLOSURE_STATUSES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
});

test('CLOSURE_STATUSES is frozen and cannot be mutated', () => {
  assert.throws(() => { CLOSURE_STATUSES.NEW_STATUS = 'new'; }, TypeError);
});

// ===========================================================================
// Section 2: mapClosureStatusToTaskStatus — default mappings
// ===========================================================================

test('mapClosureStatusToTaskStatus maps auto_completed_clean to completed', () => {
  assert.equal(mapClosureStatusToTaskStatus('auto_completed_clean'), 'completed');
});

test('mapClosureStatusToTaskStatus maps auto_completed_with_followups to completed', () => {
  assert.equal(mapClosureStatusToTaskStatus('auto_completed_with_followups'), 'completed');
});

test('mapClosureStatusToTaskStatus maps waiting_for_repair to default status', () => {
  assert.equal(mapClosureStatusToTaskStatus('waiting_for_repair'), 'waiting_for_repair');
});

test('mapClosureStatusToTaskStatus maps requires_review to default status', () => {
  assert.equal(mapClosureStatusToTaskStatus('requires_review'), 'waiting_for_review');
});

test('mapClosureStatusToTaskStatus maps failed to failed', () => {
  assert.equal(mapClosureStatusToTaskStatus('failed'), 'failed');
});

test('mapClosureStatusToTaskStatus maps waiting_for_human_review to default review state', () => {
  assert.equal(mapClosureStatusToTaskStatus('waiting_for_human_review'), REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
});

test('mapClosureStatusToTaskStatus maps human_interrupted_for_repair_budget_exhausted to default state', () => {
  assert.equal(mapClosureStatusToTaskStatus('human_interrupted_for_repair_budget_exhausted'), REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
});

test('mapClosureStatusToTaskStatus returns default fallback for unknown status', () => {
  assert.equal(mapClosureStatusToTaskStatus('unknown_status'), 'waiting_for_review');
});

// ===========================================================================
// Section 3: mapClosureStatusToTaskStatus — config overrides
// ===========================================================================

test('mapClosureStatusToTaskStatus config overrides waiting_for_repair', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('waiting_for_repair', { waitingForRepairTaskStatus: 'custom_repair' }),
    'custom_repair',
  );
});

test('mapClosureStatusToTaskStatus config overrides requires_review', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('requires_review', { waitingForReviewTaskStatus: 'custom_review' }),
    'custom_review',
  );
});

test('mapClosureStatusToTaskStatus config overrides waiting_for_human_review', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('waiting_for_human_review', { waitingForHumanReviewTaskStatus: 'human_intervention' }),
    'human_intervention',
  );
});

test('mapClosureStatusToTaskStatus config overrides human_interrupted_for_repair_budget_exhausted', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('human_interrupted_for_repair_budget_exhausted', { humanInterruptedForRepairBudgetExhaustedTaskStatus: 'budget_exhausted' }),
    'budget_exhausted',
  );
});

test('mapClosureStatusToTaskStatus config overrides default fallback', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('unknown_xyz', { defaultFallbackTaskStatus: 'triage' }),
    'triage',
  );
});

test('mapClosureStatusToTaskStatus does not let config override auto_completed statuses', () => {
  // Even with a config targeting the right key, completed statuses should
  // always map to "completed" because they hit the early returns before
  // the config-based branches.
  assert.equal(
    mapClosureStatusToTaskStatus('auto_completed_clean', { waitingForReviewTaskStatus: 'custom_review' }),
    'completed',
  );
  assert.equal(
    mapClosureStatusToTaskStatus('auto_completed_with_followups', { waitingForReviewTaskStatus: 'custom_review' }),
    'completed',
  );
  assert.equal(
    mapClosureStatusToTaskStatus('failed', { waitingForReviewTaskStatus: 'custom_review' }),
    'failed',
  );
});

test('mapClosureStatusToTaskStatus handles null and undefined status', () => {
  assert.equal(mapClosureStatusToTaskStatus(null), 'waiting_for_review');
  assert.equal(mapClosureStatusToTaskStatus(undefined), 'waiting_for_review');
  assert.equal(mapClosureStatusToTaskStatus(null, { defaultFallbackTaskStatus: 'triage' }), 'triage');
});

test('mapClosureStatusToTaskStatus handles empty config object', () => {
  assert.equal(mapClosureStatusToTaskStatus('requires_review', {}), 'waiting_for_review');
  assert.equal(mapClosureStatusToTaskStatus('waiting_for_repair', {}), 'waiting_for_repair');
  assert.equal(mapClosureStatusToTaskStatus('unknown', {}), 'waiting_for_review');
});

test('mapClosureStatusToTaskStatus ignores irrelevant config keys', () => {
  assert.equal(
    mapClosureStatusToTaskStatus('requires_review', { unrelatedKey: 'irrelevant' }),
    'waiting_for_review',
  );
});

// ===========================================================================
// Section 4: closureAllowsAutoComplete — predicate
// ===========================================================================

test('closureAllowsAutoComplete returns true for auto_completed_clean', () => {
  assert.equal(closureAllowsAutoComplete('auto_completed_clean'), true);
});

test('closureAllowsAutoComplete returns true for auto_completed_with_followups', () => {
  assert.equal(closureAllowsAutoComplete('auto_completed_with_followups'), true);
});

test('closureAllowsAutoComplete returns false for waiting_for_repair', () => {
  assert.equal(closureAllowsAutoComplete('waiting_for_repair'), false);
});

test('closureAllowsAutoComplete returns false for requires_review', () => {
  assert.equal(closureAllowsAutoComplete('requires_review'), false);
});

test('closureAllowsAutoComplete returns false for failed', () => {
  assert.equal(closureAllowsAutoComplete('failed'), false);
});

test('closureAllowsAutoComplete returns false for waiting_for_human_review', () => {
  assert.equal(closureAllowsAutoComplete('waiting_for_human_review'), false);
});

test('closureAllowsAutoComplete returns false for human_interrupted_for_repair_budget_exhausted', () => {
  assert.equal(closureAllowsAutoComplete('human_interrupted_for_repair_budget_exhausted'), false);
});

test('closureAllowsAutoComplete returns false for null and undefined', () => {
  assert.equal(closureAllowsAutoComplete(null), false);
  assert.equal(closureAllowsAutoComplete(undefined), false);
  assert.equal(closureAllowsAutoComplete(''), false);
});

test('closureAllowsAutoComplete returns false for unknown status', () => {
  assert.equal(closureAllowsAutoComplete('some_random_status'), false);
});

// ===========================================================================
// Section 5: Full status round-trip — all constants pass through
// ===========================================================================

test('all CLOSURE_STATUSES values round-trip through mapClosureStatusToTaskStatus without error', () => {
  for (const [key, value] of Object.entries(CLOSURE_STATUSES)) {
    const result = mapClosureStatusToTaskStatus(value);
    assert.equal(typeof result, 'string', `mapClosureStatusToTaskStatus(${key}) must return a string`);
    assert.ok(result.length > 0, `mapClosureStatusToTaskStatus(${key}) must not be empty`);
  }
});

test('closureAllowsAutoComplete classifies all CLOSURE_STATUSES correctly', () => {
  // Only the two auto_completed* statuses should return true
  for (const [key, value] of Object.entries(CLOSURE_STATUSES)) {
    const expected = key === 'AUTO_COMPLETED_CLEAN' || key === 'AUTO_COMPLETED_WITH_FOLLOWUPS';
    assert.equal(
      closureAllowsAutoComplete(value),
      expected,
      `closureAllowsAutoComplete(${key}) must be ${expected}`,
    );
  }
});
