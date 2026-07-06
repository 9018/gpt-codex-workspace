/**
 * P0-AFC4: Finalizer Apply Decision — tests
 *
 * Tests:
 * 1. reconcileTaskClosure sets unified_decision when R1 normalizes finalizer
 * 2. reconcileTaskClosure sets unified_decision when R4 normalizes finalizer
 * 3. reconcileTaskClosure sets unified_decision for R3 (both agree, task stale)
 * 4. determineGoalStatus returns completed from unified_decision even with blockers
 * 5. determineGoalStatus returns completed from unified_decision even with verification failures
 * 6. determineGoalStatus returns completed from unified_decision without blocking_passed
 * 7. Canonical unified_decision from reconciler flows to determineGoalStatus
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileTaskClosure } from '../src/closure/task-closure-reconciler.mjs';
import { determineGoalStatus } from '../src/goal-convergence.mjs';
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

function makeUnifiedDecisionCompleted() {
  return {
    status: 'completed',
    blocking_passed: true,
    safe_to_auto_advance: true,
    requires_review: false,
    requires_repair: false,
    requires_integration: false,
    requires_restart: false,
    source: 'reconciler',
    reconciled: true,
    normalized_at: new Date().toISOString(),
  };
}

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
    closure_decision: makeCompletedClosureDecision(),
    finalizer_decision: makeCompletedFinalizer(),
    ...overrides,
  };
}

// ===========================================================================
// Test 1: R1 sets unified_decision when all evidence present
// ===========================================================================

test('AFC4-R1: reconcileTaskClosure sets unified_decision in R1 (finalizer stale)', () => {
  const taskResult = buildFullEvidence({
    closure_decision: makeCompletedClosureDecision(),
    finalizer_decision: makeStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.unified_decision.status, 'completed');
  assert.equal(result.taskResult.unified_decision.blocking_passed, true);
  assert.equal(result.taskResult.unified_decision.safe_to_auto_advance, true);
  assert.equal(result.taskResult.unified_decision.source, 'reconciler');
});

// ===========================================================================
// Test 2: R4 sets unified_decision when task+closure agree, finalizer stale
// ===========================================================================

test('AFC4-R4: reconcileTaskClosure sets unified_decision in R4 (task+closure agree)', () => {
  const taskResult = buildFullEvidence({
    status: 'completed',
    closure_decision: makeCompletedClosureDecision(),
    finalizer_decision: makeStaleReviewFinalizer(),
  });

  const result = reconcileTaskClosure({ taskStatus: 'completed', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.unified_decision.status, 'completed');
  assert.equal(result.taskResult.unified_decision.blocking_passed, true);
  assert.equal(result.taskResult.unified_decision.safe_to_auto_advance, true);
});

// ===========================================================================
// Test 3: R3 sets unified_decision (both decisions agree, task.status stale)
// ===========================================================================

test('AFC4-R3: reconcileTaskClosure sets unified_decision in R3 (both agree)', () => {
  const taskResult = buildFullEvidence();

  const result = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.taskResult.unified_decision.status, 'completed');
});

// ===========================================================================
// Test 4: determineGoalStatus trusts unified_decision over blockers
// ===========================================================================

test('AFC4-G1: determineGoalStatus returns completed from unified_decision despite blockers', () => {
  // Goal convergence MUST NOT re-derive status from raw evidence when
  // unified_decision says 'completed'. Older blocker findings cannot override.
  const taskResult = {
    unified_decision: makeUnifiedDecisionCompleted(),
    acceptance_findings: [
      { severity: 'blocker', code: 'test_failed', message: 'Old test failure', resolved: false },
      { severity: 'major', code: 'audit_missing', message: 'Old audit evidence missing', resolved: false },
    ],
  };
  const goal = { status: 'running' };
  const task = { status: 'completed' };

  const status = determineGoalStatus(goal, task, taskResult);

  assert.equal(status, 'completed', 'should return completed despite blockers when unified_decision exists');
});

// ===========================================================================
// Test 5: determineGoalStatus trusts unified_decision over verification failures
// ===========================================================================

test('AFC4-G2: determineGoalStatus returns completed from unified_decision despite verification failures', () => {
  // Verification failures in the task result must NOT override a completed
  // unified_decision.
  const taskResult = {
    unified_decision: makeUnifiedDecisionCompleted(),
    verification: { passed: false, findings: [{ severity: 'blocker', code: 'verification_failed' }] },
    acceptance_findings: [{ severity: 'blocker', code: 'verification_failed', resolved: false }],
  };
  const goal = { status: 'running' };
  const task = { status: 'completed' };

  const status = determineGoalStatus(goal, task, taskResult);

  assert.equal(status, 'completed', 'should return completed despite verification failures');
});

// ===========================================================================
// Test 6: determineGoalStatus trusts unified_decision even without blocking_passed
// ===========================================================================

test('AFC4-G3: determineGoalStatus returns completed from unified_decision even without blocking_passed', () => {
  // The canonical decision alone (status=completed) is sufficient for goal
  // status derivation.  blocking_passed and safe_to_auto_advance are not
  // required.
  const taskResult = {
    unified_decision: {
      status: 'completed',
      // No blocking_passed or safe_to_auto_advance set — simulating minimal
      // canonical decision from reconciler
      source: 'reconciler',
      reconciled: true,
    },
    // Older evidence fields that could lead to a different conclusion
    acceptance_findings: [
      { severity: 'blocker', code: 'old_blocker', message: 'Old data', resolved: false },
    ],
  };
  const goal = { status: 'running' };
  const task = { status: 'completed' };

  const status = determineGoalStatus(goal, task, taskResult);

  assert.equal(status, 'completed', 'should return completed even without blocking_passed or safe_to_auto_advance');
});

// ===========================================================================
// Test 7: unified_decision from reconciler flows through to goal convergence
// ===========================================================================

test('AFC4-R-G: canonical unified_decision from reconciler flows to determineGoalStatus', () => {
  // Integration test: Reconcile, then feed reconciled result to
  // determineGoalStatus and verify the goal-completed path.
  const taskResult = buildFullEvidence({
    closure_decision: makeCompletedClosureDecision(),
    finalizer_decision: makeStaleReviewFinalizer(),
  });

  const reconciliation = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult });

  assert.equal(reconciliation.reconciled, true);
  assert.ok(reconciliation.taskResult.unified_decision, 'unified_decision must be set');

  // Now feed the reconciled result to determineGoalStatus
  const goal = { status: 'running', id: 'goal_test7' };
  const task = { status: 'completed', id: 'task_test7' };
  const goalStatus = determineGoalStatus(goal, task, reconciliation.taskResult);

  assert.equal(goalStatus, 'completed', 'goal status must be completed after reconciliation');
});

// ===========================================================================
// Test 8: applyTaskFinalState uses canonical decision (load-time behavioral test)
// ===========================================================================


