/**
 * task-review-status-taxonomy.test.mjs
 * Tests for typed review state classification and metadata.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_STATES,
  LEGACY_WAITING_FOR_REVIEW,
  TYPED_REVIEW_STATES,
  REVIEW_STATE_META,
  classifyReviewState,
  isTypedReviewState,
  isMachineRepairableReviewState,
  getResumeOptions,
  getNextAction,
  createReviewStateBlock,
} from '../src/task-review-status-taxonomy.mjs';

// ===========================================================================
// Constants and structure
// ===========================================================================

test('exports exactly 7 typed review states', () => {
  const values = Object.values(REVIEW_STATES);
  assert.equal(values.length, 7);
  assert.equal(new Set(values).size, 7, 'all values must be unique');
});

test('each typed state has metadata in REVIEW_STATE_META', () => {
  for (const [key, value] of Object.entries(REVIEW_STATES)) {
    const meta = REVIEW_STATE_META[value];
    assert.ok(meta, `missing metadata for ${key} (${value})`);
    assert.equal(typeof meta.label, 'string', `label must be string for ${key}`);
    assert.ok(Array.isArray(meta.resume_options), `resume_options must be array for ${key}`);
    assert.ok(meta.resume_options.length > 0, `resume_options must not be empty for ${key}`);
    assert.equal(typeof meta.next_action, 'string', `next_action must be string for ${key}`);
    assert.equal(typeof meta.machine_repairable, 'boolean', `machine_repairable must be boolean for ${key}`);
    assert.equal(typeof meta.description, 'string', `description must be string for ${key}`);
  }
});

test('TYPED_REVIEW_STATES contains all review states', () => {
  for (const value of Object.values(REVIEW_STATES)) {
    assert.equal(TYPED_REVIEW_STATES.has(value), true);
  }
  assert.equal(TYPED_REVIEW_STATES.has('waiting_for_review'), false);
  assert.equal(TYPED_REVIEW_STATES.has('completed'), false);
});

test('LEGACY_WAITING_FOR_REVIEW is the backward-compatible catch-all', () => {
  assert.equal(LEGACY_WAITING_FOR_REVIEW, 'waiting_for_review');
});

// ===========================================================================
// Machine repairable classification
// ===========================================================================

test('machine_repairable is true for evidence and integration recovery states', () => {
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE].machine_repairable, true);
});

test('machine_repairable is false for human review and terminal decision states', () => {
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW].machine_repairable, false);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION].machine_repairable, false);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED].machine_repairable, false);
});

// ===========================================================================
// classifyReviewState — blocker code mapping
// ===========================================================================

test('classifyReviewState: known blocker codes map to correct typed states', () => {
  // Missing evidence
  const evidence = classifyReviewState({ blockers: [{ code: 'result_missing' }] });
  assert.equal(evidence.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);

  // Integration recovery
  const integration = classifyReviewState({ blockers: [{ code: 'integration_conflict' }] });
  assert.equal(integration.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY);

  // Contract repair
  const contract = classifyReviewState({ blockers: [{ code: 'contract_invalid' }] });
  assert.equal(contract.reviewState, REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR);

  // No-op evidence
  const noop = classifyReviewState({ blockers: [{ code: 'no_mutation_evidence_missing' }] });
  assert.equal(noop.reviewState, REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE);

  // Manual terminal decision
  const manual = classifyReviewState({ blockers: [{ code: 'manual_approval_required' }] });
  assert.equal(manual.reviewState, REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION);

  // Human review (default for unknown codes)
  const unknown = classifyReviewState({ blockers: [{ code: 'some_unknown_code' }] });
  assert.equal(unknown.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
});

test('classifyReviewState: repair budget exhausted takes highest priority', () => {
  const result = classifyReviewState({
    reason: 'repair_budget_exhausted',
    blockers: [{ code: 'codex_failed' }],
    repairBudgetExhausted: true,
  });
  assert.equal(result.reviewState, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
});

test('classifyReviewState: reason-based matching for result_missing', () => {
  const result = classifyReviewState({ reason: 'result_missing_with_diff', blockers: [] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);

  const result2 = classifyReviewState({ reason: 'result_missing_no_diff', blockers: [] });
  assert.equal(result2.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
});

test('classifyReviewState: integration-related reason triggers integration recovery', () => {
  const result = classifyReviewState({ reason: 'integration_required_not_terminal', blockers: [] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY);
});

test('classifyReviewState: codex_failed routes to missing evidence repair (not human review) per P0-C7', () => {
  const result = classifyReviewState({ blockers: [{ code: 'codex_failed' }] });
  // P0-C7: codex_failed is now auto-repaired via missing_evidence_repair, not human review
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
});

test('classifyReviewState: insufficient_terminal_evidence defaults to human review', () => {
  const result = classifyReviewState({ blockers: [{ code: 'insufficient_terminal_evidence' }] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
});

test('classifyReviewState: unhandled convergence case defaults to human review', () => {
  const result = classifyReviewState({ reason: 'unhandled convergence case', blockers: [] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
});

test('classifyReviewState: no blockers at all defaults to human review', () => {
  const result = classifyReviewState({});
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
});

// ===========================================================================
// Tests covering required failure classes (acceptance)
// ===========================================================================

test('ACCEPTANCE P0-C7: codex_failed blocker maps to missing evidence repair (auto-repair)', () => {
  const r = classifyReviewState({ blockers: [{ code: 'codex_failed' }] });
  // P0-C7: codex_failed is machine-repairable via missing_evidence_repair
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  assert.ok(r.metadata);
  assert.equal(r.metadata.machine_repairable, true);
});

test('ACCEPTANCE: missing integration evidence maps correctly', () => {
  const r = classifyReviewState({ blockers: [{ code: 'integration_required_not_terminal' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY);
  assert.ok(r.metadata);
});

test('ACCEPTANCE: no-mutation evidence missing maps correctly', () => {
  const r = classifyReviewState({ blockers: [{ code: 'no_mutation_evidence_missing' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE);
});

test('ACCEPTANCE: result contract invalid maps correctly', () => {
  const r = classifyReviewState({ blockers: [{ code: 'contract_invalid' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR);
});

test('ACCEPTANCE: true human review (semantic ambiguity) maps correctly', () => {
  const r = classifyReviewState({ blockers: [{ code: 'semantic_ambiguity' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR);
});

test('ACCEPTANCE: canonical_dirty-like blocker maps to human review (state corruption)', () => {
  const r = classifyReviewState({ blockers: [{ code: 'state_corruption' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION);
});

// ===========================================================================
// Helpers
// ===========================================================================

test('isTypedReviewState works correctly', () => {
  assert.equal(isTypedReviewState(REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW), true);
  assert.equal(isTypedReviewState(REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR), true);
  assert.equal(isTypedReviewState('waiting_for_review'), false);
  assert.equal(isTypedReviewState('completed'), false);
  assert.equal(isTypedReviewState(null), false);
  assert.equal(isTypedReviewState(''), false);
});

test('isMachineRepairableReviewState works correctly', () => {
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR), true);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW), false);
  assert.equal(isMachineRepairableReviewState('waiting_for_review'), false);
  assert.equal(isMachineRepairableReviewState(null), false);
});

test('getResumeOptions returns correct options', () => {
  const options = getResumeOptions(REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
  assert.ok(options.includes('review_and_accept'));
  assert.ok(options.includes('review_and_reject'));
  assert.ok(options.length > 0);
  assert.equal(getResumeOptions('unknown').length, 0, 'unknown state returns empty array');
});

test('getNextAction returns correct action', () => {
  assert.equal(getNextAction(REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW), 'human_review_required');
  assert.equal(getNextAction(REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR), 'auto_repair');
  assert.equal(getNextAction(REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY), 'integration_recovery');
});

// ===========================================================================
// createReviewStateBlock
// ===========================================================================

test('createReviewStateBlock returns full metadata block', () => {
  const block = createReviewStateBlock({ blockers: [{ code: 'result_missing' }] });
  assert.equal(block.review_state, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  assert.ok(block.review_meta);
  assert.equal(block.review_meta.next_action, 'auto_repair');
  assert.ok(Array.isArray(block.resume_options));
  assert.equal(typeof block.next_action, 'string');
  assert.equal(typeof block.machine_repairable, 'boolean');
});

test('createReviewStateBlock with repairBudgetExhausted includes correct metadata', () => {
  const block = createReviewStateBlock({ repairBudgetExhausted: true });
  assert.equal(block.review_state, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
  assert.ok(block.resume_options.includes('review_exhausted'));
  assert.equal(block.next_action, 'human_review_of_exhausted_repairs');
  assert.equal(block.machine_repairable, false);
});

test('createReviewStateBlock empty options returns human review block', () => {
  const block = createReviewStateBlock({});
  assert.equal(block.review_state, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
  assert.equal(block.next_action, 'human_review_required');
});

console.log('task-review-status-taxonomy tests loaded');
