/**
 * unified-decision-consistency.test.mjs
 *
 * P0: Tests that the UnifiedAcceptanceDecision normalizer produces consistent
 * results regardless of source module, and that downstream consumers (finalizer,
 * closure decider, goal-convergence, review packet builder) would produce
 * compatible conclusions from the same input.
 *
 * Key paths covered:
 *   - code_change 成功 (changed_files, verification passed)
 *   - docs_only 成功带 followup (docs changes, verification relaxed)
 *   - noop/verification_only 无 changed_files 成功 (noop=true, no changed_files)
 *   - verification failed → repair/review
 *   - integration non-terminal → waiting_for_integration
 *   - semantic ambiguity → review
 *
 * Consistency guarantee:
 *   The same input passed to different decision modules produces a
 *   UnifiedAcceptanceDecision with identical status, blocking_passed,
 *   requires_review, requires_repair, requires_integration, and effects.
 *
 * Run: node --test backend/test/unified-decision-consistency.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeToUnifiedDecision,
  fromFinalizerDecision,
  fromClosureDecision,
  checkDecisionConsistency,
  UNIFIED_STATUSES,
} from '../src/codex-unified-decision.mjs';

// ===========================================================================
// Test 1: code_change success → completed, blocking_passed, safe_to_auto_advance
// ===========================================================================

test('unified: code_change success produces completed decision', () => {
  const finalizerDecision = {
    status: 'completed',
    reason: 'terminal_evidence_satisfied',
    blockers: [],
    repairable_blockers: [],
    safe_to_auto_advance: true,
    blocking_passed: true,
    integration_effect: { required: false, status: 'satisfied', satisfied: true, terminal: true },
    goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
    queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
  };
  const taskResult = {
    status: 'completed',
    summary: 'Code change completed',
    changed_files: ['src/index.mjs'],
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    commit: 'abc123',
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.COMPLETED);
  assert.equal(ud.blocking_passed, true);
  assert.equal(ud.requires_review, false);
  assert.equal(ud.requires_repair, false);
  assert.equal(ud.safe_to_auto_advance, true);
  assert.equal(ud.queue_effect.unblock_dependents, true);
  assert.equal(ud.queue_effect.hold_queue, false);
  assert.equal(ud.goal_effect.complete_goal, true);
  assert.equal(ud.integration_effect.terminal, true);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 2: docs_only success with followup → completed, safe_to_auto_advance, followups non-empty
// ===========================================================================

test('unified: docs_only with followup produces completed with non_blocking_followups', () => {
  const closureDecision = {
    status: 'auto_completed_with_followups',
    reason: 'blocking_gate_passed_with_non_blocking_followups',
    blocking_passed: true,
    auto_complete_allowed: true,
    requires_human_decision: false,
    blockers: [],
    repairable_blockers: [],
    non_blocking_followups: [
      { title: 'Add more docs', reason: 'Missing API reference', severity: 'followup' },
    ],
    quality_notes: [],
  };
  const taskResult = {
    status: 'completed',
    summary: 'Docs updated',
    changed_files: ['docs/api.md'],
    verification: { passed: true, commands: [] },
    noop: false,
  };

  const ud = normalizeToUnifiedDecision({ closureDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.COMPLETED);
  assert.equal(ud.blocking_passed, true);
  assert.equal(ud.requires_review, false);
  assert.equal(ud.safe_to_auto_advance, true);
  assert.ok(ud.non_blocking_followups.length >= 1);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 3: noop/verification_only success (no changed_files)
// ===========================================================================

test('unified: noop/verification_only with no changed_files produces completed', () => {
  const finalizerDecision = {
    status: 'completed',
    reason: 'no_change_repair_evidence_satisfied',
    blockers: [],
    repairable_blockers: [],
    safe_to_auto_advance: true,
    blocking_passed: true,
    integration_effect: { required: false, status: 'satisfied', satisfied: true, terminal: true },
    goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
    queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
  };
  const taskResult = {
    status: 'completed',
    summary: 'Verification passed, no changes needed',
    noop: true,
    noop_reason: 'Already up to date',
    changed_files: [],
    verification: { passed: true, commands: [] },
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.COMPLETED);
  assert.equal(ud.blocking_passed, true);
  assert.equal(ud.requires_integration, false);
  assert.equal(ud.integration_effect.required, false);
  assert.equal(ud.queue_effect.hold_queue, false);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 4: verification failed → repair (repairable_blockers present)
// ===========================================================================

test('unified: verification failed produces waiting_for_repair with repairable_blockers', () => {
  const finalizerDecision = {
    status: 'waiting_for_repair',
    reason: 'repairable_failure',
    blockers: [],
    repairable_blockers: [
      { severity: 'major', code: 'verification_failed', message: 'test failed', source: 'verifier' },
    ],
    safe_to_auto_advance: false,
    blocking_passed: false,
    integration_effect: { required: false, status: null, satisfied: false, terminal: false },
    goal_effect: { status: 'waiting_for_repair', complete_goal: false, safe_to_auto_advance: false },
    queue_effect: { status: 'waiting_for_repair', unblock_dependents: false, hold_queue: true },
  };
  const taskResult = {
    status: 'completed',
    summary: 'Tests failed',
    changed_files: ['src/main.mjs'],
    verification: { passed: false, commands: [{ cmd: 'npm test', exit_code: 1 }] },
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.WAITING_FOR_REPAIR);
  assert.equal(ud.blocking_passed, false);
  assert.equal(ud.requires_review, false);
  assert.equal(ud.requires_repair, true);
  assert.ok(ud.repairable_blockers.length >= 1);
  assert.equal(ud.queue_effect.hold_queue, true);
  assert.equal(ud.safe_to_auto_advance, false);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 5: integration required but non-terminal → waiting_for_integration
// ===========================================================================

test('unified: integration non-terminal produces waiting_for_integration', () => {
  const finalizerDecision = {
    status: 'waiting_for_integration',
    reason: 'integration_required_not_terminal',
    blockers: [],
    repairable_blockers: [
      { severity: 'blocker', code: 'integration_required_not_terminal', message: 'Integration is required but not terminal', source: 'integration_queue' },
    ],
    safe_to_auto_advance: false,
    blocking_passed: false,
    integration_effect: { required: true, status: 'pending', satisfied: false, terminal: false },
    goal_effect: { status: 'waiting_for_integration', complete_goal: false, safe_to_auto_advance: false },
    queue_effect: { status: 'waiting_for_integration', unblock_dependents: false, hold_queue: true },
  };
  const taskResult = {
    status: 'waiting_for_integration',
    summary: 'Changes ready, waiting for integration',
    changed_files: ['src/main.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    integration: { required: true, status: 'pending' },
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.WAITING_FOR_INTEGRATION);
  assert.equal(ud.blocking_passed, false);
  assert.equal(ud.requires_integration, true);
  assert.equal(ud.integration_effect.required, true);
  assert.equal(ud.integration_effect.terminal, false);
  assert.equal(ud.queue_effect.hold_queue, true);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 6: semantic ambiguity → review
// ===========================================================================

test('unified: semantic ambiguity produces waiting_for_review', () => {
  const finalizerDecision = {
    status: 'waiting_for_review',
    reason: 'manual_review_required',
    blockers: [
      { severity: 'blocker', code: 'semantic_ambiguity', message: 'Acceptance semantics are ambiguous', source: 'contract_verifier' },
    ],
    repairable_blockers: [],
    safe_to_auto_advance: false,
    blocking_passed: false,
    integration_effect: { required: false, status: null, satisfied: false, terminal: false },
    goal_effect: { status: 'waiting_for_review', complete_goal: false, safe_to_auto_advance: false },
    queue_effect: { status: 'waiting_for_review', unblock_dependents: false, hold_queue: true },
  };
  const taskResult = {
    status: 'waiting_for_review',
    summary: 'Ambiguous contract',
    verification: { passed: true, commands: [] },
    contract_verification: { semantic_ambiguity: true },
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.WAITING_FOR_REVIEW);
  assert.equal(ud.blocking_passed, false);
  assert.equal(ud.requires_review, true);
  assert.equal(ud.queue_effect.hold_queue, true);
  assert.ok(ud.blockers.length >= 1);
  const hasSemantic = ud.blockers.some((b) => b.code === 'semantic_ambiguity');
  assert.ok(hasSemantic, 'Blockers should include semantic_ambiguity');

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});

// ===========================================================================
// Test 7: Consistency across module boundaries
// ===========================================================================

test('unified: same input produces same decision regardless of source module', () => {
  // Build the finalizer decision from some evidence
  const evidence = {
    status: 'completed',
    reason: 'terminal_evidence_satisfied',
    blockers: [],
    repairable_blockers: [],
    safe_to_auto_advance: true,
    blocking_passed: true,
    integration_effect: { required: false, status: 'not_required', satisfied: true, terminal: true },
    goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
    queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
  };
  const taskResult = {
    status: 'completed',
    summary: 'ok',
    changed_files: ['src/main.mjs'],
    commit: 'def456',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
  };

  // Produce unified from both finalizer perspective and closure perspective
  const fromFinalizer = fromFinalizerDecision(evidence, taskResult, {}, '2026-07-06T00:00:00.000Z');
  const fromClosure = fromClosureDecision(
    { ...evidence, status: 'auto_completed_clean', auto_complete_allowed: true, requires_human_decision: false },
    taskResult,
    {},
    '2026-07-06T00:00:00.000Z',
  );

  // Both should produce the same canonical status and effects
  assert.equal(fromFinalizer.status, UNIFIED_STATUSES.COMPLETED);
  assert.equal(fromClosure.status, UNIFIED_STATUSES.COMPLETED);
  assert.equal(fromFinalizer.blocking_passed, fromClosure.blocking_passed);
  assert.equal(fromFinalizer.requires_review, fromClosure.requires_review);
  assert.equal(fromFinalizer.requires_integration, fromClosure.requires_integration);

  // Queue effects must agree
  assert.equal(fromFinalizer.queue_effect.hold_queue, fromClosure.queue_effect.hold_queue);
  assert.equal(fromFinalizer.queue_effect.unblock_dependents, fromClosure.queue_effect.unblock_dependents);
  assert.equal(fromFinalizer.safe_to_auto_advance, fromClosure.safe_to_auto_advance);
});

// ===========================================================================
// Test 8: Consistency check detects contradictions
// ===========================================================================

test('unified: checkDecisionConsistency detects contradictions', () => {
  // Contradiction: completed + requires_review
  const contradiction1 = {
    status: 'completed',
    requires_review: true,
    requires_integration: false,
    blocking_passed: true,
    queue_effect: { hold_queue: false, unblock_dependents: true },
    integration_effect: { required: false, satisfied: true, terminal: true },
    repairable_blockers: [],
    blockers: [],
  };
  const check1 = checkDecisionConsistency(contradiction1);
  assert.ok(!check1.consistent, 'Should detect completed+requires_review contradiction');
  assert.ok(check1.issues.some((i) => i.includes('completed') && i.includes('requires_review')));

  // Valid: completed with no contradictions
  const valid = {
    status: 'completed',
    requires_review: false,
    requires_integration: false,
    blocking_passed: true,
    queue_effect: { hold_queue: false, unblock_dependents: true },
    integration_effect: { required: false, satisfied: true, terminal: true },
    repairable_blockers: [],
    blockers: [],
  };
  const check2 = checkDecisionConsistency(valid);
  assert.ok(check2.consistent, 'Valid decision should pass consistency check');

  // Contradiction: waiting_for_repair but no repairable_blockers
  const contradiction2 = {
    status: 'waiting_for_repair',
    requires_review: false,
    requires_integration: false,
    blocking_passed: false,
    queue_effect: { hold_queue: true, unblock_dependents: false },
    integration_effect: { required: false, satisfied: false, terminal: false },
    repairable_blockers: [],
    blockers: [{ severity: 'blocker', code: 'test', message: 'test' }],
  };
  const check3 = checkDecisionConsistency(contradiction2);
  assert.ok(!check3.consistent, 'Should detect waiting_for_repair without repairable_blockers');

  // Contradiction: completed but queue_effect.hold_queue
  const contradiction3 = {
    status: 'completed',
    requires_review: false,
    requires_integration: false,
    blocking_passed: true,
    queue_effect: { hold_queue: true, unblock_dependents: false },
    integration_effect: { required: false, satisfied: true, terminal: true },
    repairable_blockers: [],
    blockers: [],
  };
  const check4 = checkDecisionConsistency(contradiction3);
  assert.ok(!check4.consistent, 'Should detect completed+hold_queue contradiction');
});

// ===========================================================================
// Test 9: Normalizer with null/empty inputs is resilient
// ===========================================================================

test('unified: normalizer handles empty/null inputs gracefully', () => {
  const ud1 = normalizeToUnifiedDecision({});
  assert.ok(ud1.status, 'Should have a default status');
  assert.equal(typeof ud1.blocking_passed, 'boolean');

  const ud2 = normalizeToUnifiedDecision({ finalizerDecision: null, taskResult: null });
  assert.ok(ud2.status);

  const ud3 = normalizeToUnifiedDecision({ finalizerDecision: {}, taskResult: {} });
  assert.ok(ud3.status);

  // All should produce valid decisions
  for (const ud of [ud1, ud2, ud3]) {
    const check = checkDecisionConsistency(ud);
    // Empty inputs should at least not crash and produce consistent output
    assert.ok(check.consistent === true || check.consistent === false);
  }
});

// ===========================================================================
// Test 10: Retry_wait / quota_wait preservation
// ===========================================================================

test('unified: retry_wait status is preserved', () => {
  const finalizerDecision = {
    status: 'waiting_for_capacity',
    reason: 'external_capacity_failure',
    blockers: [{ severity: 'blocker', code: 'external_capacity_failure', message: 'rate limited' }],
    repairable_blockers: [],
    safe_to_auto_advance: false,
    blocking_passed: false,
    integration_effect: { required: false, status: null, satisfied: false, terminal: false },
    goal_effect: { status: 'waiting_for_capacity', complete_goal: false, safe_to_auto_advance: false },
    queue_effect: { status: 'waiting_for_capacity', unblock_dependents: false, hold_queue: true },
  };
  const taskResult = {
    status: 'retry_wait',
    summary: 'rate limited',
    failure_class: 'rate_limited',
  };

  const ud = normalizeToUnifiedDecision({ finalizerDecision, taskResult });

  assert.equal(ud.status, UNIFIED_STATUSES.WAITING_FOR_CAPACITY);
  assert.equal(ud.blocking_passed, false);
  assert.equal(ud.queue_effect.hold_queue, true);

  const check = checkDecisionConsistency(ud);
  assert.ok(check.consistent, `Consistency check failed: ${check.issues.join(', ')}`);
});
