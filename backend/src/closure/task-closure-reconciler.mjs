/**
 * task-closure-reconciler.mjs — P0-MA12-G2: Auto Closure Reconciliation
 *                          — P0-AFC6: Canonical unified_decision as source of truth
 *
 * Deterministic reconciliation step that runs after all writeback stages:
 * finalizer writeback, pipeline gate evaluation, integration result writeback,
 * and runtime convergence.
 *
 * Ensures closure_decision, finalizer_decision, and task.status are consistent
 * with the canonical outcome decision (unified_decision) or, when no canonical
 * decision exists, with the actual evidence present in the task result.
 *
 * Reconciliation rules:
 *   R0: Canonical unified_decision says completed → trust it unconditionally
 *       and repair any stale task status or sub-decision state. P0-AFC6.
 *   R1: All evidence present + closure says auto-complete → normalize
 *       finalizer_decision to completed if it's stale.
 *   R2: All evidence present + finalizer says completed → normalize
 *       closure_decision to auto-completed if it's stale.
 *   R3: Both decisions agree on completed but task.status is stale → fix
 *       task.status.
 *   R4/R5: Evidence doesn't support completion → no change.
 *   R6/R7: task.status already completed, one decision stale → normalize the
 *       stale decision.
 */

import { CLOSURE_STATUSES } from './auto-progress-policy.mjs';

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function integrationIsSatisfied(integration = {}, needsIntegration, taskResult = {}) {
  if (!integration || typeof integration !== 'object') return !needsIntegration;
  // P0-AFC: Prefer current canonical commit reachability over stale integration
  // evidence. If the task's commit is reachable from canonical HEAD, the commit
  // is effectively integrated regardless of what the integration field says.
  const reachability = (taskResult || {}).commit_reachability || {};
  if (reachability.reachable === true && reachability.canonical_clean !== false) {
    return true;
  }
  if (integration.satisfied === true || integration.merged === true || integration.auto_completed === true) return true;
  const status = String(integration.status || '').toLowerCase();
  return ['merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated'].includes(status);
}

function noUnresolvedBlockingFindings(findings = []) {
  if (!Array.isArray(findings)) return true;
  return !findings.some((f) => f && f.severity === 'blocker' && f.resolved !== true);
}

function verificationPassed(verification = {}) {
  if (!verification || typeof verification !== 'object') return false;
  return verification.passed === true;
}

function worktreeClean(taskResult = {}) {
  // P0-AFC: Prefer current canonical reachability evidence over historical
  // dirty snapshots. If the commit is reachable from canonical HEAD with
  // a clean repo, the task is effectively clean regardless of historical
  // canonial_dirty/worktree_dirty fields.
  const reachability = taskResult.commit_reachability || {};
  const recovery = taskResult.delivery_result_recovery || {};

  // If delivery recovery succeeded or commit is already integrated,
  // the historical dirtiness is no longer relevant
  if (recovery.recovered === true || recovery.reason === 'already_integrated') {
    if (reachability.reachable !== false) return true;
  }
  if (reachability.reachable === true && reachability.canonical_clean !== false) {
    return true;
  }

  // Fall back to historical fields (stale but used when no current evidence)
  const dirty = taskResult.canonical_dirty === true
    || taskResult.worktree_dirty === true
    || taskResult.verification?.dirty === true
    || taskResult.delivery_result_recovery?.canonical_dirty === true
    || taskResult.delivery_result_recovery?.canonical_clean_after === false;
  return !dirty;
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

export function reconcileTaskClosure({ taskStatus, taskResult = {}, config = {} } = {}) {
  if (!taskResult || typeof taskResult !== 'object') {
    return { taskStatus, taskResult, reconciled: false, reason: null };
  }

  const closureDecision = taskResult.closure_decision || {};
  const finalizerDecision = taskResult.finalizer_decision || {};
  const integration = taskResult.integration || {};
  const verification = taskResult.verification || taskResult.final_verification || {};
  const findings = taskResult.acceptance_findings || [];
  const acceptanceGate = taskResult.acceptance_gate || {};

  // -----------------------------------------------------------------------
  // R0 (P0-AFC6): Canonical unified_decision is the source of truth.
  // When unified_decision.status === 'completed', force-repair any stale
  // task status, closure_decision, or finalizer_decision WITHOUT re-checking
  // individual evidence fields. This guarantees that the canonical outcome
  // decision (set by P0-AFC5 finalizer or a prior reconciliation pass) cannot
  // be overridden by stale downstream state.
  //
  // Also returns goalStatus: 'completed' so callers can repair goal state
  // immediately rather than re-deriving from individual evidence fields.
  // -----------------------------------------------------------------------

  const unifiedDecision = taskResult.unified_decision || {};

  if (unifiedDecision.status === 'completed') {
    const closureSaysComplete =
      closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN ||
      closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
    const finalizerSaysComplete = finalizerDecision.status === 'completed';
    const taskNeedsFix = taskStatus !== 'completed';
    const closureNeedsFix = !closureSaysComplete;
    const finalizerNeedsFix = !finalizerSaysComplete;

    if (taskNeedsFix || closureNeedsFix || finalizerNeedsFix) {
      let updatedTaskResultLocal = { ...taskResult };
      let updatedTaskStatusLocal = taskStatus;

      // Repair stale closure_decision
      if (closureNeedsFix) {
        const hasFollowups =
          (Array.isArray(updatedTaskResultLocal.followups) && updatedTaskResultLocal.followups.length > 0) ||
          (Array.isArray(updatedTaskResultLocal.followup_findings) && updatedTaskResultLocal.followup_findings.length > 0) ||
          (Array.isArray(updatedTaskResultLocal.quality_notes) && updatedTaskResultLocal.quality_notes.length > 0);
        const newClosureStatus = hasFollowups
          ? CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS
          : CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN;

        updatedTaskResultLocal.closure_decision = {
          ...closureDecision,
          status: newClosureStatus,
          reason: 'reconciled_by_unified_decision',
          reconciled_from: closureDecision.status || 'unknown',
          auto_complete_allowed: true,
          blocking_passed: true,
          requires_human_decision: false,
          task_status: 'completed',
          blockers: [],
          repairable_blockers: [],
        };
      }

      // Repair stale finalizer_decision
      if (finalizerNeedsFix) {
        updatedTaskResultLocal.finalizer_decision = {
          ...finalizerDecision,
          status: 'completed',
          reason: 'reconciled_by_unified_decision',
          reconciled_from: finalizerDecision.status || 'unknown',
          safe_to_auto_advance: true,
          blockers: [],
          repairable_blockers: [],
          goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
          queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
        };
      }

      updatedTaskStatusLocal = 'completed';

      return {
        taskStatus: updatedTaskStatusLocal,
        taskResult: updatedTaskResultLocal,
        goalStatus: 'completed',
        reconciled: true,
        reason: 'canonical unified_decision overrides stale task status or sub-decision state',
      };
    }
  }

  // -----------------------------------------------------------------------
  // (if R0 did not fire, continue with evidence-based reconciliation rules)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Evidence assessment
  // -----------------------------------------------------------------------

  const gateSatisfied =
    acceptanceGate.passed === true ||
    acceptanceGate.status === 'passed' ||
    closureDecision.auto_complete_allowed === true ||
    closureDecision.blocking_passed === true;

  const verificationOk = verificationPassed(verification);
  const integrationOk = integrationIsSatisfied(integration, taskResult.needs_integration, taskResult);
  const findingOk = noUnresolvedBlockingFindings(findings);
  const worktreeOk = worktreeClean(taskResult);

  const allEvidencePresent = gateSatisfied && verificationOk && integrationOk && findingOk && worktreeOk;

  // -----------------------------------------------------------------------
  // Current decision states
  // -----------------------------------------------------------------------

  const closureSaysComplete =
    closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN ||
    closureDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;

  const finalizerSaysComplete = finalizerDecision.status === 'completed';
  const taskSaysComplete = taskStatus === 'completed';

  // -----------------------------------------------------------------------
  // Reconciliation rules
  // -----------------------------------------------------------------------

  let reconciled = false;
  let reason = null;
  let updatedTaskStatus = taskStatus;
  let updatedTaskResult = { ...taskResult };

  /**
   * Build a unified_decision snapshot that matches the reconciled completion.
   * P0-AFC4: The canonical outcome must be propagated so that downstream
   * consumers (goal-convergence, task-final-writeback) do not re-derive
   * status from individual evidence fields.
   */
  function buildReconciledUnifiedDecision() {
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


  // R1: All evidence present + closure says auto-complete → normalize stale finalizer_decision
  if (allEvidencePresent && closureSaysComplete && !finalizerSaysComplete) {
    updatedTaskResult = {
      ...updatedTaskResult,
      finalizer_decision: {
        ...finalizerDecision,
        status: 'completed',
        reason: 'reconciled_by_closure_evidence',
        reconciled_from: finalizerDecision.status || 'unknown',
        safe_to_auto_advance: true,
        blockers: [],
        repairable_blockers: [],
        goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
        queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
      },
      unified_decision: buildReconciledUnifiedDecision(),
    };
    updatedTaskStatus = 'completed';
    reconciled = true;
    reason = 'finalizer_decision normalized to completed (all evidence present, closure already agrees)';
  }

  // R2: All evidence present + finalizer says completed -> normalize stale closure_decision
  if (allEvidencePresent && !closureSaysComplete && finalizerSaysComplete) {
    const hasFollowups =
      (Array.isArray(updatedTaskResult.followups) && updatedTaskResult.followups.length > 0) ||
      (Array.isArray(updatedTaskResult.followup_findings) && updatedTaskResult.followup_findings.length > 0) ||
      (Array.isArray(updatedTaskResult.quality_notes) && updatedTaskResult.quality_notes.length > 0);
    const newStatus = hasFollowups
      ? CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS
      : CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN;

    updatedTaskResult = {
      ...updatedTaskResult,
      closure_decision: {
        ...closureDecision,
        status: newStatus,
        reason: 'reconciled_by_finalizer_evidence',
        reconciled_from: closureDecision.status || 'unknown',
        auto_complete_allowed: true,
        blocking_passed: true,
        requires_human_decision: false,
        task_status: 'completed',
        blockers: [],
        repairable_blockers: [],
      },
    };
    updatedTaskStatus = 'completed';
    reconciled = true;
    reason = 'closure_decision normalized to ' + newStatus + ' (all evidence present, finalizer already agrees)';
  }

  // R3: Both decisions agree on completed but task.status is stale
  if (!reconciled && closureSaysComplete && finalizerSaysComplete && !taskSaysComplete) {
    updatedTaskStatus = 'completed';
    reconciled = true;
    reason = 'task.status normalized to completed (both decisions agree on completion)';
  }

  // R4: task.status completed + closure agrees, but finalizer is stale
  if (!reconciled && taskSaysComplete && closureSaysComplete && !finalizerSaysComplete) {
    updatedTaskResult = {
      ...updatedTaskResult,
      finalizer_decision: {
        ...finalizerDecision,
        status: 'completed',
        reason: 'reconciled_by_task_status',
        reconciled_from: finalizerDecision.status || 'unknown',
        safe_to_auto_advance: true,
        blockers: [],
        repairable_blockers: [],
        goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
        queue_effect: { status: 'completed', unblock_dependents: true, hold_queue: false },
      },
      unified_decision: buildReconciledUnifiedDecision(),
    };
    reconciled = true;
    reason = 'finalizer_decision normalized to completed (task.status already completed, closure agrees)';
  }

  // R5: task.status completed + finalizer agrees, but closure is stale
  if (!reconciled && taskSaysComplete && finalizerSaysComplete && !closureSaysComplete) {
    const hasFollowups =
      (Array.isArray(updatedTaskResult.followups) && updatedTaskResult.followups.length > 0) ||
      (Array.isArray(updatedTaskResult.followup_findings) && updatedTaskResult.followup_findings.length > 0) ||
      (Array.isArray(updatedTaskResult.quality_notes) && updatedTaskResult.quality_notes.length > 0);
    const newStatus = hasFollowups
      ? CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS
      : CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN;

    updatedTaskResult = {
      ...updatedTaskResult,
      closure_decision: {
        ...closureDecision,
        status: newStatus,
        reason: 'reconciled_by_task_status',
        reconciled_from: closureDecision.status || 'unknown',
        auto_complete_allowed: true,
        blocking_passed: true,
        requires_human_decision: false,
        task_status: 'completed',
        blockers: [],
        repairable_blockers: [],
      },
    };
    reconciled = true;
    reason = 'closure_decision normalized to ' + newStatus + ' (task.status already completed, finalizer agrees)';
  }


  // P0-AFC4: Ensure unified_decision is propagated for R2/R3/R5
  // (where the reconciler normalizes taskStatus or closure_decision
  // but does not explicitly set unified_decision).
  if (!updatedTaskResult.unified_decision && updatedTaskStatus === "completed") {
    updatedTaskResult = {
      ...updatedTaskResult,
      unified_decision: buildReconciledUnifiedDecision(),
    };
  }

  if (!reconciled) {
    return { taskStatus, taskResult, reconciled: false, reason: null };
  }

  return {
    taskStatus: updatedTaskStatus,
    taskResult: updatedTaskResult,
    reconciled,
    reason,
  };
}
