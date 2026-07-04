/**
 * task-closure-reconciler.test.mjs — P0-MA12-G2 regression tests
 *
 * Tests:
 * 1. verified + integrated + result artifact task auto-closes (R1)
 * 2. Missing artifact does not auto-close
 * 3. Stale finalizer_decision review is normalized when all evidence exists (R1)
 * 4. Stale closure_decision review is normalized when finalizer + evidence exist (R2)
 * 5. Both decisions agree, task.status stale (R3)
 * 6. Real human decision remains review (no reconciliation)
 * 7. task.status completed + closure agrees, finalizer stale (R4)
 * 8. task.status completed + finalizer agrees, closure stale (R5)
 * 9. Missing verification blocks reconciliation
 * 10. Missing integration blocks reconciliation
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileTaskClosure } from '../src/closure/task-closure-reconciler.mjs';
import { CLOSURE_STATUSES } from '../src/closure/auto-progress-policy.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletedClosureDecision() {
  return {
    status: CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN,
    reason: 'blocking_gate_passed_clean',
    auto_complete_allowed: true,
    blocking_passed: true,
    requires_human_decision: false,
    task_status: 'completed',
    blockers: [],
  };
}

function makeCompletedFinalizer() {
  return {
    status: 'completed',
    reason: 'terminal_evidence_satisfied',
    safe_to_auto_advance: true,
    blockers: [],
    repairable_blockers: [],
    goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
    queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
  };
}

function makeStaleReviewFinalizer() {
  return {
    status: 'waiting_for_review',
    reason: 'manual_review_required',
    safe_to_auto_advance: false,
    blockers: [{ severity: 'blocker', code: 'insufficient_terminal_evidence', message: 'requires review' }],
    repairable_blockers: [],
    goal_effect: { status: 'waiting_for_review', complete_goal: false, safe_to_auto_advance: false },
    queue_effect: { status: 'waiting_for_review', unblock_dependents: false, hold_queue: true },
  };
}

const buildCompletedClosure = makeCompletedClosureDecision;
const buildCompletedFinalizer = makeCompletedFinalizer;
const buildStaleReviewFinalizer = makeStaleReviewFinalizer;

function buildFullEvidence(overrides = {}) {
  return {
    status: 'completed',
    summary: 'Task completed successfully',
    changed_files: ['backend/src/closure/task-closure-reconciler.mjs'],
    commit: 'abc123def456',
    verification: { passed: true, findings: [], commands: [{ cmd: 'npm test', exit_code: 0 }] },
    integration: { status: 'merged', merged: true, satisfied: true },
    acceptance_gate: { passed: true, status: 'passed' },
    acceptance_findings: [],
    warnings: [],
    needs_integration: true,
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildCompletedFinalizer(),
    ...overrides,
  };
}

// ===========================================================================
// Test 1: verified+integrated+result artifact task auto-closes (R1)
// ===========================================================================

test('R1: verified+integrated+result artifact task auto-closes stale finalizer', () => {
  const taskResult = buildFullEvidence({
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true, 'should reconcile');
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.finalizer_decision.status, 'completed');
  assert.equal(result.taskResult.finalizer_decision.reconciled_from, 'waiting_for_review');
  assert.match(result.reason, /finalizer_decision normalized/);
});

// ===========================================================================
// Test 2: Missing artifact does not auto-close
// ===========================================================================

test('R2: missing result artifact does not auto-close', () => {
  const taskResult = buildFullEvidence({
    // Make all evidence present except verification
    verification: { passed: false, findings: [{ severity: 'blocker', code: 'verification_failed' }] },
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false);
  assert.equal(result.taskStatus, 'waiting_for_review');
  assert.equal(result.reason, null);
});

// ===========================================================================
// Test 3: Stale finalizer_decision review normalized when all evidence exists
// ===========================================================================

test('R3: stale finalizer_decision review normalized when all evidence exists', () => {
  const taskResult = buildFullEvidence({
    closure_decision: buildCompletedClosure(),
    finalizer_decision: {
      status: 'waiting_for_review',
      reason: 'manual_review_required',
      blockers: [{ severity: 'blocker', code: 'insufficient_terminal_evidence', message: 'stale review' }],
    },
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.finalizer_decision.status, 'completed');
  assert.equal(result.taskResult.finalizer_decision.reconciled_from, 'waiting_for_review');
});

// ===========================================================================
// Test 4: Stale closure_decision normalized when finalizer + evidence exist (R2)
// ===========================================================================

test('R4: stale closure_decision requires_review normalized when all evidence + finalizer exist', () => {
  const taskResult = buildFullEvidence({
    closure_decision: {
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'semantic_ambiguity',
      auto_complete_allowed: false,
      blocking_passed: false,
      requires_human_decision: true,
      task_status: 'waiting_for_review',
      blockers: [{ severity: 'blocker', code: 'semantic_ambiguity', message: 'stale' }],
    },
    finalizer_decision: buildCompletedFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'completed', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.closure_decision.status, CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN);
  assert.equal(result.taskResult.closure_decision.reconciled_from, 'requires_review');
  assert.match(result.reason, /closure_decision normalized/);
});

// ===========================================================================
// Test 5: Both decisions agree on completed, task.status stale (R3)
// ===========================================================================

test('R5: both decisions agree but task.status is stale', () => {
  const taskResult = buildFullEvidence();

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.match(result.reason, /both decisions agree on completion/);
});

// ===========================================================================
// Test 6: Real human decision remains review (no reconciliation)
// ===========================================================================

test('R6: human decision remains review when evidence missing', () => {
  // A human set closure_decision to requires_review, no full evidence
  const taskResult = buildFullEvidence({
    verification: { passed: false, findings: [{ severity: 'blocker', code: 'test_failed' }] },
    closure_decision: {
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'verification_failed',
      auto_complete_allowed: false,
      blocking_passed: false,
      requires_human_decision: true,
      task_status: 'waiting_for_review',
    },
    finalizer_decision: {
      status: 'waiting_for_review',
      reason: 'manual_review_required',
    },
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false, 'should not reconcile when evidence missing');
  assert.equal(result.taskStatus, 'waiting_for_review');
});

// ===========================================================================
// Test 7: task.status completed + closure agrees, finalizer stale (R4)
// ===========================================================================

test('R7: task.status completed + closure agrees, finalizer stale', () => {
  const taskResult = buildFullEvidence({
    status: 'completed',
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'completed', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.finalizer_decision.status, 'completed');
  assert.match(result.reason, /finalizer_decision normalized to completed/);
});

// ===========================================================================
// Test 8: task.status completed + finalizer agrees, closure stale (R5)
// ===========================================================================

test('R8: task.status completed + finalizer agrees, closure stale', () => {
  const taskResult = buildFullEvidence({
    status: 'completed',
    closure_decision: {
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'stale_review',
      auto_complete_allowed: false,
      blocking_passed: false,
      requires_human_decision: true,
      task_status: 'waiting_for_review',
    },
    finalizer_decision: buildCompletedFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'completed', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.closure_decision.status, CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN);
  assert.match(result.reason, /closure_decision normalized/);
});



test('MA12-G3: retained audit worktree warning does not block proven closure', () => {
  const taskResult = buildFullEvidence({
    warnings: ['Worktree retained: /tmp/task_x (status=waiting_for_review)'],
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.finalizer_decision.status, 'completed');
});

test('MA12-G3: explicit canonical dirty evidence still blocks closure', () => {
  const taskResult = buildFullEvidence({
    canonical_dirty: true,
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false);
  assert.equal(result.taskStatus, 'waiting_for_review');
});

// ===========================================================================
// Test 9: Missing verification blocks reconciliation
// ===========================================================================

test('R9: missing verification blocks reconciliation', () => {
  const taskResult = buildFullEvidence({
    verification: { passed: false, findings: [{ severity: 'blocker', code: 'test_failed' }] },
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false, 'should not reconcile without verification passing');
});

// ===========================================================================
// Test 10: Missing integration blocks reconciliation
// ===========================================================================

test('R10: missing integration blocks reconciliation', () => {
  const taskResult = buildFullEvidence({
    integration: { status: 'conflict', merged: false },
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false, 'should not reconcile when integration not satisfied');
});

// ===========================================================================
// Test 11: Unresolved blocking findings block reconciliation
// ===========================================================================

test('R11: unresolved blocking findings block reconciliation', () => {
  const taskResult = buildFullEvidence({
    acceptance_findings: [
      { severity: 'blocker', code: 'test_failed', message: 'test failure', resolved: false },
    ],
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false, 'should not reconcile when unresolved findings exist');
});

// ===========================================================================
// Test 12: Follow-ups present without full evidence do not reconcile
// ===========================================================================

test('R12: follow-ups present without full evidence do not reconcile', () => {
  const taskResult = buildFullEvidence({
    verification: { passed: true, findings: [] },
    integration: { status: 'merged', merged: true },
    acceptance_findings: [{ severity: 'blocker', code: 'audit_missing', resolved: false }],
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, false, 'should not reconcile when blockers present');
});

// ===========================================================================
// Test 13: Worktree retained blocks reconciliation
// ===========================================================================

test('R13: worktree retained blocks reconciliation', () => {
  const taskResult = buildFullEvidence({
    warnings: ['Worktree retained: /tmp/some-path (status=waiting_for_review)'],
    closure_decision: buildCompletedClosure(),
    finalizer_decision: buildStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
});

// ---------------------------------------------------------------------------
// Unused helpers
// ---------------------------------------------------------------------------

function buildTaskResult(overrides = {}) {
  return buildFullEvidence(overrides);
}
