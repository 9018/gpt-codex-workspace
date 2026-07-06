/**
 * continuation-flow.mjs — P0-AFC7: Continuation Flow
 *
 * Explicitly bridges completed canonical outcomes (unified_decision) to
 * continuation behavior: goal status convergence, queue auto-advance,
 * and dependent task start.
 *
 * Consumers:
 *   - task-final-writeback.mjs — after reconciliation, use goalStatus
 *     from the reconciler instead of re-deriving from evidence.
 *
 * Guarantees:
 *   - When unified_decision.status === 'completed', the goal converges to
 *     'completed' regardless of individual evidence fields.
 *   - When the goal completes, downstream queue items that depend on this
 *     goal or task are eligible for auto-advance.
 *   - Stale goal states (e.g., 'running' when task is completed) are swept.
 */

import { UNIFIED_STATUSES } from '../codex-unified-decision.mjs';

// ===========================================================================
// Constants
// ===========================================================================

const TERMINAL_GOAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);

// ===========================================================================
// Continuation decision
// ===========================================================================

/**
 * Determine the continuation decision from a canonical outcome.
 *
 * When unified_decision.status === 'completed', this function returns a
 * continuation intent that tells callers to:
 *   1. Converge the goal to 'completed' unconditionally.
 *   2. Allow queue items depending on this task/goal to advance.
 *   3. Sweep stale goal states in the system.
 *
 * @param {object} opts
 * @param {object} opts.taskResult    — Reconciled task result (may carry unified_decision)
 * @param {object} opts.task          — The completed task
 * @param {object} [opts.goal]        — The goal associated with the task (if any)
 * @param {string} [opts.previousGoalStatus] — Goal status before this task completed
 * @returns {object} { shouldContinue, goalStatus, completionType, continuation }
 */
export function continueOnCompletedOutcome({ taskResult = {}, task = {}, goal = null, previousGoalStatus = null } = {}) {
  const unifiedDecision = taskResult.unified_decision || {};

  // -----------------------------------------------------------------------
  // P0-AFC7: When the canonical unified_decision says completed, the
  // continuation behaviour MUST trigger unconditionally — no evidence
  // re-checking, no stale goal state overriding the outcome.
  // -----------------------------------------------------------------------
  if (unifiedDecision.status === UNIFIED_STATUSES.COMPLETED) {
    const goalWasTerminal = goal && TERMINAL_GOAL_STATUSES.has(goal.status);
    const goalNeedsFix = goal && !goalWasTerminal;
    const previousGoalWasStale = previousGoalStatus && !TERMINAL_GOAL_STATUSES.has(previousGoalStatus);

    return {
      shouldContinue: true,
      goalStatus: 'completed',
      completionType: 'canonical',
      continuation: {
        convergeGoal: goalNeedsFix || previousGoalWasStale || false,
        advanceQueue: unifiedDecision.safe_to_auto_advance !== false && unifiedDecision.blocking_passed !== false,
        sweepStaleGoals: true,
        reason: 'canonical unified_decision completed — continue downstream',
      },
      continuationSource: 'unified_decision',
      reason: 'unified_decision.status=completed, continuation flow active',
    };
  }

  // -----------------------------------------------------------------------
  // Non-terminal unified_decision — continuation depends on actual status.
  // -----------------------------------------------------------------------
  if (unifiedDecision.status === UNIFIED_STATUSES.FAILED || unifiedDecision.status === UNIFIED_STATUSES.BLOCKED || unifiedDecision.status === UNIFIED_STATUSES.TIMED_OUT) {
    return {
      shouldContinue: false,
      goalStatus: unifiedDecision.status,
      completionType: 'failed',
      continuation: {
        convergeGoal: false,
        advanceQueue: false,
        sweepStaleGoals: false,
        reason: `unified_decision status=${unifiedDecision.status} — do not continue downstream`,
      },
      continuationSource: 'unified_decision',
      reason: `unified_decision.status=${unifiedDecision.status}, continuation blocked`,
    };
  }

  // -----------------------------------------------------------------------
  // No unified_decision — fall back to task status only for basic
  // continuation. This preserves backward compatibility for tasks that
  // complete without the normalisation pipeline.
  // -----------------------------------------------------------------------
  if (task.status === 'completed') {
    return {
      shouldContinue: true,
      goalStatus: null, // caller should use determineGoalStatus or other logic
      completionType: 'task_status',
      continuation: {
        convergeGoal: false,
        advanceQueue: true,
        sweepStaleGoals: false,
        reason: 'task.status=completed (no unified_decision, basic continuation)',
      },
      continuationSource: 'task_status',
      reason: 'task status completed, basic continuation',
    };
  }

  // -----------------------------------------------------------------------
  // No continuation possible
  // -----------------------------------------------------------------------
  return {
    shouldContinue: false,
    goalStatus: null,
    completionType: 'none',
    continuation: {
      convergeGoal: false,
      advanceQueue: false,
      sweepStaleGoals: false,
      reason: 'task status not completed, no canonical outcome',
    },
    continuationSource: 'none',
    reason: 'no continuation',
  };
}

// ===========================================================================
// Goal convergence helper
// ===========================================================================

/**
 * Converge a goal's status based on the continuation decision.
 *
 * When the canonical outcome says completed, the goal is unconditionally
 * marked as completed regardless of its previous state.
 *
 * @param {object} goal           — Goal object (mutated in place)
 * @param {string} goalStatus     — Target goal status from continueOnCompletedOutcome
 * @param {object} continuation   — Continuation decision from continueOnCompletedOutcome
 * @returns {boolean} changed     — Whether the goal status changed
 */
export function convergeGoalFromContinuation(goal, goalStatus, continuation = {}) {
  if (!goal || !goalStatus) return false;
  if (!continuation || typeof continuation !== 'object') return false;
  if (continuation.convergeGoal !== true) return false;

  const previousStatus = goal.status;
  if (previousStatus === goalStatus) return false;

  goal.status = goalStatus;
  goal.updated_at = new Date().toISOString();
  return true;
}

// ===========================================================================
// Queue advancement helper
// ===========================================================================

/**
 * Determine if queue items depending on the completed task/goal should advance.
 *
 * When continuation says advanceQueue, all dependent items in 'waiting',
 * 'ready', or 'blocked' status whose depends_on matches the completed goal
 * or task SHOULD be eligible for auto-advance in the next tick.
 *
 * This is a PREDICATE function — the actual auto-advance logic lives in
 * goal-queue.mjs's `autoStartNextOnTaskCompleted` and `queueAutoAdvanceTick`.
 *
 * @param {object} continuation   — Continuation decision from continueOnCompletedOutcome
 * @returns {boolean} shouldAdvance
 */
export function shouldAdvanceQueue(continuation = {}) {
  if (!continuation || typeof continuation !== 'object') return false;
  return continuation.advanceQueue === true;
}

// ===========================================================================
// Determines if continuation sweep is needed
// ===========================================================================

/**
 * Returns true when stale goal statuses should be swept after this
 * continuation pass.
 *
 * @param {object} continuation   — Continuation decision
 * @returns {boolean}
 */
export function shouldSweepStaleGoals(continuation = {}) {
  if (!continuation || typeof continuation !== 'object') return false;
  return continuation.sweepStaleGoals === true;
}

// ===========================================================================
// End-to-end continuation: connects canonical outcome to full continuation
// ===========================================================================

/**
 * Evaluates whether the reconciliation result's goalStatus should be
 * consumed as the canonical continuation signal.
 *
 * Called from task-final-writeback.mjs after reconcileTaskClosure to
 * determine the correct goal status.
 *
 * Priority order:
 *   1. reconciliationResult.goalStatus  (from reconciler R0)
 *   2. determineGoalStatus fallback      (from goal-convergence)
 *   3. task status fallback              (raw task status)
 *
 * @param {object} opts
 * @param {object} [opts.reconciliationResult] — Result from reconcileTaskClosure
 * @returns {string|null} goalStatus
 */
export function goalStatusFromReconciliation(reconciliationResult = {}) {
  // When the reconciler explicitly returned a goalStatus, use it directly.
  // This happens when R0 fires (unified_decision says completed).
  if (reconciliationResult.goalStatus) {
    return reconciliationResult.goalStatus;
  }
  return null;
}
