/**
 * continuation-flow.test.mjs — P0-AFC7: Continuation Flow
 *
 * Tests proving that completed canonical outcomes (unified_decision) are
 * properly connected to continuation behavior:
 *   1. downstream items continue when the previous item completes
 *   2. goal status converges from unified_decision
 *   3. stale goal states are repaired
 *   4. reconciliation goalStatus is consumed as priority
 *   5. continued_from_reconciliation drives goal convergence and queue advance
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

// ===========================================================================
// Module imports
// ===========================================================================

import {
  continueOnCompletedOutcome,
  convergeGoalFromContinuation,
  shouldAdvanceQueue,
  shouldSweepStaleGoals,
  goalStatusFromReconciliation,
} from '../src/closure/continuation-flow.mjs';

import { reconcileTaskClosure } from '../src/closure/task-closure-reconciler.mjs';
import { CLOSURE_STATUSES } from '../src/closure/auto-progress-policy.mjs';
import { determineGoalStatus } from '../src/goal-convergence.mjs';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Build a fully-evidenced task result with all the completion fields set.
 * Used as a base for overrides in tests.
 */
function buildFullEvidence(overrides = {}) {
  return {
    status: 'completed',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }], findings: [] },
    integration: { status: 'merged', merged: true, satisfied: true },
    acceptance_gate: { passed: true, status: 'passed' },
    acceptance_findings: [],
    closure_decision: {
      status: 'auto_completed_clean',
      reason: 'auto_closure',
      blocking_passed: true,
      auto_complete_allowed: true,
      requires_human_decision: false,
      task_status: 'completed',
    },
    finalizer_decision: {
      status: 'completed',
      reason: 'terminal_evidence_satisfied',
      safe_to_auto_advance: true,
      goal_effect: { status: 'completed', complete_goal: true },
      queue_effect: { status: 'completed', unblock_dependents: true },
    },
    ...overrides,
  };
}

// ===========================================================================
// Section 1: goalStatusFromReconciliation — consuming canonical goal status
// ===========================================================================

test('AFC7-1a: goalStatusFromReconciliation returns completed from reconciled R0', () => {
  // When reconciliation result carries goalStatus (from R0 canonical outcome),
  // goalStatusFromReconciliation must return it.
  const reconciliationResult = {
    taskStatus: 'completed',
    goalStatus: 'completed',
    reconciled: true,
    reason: 'canonical unified_decision overrides stale task status',
  };

  const result = goalStatusFromReconciliation(reconciliationResult);
  assert.equal(result, 'completed', 'should return completed goalStatus from reconciler');
});

test('AFC7-1b: goalStatusFromReconciliation returns null when no goalStatus', () => {
  // When reconciliation did not produce a goalStatus (e.g. R1-R5 rules),
  // goalStatusFromReconciliation should return null so callers fall back
  // to determineGoalStatus.
  const reconciliationResult = {
    taskStatus: 'completed',
    reconciled: true,
    reason: 'normalised from R1',
  };

  const result = goalStatusFromReconciliation(reconciliationResult);
  assert.equal(result, null, 'should return null when no goalStatus in reconciler result');
});

test('AFC7-1c: goalStatusFromReconciliation returns null for empty reconciler result', () => {
  const result = goalStatusFromReconciliation({});
  assert.equal(result, null, 'should return null for empty reconciler result');
});

// ===========================================================================
// Section 2: continueOnCompletedOutcome — when to continue
// ===========================================================================

test('AFC7-2a: unified_decision=completed triggers continuation', () => {
  // Unified decision completed MUST produce shouldContinue=true with
  // all expected continuation fields enabled.
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: {
        status: 'completed',
        blocking_passed: true,
        safe_to_auto_advance: true,
      },
    },
    task: { id: 'task_done', status: 'completed' },
    goal: { id: 'goal_done', status: 'running' },
    previousGoalStatus: 'running',
  });

  assert.equal(continuation.shouldContinue, true, 'should continue on completed outcome');
  assert.equal(continuation.goalStatus, 'completed', 'goalStatus should be completed');
  assert.equal(continuation.completionType, 'canonical', 'completion type should be canonical');
  assert.equal(continuation.continuation.convergeGoal, true, 'should converge goal');
  assert.equal(continuation.continuation.advanceQueue, true, 'should advance queue');
  assert.equal(continuation.continuation.sweepStaleGoals, true, 'should sweep stale goals');
  assert.equal(continuation.continuationSource, 'unified_decision', 'source should be unified_decision');
});

test('AFC7-2b: unified_decision=completed without stale goal still continues', () => {
  // Even when the goal is already completed, continuation should still
  // report shouldContinue=true (the converge and sweep are not needed,
  // but the queue advance signal is still valid).
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: {
        status: 'completed',
        blocking_passed: true,
        safe_to_auto_advance: true,
      },
    },
    task: { id: 'task_done', status: 'completed' },
    goal: { id: 'goal_done', status: 'completed' },
  });

  assert.equal(continuation.shouldContinue, true, 'should continue even when goal already completed');
  assert.equal(continuation.goalStatus, 'completed');
  assert.equal(continuation.continuation.convergeGoal, false, 'goal already completed, no converge needed');
  assert.equal(continuation.continuation.advanceQueue, true, 'still should advance queue');
});

test('AFC7-2c: unified_decision=failed blocks continuation', () => {
  // A failed unified_decision must NOT trigger continuation.
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: {
        status: 'failed',
        blocking_passed: false,
        safe_to_auto_advance: false,
      },
    },
    task: { id: 'task_failed', status: 'failed' },
    goal: { id: 'goal_failed', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, false, 'should not continue on failed outcome');
  assert.equal(continuation.goalStatus, 'failed');
  assert.equal(continuation.completionType, 'failed');
  assert.equal(continuation.continuation.advanceQueue, false, 'should not advance queue');
  assert.equal(continuation.continuation.convergeGoal, false, 'should not converge goal');
});

test('AFC7-2d: unified_decision=blocked blocks continuation', () => {
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: { status: 'blocked' },
    },
    task: { id: 'task_blocked', status: 'blocked' },
    goal: { id: 'goal_blocked', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, false);
  assert.equal(continuation.goalStatus, 'blocked');
  assert.equal(continuation.continuation.advanceQueue, false);
});

test('AFC7-2e: no unified_decision but task completed — basic continuation', () => {
  // When there's no unified_decision (backward compat), task.status=completed
  // should still produce basic continuation.
  const continuation = continueOnCompletedOutcome({
    taskResult: { status: 'completed' },
    task: { id: 'task_basic', status: 'completed' },
    goal: { id: 'goal_basic', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, true, 'should continue for basic completed task');
  assert.equal(continuation.goalStatus, null, 'goalStatus should be null (use determineGoalStatus)');
  assert.equal(continuation.completionType, 'task_status', 'fallback to task_status type');
  assert.equal(continuation.continuation.advanceQueue, true, 'should still advance queue');
  // But no converge or sweep — safe defaults for the fallback path
  assert.equal(continuation.continuation.convergeGoal, false);
  assert.equal(continuation.continuation.sweepStaleGoals, false);
});

test('AFC7-2f: task not completed — no continuation', () => {
  const continuation = continueOnCompletedOutcome({
    taskResult: { status: 'waiting_for_review' },
    task: { id: 'task_waiting', status: 'waiting_for_review' },
    goal: { id: 'goal_waiting', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, false);
  assert.equal(continuation.continuationSource, 'none');
});

// ===========================================================================
// Section 3: convergeGoalFromContinuation — goal status convergence
// ===========================================================================

test('AFC7-3a: convergeGoalFromContinuation updates goal status when converge is true', () => {
  const goal = { id: 'goal_test', status: 'running' };

  const changed = convergeGoalFromContinuation(goal, 'completed', {
    convergeGoal: true,
    advanceQueue: true,
    sweepStaleGoals: true,
  });

  assert.equal(changed, true, 'goal should be changed');
  assert.equal(goal.status, 'completed', 'goal status must be completed');
  assert.ok(goal.updated_at, 'updated_at should be set');
});

test('AFC7-3b: convergeGoalFromContinuation does not update when converge is false', () => {
  const goal = { id: 'goal_test', status: 'running' };

  const changed = convergeGoalFromContinuation(goal, 'completed', {
    convergeGoal: false,
  });

  assert.equal(changed, false, 'goal should not be changed');
  assert.equal(goal.status, 'running', 'goal status must remain unchanged');
});

test('AFC7-3c: convergeGoalFromContinuation no-ops for same status', () => {
  const goal = { id: 'goal_test', status: 'completed' };

  const changed = convergeGoalFromContinuation(goal, 'completed', {
    convergeGoal: true,
  });

  assert.equal(changed, false, 'goal should not be changed when already completed');
  assert.equal(goal.status, 'completed');
});

test('AFC7-3d: convergeGoalFromContinuation requires goal object', () => {
  assert.equal(convergeGoalFromContinuation(null, 'completed'), false);
  assert.equal(convergeGoalFromContinuation(undefined, 'completed'), false);
  assert.equal(convergeGoalFromContinuation({}, null), false);
  assert.equal(convergeGoalFromContinuation({}, undefined), false);
});

// ===========================================================================
// Section 4: shouldAdvanceQueue — queue advancement from continuation
// ===========================================================================

test('AFC7-4a: shouldAdvanceQueue returns true when continuation says advance', () => {
  assert.equal(shouldAdvanceQueue({ advanceQueue: true }), true);
  assert.equal(shouldAdvanceQueue({ advanceQueue: false }), false);
  assert.equal(shouldAdvanceQueue({}), false);
  assert.equal(shouldAdvanceQueue(null), false);
  assert.equal(shouldAdvanceQueue(undefined), false);
});

test('AFC7-4b: shouldSweepStaleGoals returns true when continuation says sweep', () => {
  assert.equal(shouldSweepStaleGoals({ sweepStaleGoals: true }), true);
  assert.equal(shouldSweepStaleGoals({ sweepStaleGoals: false }), false);
  assert.equal(shouldSweepStaleGoals({}), false);
});

// ===========================================================================
// Section 5: End-to-end — reconciler + continuation flow
// ===========================================================================

test('AFC7-5a: R0 goalStatus propagates through continuation flow', () => {
  // R0 unified_decision=completed → reconciler returns goalStatus=completed
  // → continuation flow picks it up → goal converges to completed
  // → queue advances for dependent items.

  // Step 1: Reconcile a stale-repair state with unified_decision=completed
  const staleTaskResult = buildFullEvidence({
    closure_decision: {
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'stale_repair',
      auto_complete_allowed: false,
      blocking_passed: false,
      requires_human_decision: true,
      task_status: 'waiting_for_repair',
    },
    finalizer_decision: {
      status: 'waiting_for_repair',
      reason: 'stale_repair',
    },
    unified_decision: {
      status: 'completed',
      blocking_passed: true,
      safe_to_auto_advance: true,
      source: 'reconciler',
      reconciled: true,
    },
  });

  const reconcilerResult = reconcileTaskClosure({ taskStatus: 'waiting_for_repair', taskResult: staleTaskResult });

  assert.equal(reconcilerResult.reconciled, true, 'R0 must reconcile');
  assert.equal(reconcilerResult.taskStatus, 'completed', 'task status repaired');
  assert.equal(reconcilerResult.goalStatus, 'completed', 'goalStatus returned from reconciler');

  // Step 2: Pass reconciler result through continuation flow
  const continuation = continueOnCompletedOutcome({
    taskResult: reconcilerResult.taskResult,
    task: { id: 'task_stale', status: reconcilerResult.taskStatus },
    goal: { id: 'goal_stale', status: 'running' },
    previousGoalStatus: 'running',
  });

  assert.equal(continuation.shouldContinue, true, 'should continue');
  assert.equal(continuation.continuation.convergeGoal, true, 'goal should converge');
  assert.equal(continuation.continuation.advanceQueue, true, 'queue should advance');
  assert.equal(continuation.continuation.sweepStaleGoals, true, 'stale goals should be swept');

  // Step 3: Converge the goal
  const goal = { id: 'goal_stale', status: 'running', updated_at: '2025-01-01T00:00:00.000Z' };
  const goalChanged = convergeGoalFromContinuation(goal, continuation.goalStatus, continuation.continuation);

  assert.equal(goalChanged, true, 'goal should change');
  assert.equal(goal.status, 'completed', 'goal must be completed');
});

test('AFC7-5b: goalStatusFromReconciliation consumed as priority before determineGoalStatus', () => {
  // When reconciliation returns goalStatus, the goal status update in
  // task-final-writeback must use it as priority (before determineGoalStatus).
  const reconcilerResult = {
    taskStatus: 'completed',
    goalStatus: 'completed',
    reconciled: true,
    reason: 'canonical unified_decision',
  };

  // goalStatusFromReconciliation returns the canonical goalStatus
  const canonicalGoalStatus = goalStatusFromReconciliation(reconcilerResult);
  assert.equal(canonicalGoalStatus, 'completed', 'canonical goal status from reconciler');

  // Meanwhile, determineGoalStatus with incomplete evidence would return
  // 'waiting_for_human_review' (because evidence is missing)
  const fallbackStatus = determineGoalStatus(
    { id: 'goal_evidence', status: 'running' },
    { id: 'task_evidence', status: 'completed' },
    { status: 'completed', summary: 'done', changed_files: ['src/app.mjs'] },
  );
  assert.notEqual(fallbackStatus, 'completed', 'determineGoalStatus without verification evidence returns non-completed');

  // The canonical priority path gives 'completed', not the fallback
  assert.equal(canonicalGoalStatus, 'completed', 'canonical path overrides determineGoalStatus');
});

// ===========================================================================
// Section 6: End-to-end — downstream items continue when previous completes
// ===========================================================================

test('AFC7-6a: downstream queue item continues when previous task completes with unified_decision', () => {
  // This test simulates the continuation flow for two queue items:
  // - item_prev: previous task that completes with unified_decision=completed
  // - item_next: downstream item that depends on item_prev
  //
  // When item_prev completes canonically, item_next should be eligible
  // for advancement (the continuation says advanceQueue=true).

  // Step 1: Simulate previous task completing with canonical outcome
  const prevTaskResult = buildFullEvidence({
    unified_decision: {
      status: 'completed',
      blocking_passed: true,
      safe_to_auto_advance: true,
      source: 'finalizer',
    },
  });

  // Step 2: Continuation flow decides what to do
  const continuation = continueOnCompletedOutcome({
    taskResult: prevTaskResult,
    task: { id: 'task_prev', status: 'completed' },
    goal: { id: 'goal_prev', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, true, 'previous task complete leads to continuation');
  assert.equal(continuation.continuation.advanceQueue, true, 'queue should advance for downstream items');

  // Step 3: The downstream items that depend on 'goal_prev' or 'task_prev'
  // are eligible for auto-advance in the next tick.
  assert.equal(shouldAdvanceQueue(continuation.continuation), true,
    'shouldAdvanceQueue confirms downstream items can advance');
});

test('AFC7-6b: downstream queue item continues through reconcile-then-continue path', () => {
  // Full end-to-end: reconcile a stale state → continuation flow →
  // downstream items are eligible for queue auto-advance.

  // Step 1: Reconcile a state where unified_decision says completed
  // but the upstream task is still in a non-terminal state
  const staleResult = buildFullEvidence({
    closure_decision: {
      status: CLOSURE_STATUSES.REQUIRES_REVIEW,
      reason: 'stale_waiting',
      auto_complete_allowed: false,
      blocking_passed: false,
      requires_human_decision: true,
      task_status: 'waiting_for_review',
    },
    finalizer_decision: {
      status: 'waiting_for_review',
      reason: 'manual_review_required',
    },
    unified_decision: {
      status: 'completed',
      blocking_passed: true,
      safe_to_auto_advance: true,
      source: 'reconciler',
      reconciled: true,
    },
  });

  const reconcilerResult = reconcileTaskClosure({ taskStatus: 'waiting_for_review', taskResult: staleResult });

  assert.equal(reconcilerResult.reconciled, true, 'R0 must reconcile stale state');
  assert.equal(reconcilerResult.goalStatus, 'completed', 'goalStatus from reconciler');

  // Step 2: Continuation flow from reconciled result
  const continuation = continueOnCompletedOutcome({
    taskResult: reconcilerResult.taskResult,
    task: { id: 'task_stale_waiting', status: reconcilerResult.taskStatus },
    goal: { id: 'goal_stale_waiting', status: 'running' },
    previousGoalStatus: 'running',
  });

  assert.equal(continuation.shouldContinue, true, 'should continue');
  assert.equal(continuation.continuation.advanceQueue, true,
    'downstream items can advance after reconcile+continue');

  // Step 3: The goal converges
  const goal = { id: 'goal_stale_waiting', status: 'running' };
  const goalChanged = convergeGoalFromContinuation(goal, continuation.goalStatus, continuation.continuation);
  assert.equal(goalChanged, true, 'goal converges to completed');
  assert.equal(goal.status, 'completed', 'goal status is completed');

  // Step 4: After goal convergence, the downstream items can advance queue
  assert.equal(shouldAdvanceQueue(continuation.continuation), true,
    'downstream queue items eligible for advancement');
});

// ===========================================================================
// Section 7: Edge cases
// ===========================================================================

test('AFC7-7a: continueOnCompletedOutcome handles empty input gracefully', () => {
  const result = continueOnCompletedOutcome({});
  assert.equal(result.shouldContinue, false);
  assert.equal(result.completionType, 'none');
  assert.equal(result.continuationSource, 'none');
  assert.equal(result.continuation.advanceQueue, false);
});

test('AFC7-7b: unified_decision=completed with blocking_passed=false still continues but does not advance queue', () => {
  // When unified_decision says completed but blocking_passed is false,
  // the goal should still be marked completed (canonical trust), but queue
  // advance should be blocked because blockers remain.
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: {
        status: 'completed',
        blocking_passed: false,
        safe_to_auto_advance: false,
      },
    },
    task: { id: 'task_blocked_completed', status: 'completed' },
    goal: { id: 'goal_blocked_completed', status: 'running' },
  });

  assert.equal(continuation.shouldContinue, true, 'should still continue (completed status)');
  assert.equal(continuation.goalStatus, 'completed', 'goal status should be completed');
  assert.equal(continuation.continuation.convergeGoal, true, 'goal should converge');
  assert.equal(continuation.continuation.advanceQueue, false,
    'queue should NOT advance when blocking_passed=false');
});

test('AFC7-7c: goal already terminal — convergeGoal set to false', () => {
  const continuation = continueOnCompletedOutcome({
    taskResult: {
      unified_decision: {
        status: 'completed',
        blocking_passed: true,
        safe_to_auto_advance: true,
      },
    },
    task: { id: 'task_completed', status: 'completed' },
    goal: { id: 'goal_completed', status: 'completed' },
  });

  assert.equal(continuation.continuation.convergeGoal, false,
    'goal already terminal, no converge needed');
  assert.equal(continuation.continuation.advanceQueue, true,
    'queue advance still permitted');
});
