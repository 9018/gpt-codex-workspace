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
  CANONICAL_REVIEW_CATEGORIES,
  CANONICAL_REVIEW_STATES,
} from '../src/task-review-status-taxonomy.mjs';

// ===========================================================================
// Constants and structure
// ===========================================================================

test('exports exactly 13 typed review states (7 legacy + 6 canonical P0-03)', () => {
  const values = Object.values(REVIEW_STATES);
  assert.equal(values.length, 13);
  assert.equal(new Set(values).size, 13, 'all values must be unique');
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
  // P0-03 canonical states
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_EVIDENCE_MISSING].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE].machine_repairable, true);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_REPAIR_BUDGET_EXHAUSTED].machine_repairable, false);
  assert.equal(REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED].machine_repairable, false);
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

  // Human required (P0-03 default for unknown codes)
  const unknown = classifyReviewState({ blockers: [{ code: 'some_unknown_code' }] });
  assert.equal(unknown.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
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

test('classifyReviewState: insufficient_terminal_evidence defaults to WAITING_FOR_HUMAN_REQUIRED (P0-03)', () => {
  const result = classifyReviewState({ blockers: [{ code: 'insufficient_terminal_evidence' }] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
  assert.equal(result.metadata.machine_repairable, false);
});

test('classifyReviewState: unhandled convergence case defaults to HUMAN_REQUIRED', () => {
  const result = classifyReviewState({ reason: 'unhandled convergence case', blockers: [] });
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
});

test('classifyReviewState: no blockers defaults to WAITING_FOR_HUMAN_REQUIRED (P0-03)', () => {
  const result = classifyReviewState({});
  assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
  assert.equal(result.metadata.machine_repairable, false);
  assert.equal(result.metadata.next_action, 'human_review_required');
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
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
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
  assert.equal(getNextAction(REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR), 'auto_repair_or_resolve');
  assert.equal(getNextAction(REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY), 'integration_recovery');
});

// ===========================================================================
// createReviewStateBlock
// ===========================================================================

test('createReviewStateBlock returns full metadata block', () => {
  const block = createReviewStateBlock({ blockers: [{ code: 'result_missing' }] });
  assert.equal(block.review_state, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  assert.ok(block.review_meta);
  assert.equal(block.review_meta.next_action, 'auto_repair_or_resolve');
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

test('createReviewStateBlock empty options returns WAITING_FOR_HUMAN_REQUIRED block', () => {
  const block = createReviewStateBlock({});
  assert.equal(block.review_state, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
  assert.equal(block.next_action, 'human_review_required');
  assert.equal(block.machine_repairable, false);
});


// ===========================================================================
// P0-03: New canonical state classification tests
// ===========================================================================

test('classifyReviewState: provider_unavailable code maps to PROVIDER_UNAVAILABLE', () => {
  const r = classifyReviewState({ blockers: [{ code: 'provider_unavailable' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE);
  assert.ok(r.metadata.machine_repairable);
  assert.equal(r.metadata.next_action, 'auto_retry');
});

test('classifyReviewState: rate_limited maps to PROVIDER_UNAVAILABLE', () => {
  const r = classifyReviewState({ blockers: [{ code: 'rate_limited' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE);
});

test('classifyReviewState: gateway_error maps to PROVIDER_UNAVAILABLE', () => {
  const r = classifyReviewState({ blockers: [{ code: 'gateway_error' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE);
});

test('classifyReviewState: policy_uncertain code maps to POLICY_UNCERTAIN', () => {
  const r = classifyReviewState({ blockers: [{ code: 'policy_uncertain' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN);
  assert.ok(r.metadata.machine_repairable);
  assert.equal(r.metadata.next_action, 'chat_proposal');
});

test('classifyReviewState: policy_ambiguous maps to POLICY_UNCERTAIN', () => {
  const r = classifyReviewState({ blockers: [{ code: 'policy_ambiguous' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN);
});

test('classifyReviewState: acceptance_policy_uncertain via reason maps to POLICY_UNCERTAIN', () => {
  const r = classifyReviewState({ reason: 'acceptance_policy_uncertain', blockers: [] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN);
});

test('classifyReviewState: evidence_missing code maps to EVIDENCE_MISSING', () => {
  const r = classifyReviewState({ blockers: [{ code: 'evidence_missing' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_EVIDENCE_MISSING);
  assert.ok(r.metadata.machine_repairable);
  assert.equal(r.metadata.next_action, 'auto_repair');
});

test('classifyReviewState: evidence_missing reason maps to EVIDENCE_MISSING', () => {
  const r = classifyReviewState({ reason: 'evidence_missing', blockers: [] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_EVIDENCE_MISSING);
});

test('classifyReviewState: human_required code maps to HUMAN_REQUIRED', () => {
  const r = classifyReviewState({ blockers: [{ code: 'human_required' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
  assert.equal(r.metadata.machine_repairable, false);
  assert.equal(r.metadata.next_action, 'human_review_required');
});

test('classifyReviewState: needs_human reason maps to HUMAN_REQUIRED', () => {
  const r = classifyReviewState({ reason: 'needs_human', blockers: [] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED);
});

test('classifyReviewState: integration_uncertain code maps to INTEGRATION_UNCERTAIN', () => {
  const r = classifyReviewState({ blockers: [{ code: 'integration_uncertain' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN);
  assert.ok(r.metadata.machine_repairable);
  assert.equal(r.metadata.next_action, 'integration_recovery');
});

test('classifyReviewState: repo_dirty maps to INTEGRATION_UNCERTAIN', () => {
  const r = classifyReviewState({ blockers: [{ code: 'repo_dirty' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN);
});

test('classifyReviewState: merge_state_ambiguous maps to INTEGRATION_UNCERTAIN', () => {
  const r = classifyReviewState({ blockers: [{ code: 'merge_state_ambiguous' }] });
  assert.equal(r.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN);
});

test('classifyReviewState: repairBudgetExhausted still maps to legacy state (backward compat)', () => {
  const r = classifyReviewState({ repairBudgetExhausted: true });
  assert.equal(r.reviewState, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
  assert.equal(r.metadata.machine_repairable, false);
});

test('CANONICAL_REVIEW_CATEGORIES exports 6 categories', () => {
  const values = Object.values(CANONICAL_REVIEW_CATEGORIES);
  assert.equal(values.length, 6);
  assert.equal(new Set(values).size, 6);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.EVIDENCE_MISSING);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.POLICY_UNCERTAIN);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.INTEGRATION_UNCERTAIN);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.REPAIR_BUDGET_EXHAUSTED);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.PROVIDER_UNAVAILABLE);
  assert.ok(CANONICAL_REVIEW_CATEGORIES.HUMAN_REQUIRED);
});

test('CANONICAL_REVIEW_STATES contains all 6 canonical state values', () => {
  for (const value of Object.values(CANONICAL_REVIEW_CATEGORIES)) {
    assert.equal(CANONICAL_REVIEW_STATES.has(value), true);
  }
});

test('isMachineRepairableReviewState works for P0-03 canonical states', () => {
  // Use canonical REVIEW_STATES values (full state names)
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_EVIDENCE_MISSING), true);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_POLICY_UNCERTAIN), true);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_INTEGRATION_UNCERTAIN), true);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_PROVIDER_UNAVAILABLE), true);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_REPAIR_BUDGET_EXHAUSTED), false);
  assert.equal(isMachineRepairableReviewState(REVIEW_STATES.WAITING_FOR_HUMAN_REQUIRED), false);
  // Also test with bare canonical string keys via isTypedReviewState
  assert.equal(isTypedReviewState('waiting_for_evidence_missing'), true);
  assert.equal(isTypedReviewState('waiting_for_human_required'), true);
  assert.equal(isTypedReviewState('waiting_for_policy_uncertain'), true);
});

console.log('task-review-status-taxonomy tests loaded');
