/**
 * codex-unified-decision.mjs — UnifiedAcceptanceDecision type and normalizer.
 *
 * P0: Single canonical data structure for all acceptance and final-state decisions.
 * Consumed by: finalizer, closure decider, goal-convergence, queue propagation,
 *              review packet builder.
 *
 * Guarantees:
 *   - Any downstream module can consume a UnifiedAcceptanceDecision without
 *     re-deriving status/findings/effects.
 *   - The normalizer produces the same result for the same evidence regardless
 *     of which module calls it.
 *   - Backward compatible: all existing decision shapes continue to work; the
 *     unified decision is ADDITIONAL data in taskResult.unified_decision.
 *
 * Field description:
 *   status             — Final task status (completed, failed, waiting_for_*, etc.)
 *   reason             — Human-readable reason for the decision
 *   closure_reason     — Structured closure reason code (maps to CLOSURE_REASONS)
 *   profile            — Acceptance profile (code_change, sync_only, etc.)
 *   blocking_passed    — True when no blocking/major findings remain
 *   requires_review    — True when human review is needed
 *   requires_repair    — True when automatic repair is needed
 *   requires_integration — True when integration has not reached terminal state
 *   requires_restart   — True when runtime restart is needed
 *   safe_to_auto_advance — True when queue/goal can auto-advance
 *   blockers           — Array of {severity, code, message} blocking findings
 *   repairable_blockers — Array of findings that can be auto-repaired
 *   non_blocking_followups — Array of followup items (not blocking)
 *   quality_notes      — Array of quality notes (not blocking)
 *   findings           — All findings combined (blocking + non-blocking)
 *   integration_effect — { required, status, satisfied, terminal }
 *   goal_effect        — { status, complete_goal, safe_to_auto_advance }
 *   queue_effect       — { status, unblock_dependents, hold_queue }
 *   source             — Which module produced the decision
 *   normalized_at      — ISO timestamp
 *
 * Usage boundary:
 *   - Stored in taskResult.unified_decision after finalization.
 *   - Does NOT replace individual decision objects for backward compat.
 *   - When present, downstream MUST prefer unified_decision over re-deriving.
 */

// ===========================================================================
// Status constants (canonical set shared across all consumers)
// ===========================================================================

export const UNIFIED_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  WAITING_FOR_REVIEW: 'waiting_for_review',
  WAITING_FOR_HUMAN_REVIEW: 'waiting_for_human_review',
  WAITING_FOR_REPAIR: 'waiting_for_repair',
  WAITING_FOR_INTEGRATION: 'waiting_for_integration',
  WAITING_FOR_CAPACITY: 'waiting_for_capacity',
  RETRY_WAIT: 'retry_wait',
  QUOTA_WAIT: 'quota_wait',
  RESTART_PENDING: 'restart_pending',
  TIMED_OUT: 'timed_out',
  WAITING_FOR_MISSING_EVIDENCE_REPAIR: 'waiting_for_missing_evidence_repair',
  WAITING_FOR_INTEGRATION_RECOVERY: 'waiting_for_integration_recovery',
  WAITING_FOR_RESULT_CONTRACT_REPAIR: 'waiting_for_result_contract_repair',
  WAITING_FOR_NOOP_EVIDENCE: 'waiting_for_noop_evidence',
  WAITING_FOR_MANUAL_TERMINAL_DECISION: 'waiting_for_manual_terminal_decision',
  HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED: 'human_interrupted_for_repair_budget_exhausted',
});

const UNIFIED_STATUS_SET = new Set(Object.values(UNIFIED_STATUSES));

// ===========================================================================
// Helpers
// ===========================================================================

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function firstOf(...sources) {
  for (const rawSource of sources) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource : {};
    if (source !== null && source !== undefined && source !== '') return source;
  }
  return null;
}

// ===========================================================================
// Effect builders
// ===========================================================================

function buildIntegrationEffect({ status, decision, taskResult } = {}) {
  const d = asObject(decision);
  const tr = asObject(taskResult);
  const integration = asObject(tr.integration || d.integration || {});

  const isCompleted = status === UNIFIED_STATUSES.COMPLETED;
  const integrationRequired = d.integration_required === true
    || d.requires_integration === true
    || d.integration_effect?.required === true
    || tr.needs_integration === true
    || integration.required === true
    || (isCompleted && list(tr.changed_files).length > 0 && integration.satisfied !== true);

  const integrationStatus = integration.status || d.integration_effect?.status || null;
  const integrationSatisfied = integration.satisfied === true
    || integration.merged === true
    || integration.auto_completed === true
    || ['merged', 'ff_only_merged', 'skipped', 'not_required'].includes(String(integrationStatus || '').toLowerCase())
    || d.integration_effect?.satisfied === true
    || tr.auto_integration_completion?.completed === true
    || (!integrationRequired);

  return {
    required: integrationRequired,
    status: integrationStatus || (integrationSatisfied ? 'satisfied' : null),
    satisfied: integrationSatisfied,
    terminal: integrationSatisfied,
  };
}

function buildGoalEffect({ status, decision } = {}) {
  const d = asObject(decision);
  const existing = asObject(d.goal_effect);
  const isCompleted = status === UNIFIED_STATUSES.COMPLETED;
  const completeGoal = existing.complete_goal === true || (isCompleted && d.safe_to_auto_advance !== false);
  return {
    status,
    complete_goal: completeGoal,
    safe_to_auto_advance: completeGoal,
  };
}

function buildQueueEffect({ status, decision } = {}) {
  const d = asObject(decision);
  const isCompleted = status === UNIFIED_STATUSES.COMPLETED;
  const safeToAutoAdvance = d.safe_to_auto_advance === true || (isCompleted && d.blocking_passed !== false);
  return {
    status,
    unblock_dependents: safeToAutoAdvance,
    hold_queue: !safeToAutoAdvance,
  };
}

// ===========================================================================
// Terminal / non-terminal status helpers
// ===========================================================================

const TERMINAL_STATUSES = new Set([
  UNIFIED_STATUSES.COMPLETED,
  UNIFIED_STATUSES.FAILED,
  UNIFIED_STATUSES.BLOCKED,
  UNIFIED_STATUSES.TIMED_OUT,
]);

const NON_TERMINAL_HOLD_STATUSES = new Set([
  UNIFIED_STATUSES.WAITING_FOR_REVIEW,
  UNIFIED_STATUSES.WAITING_FOR_HUMAN_REVIEW,
  UNIFIED_STATUSES.WAITING_FOR_REPAIR,
  UNIFIED_STATUSES.WAITING_FOR_INTEGRATION,
  UNIFIED_STATUSES.WAITING_FOR_CAPACITY,
  UNIFIED_STATUSES.RETRY_WAIT,
  UNIFIED_STATUSES.QUOTA_WAIT,
  UNIFIED_STATUSES.RESTART_PENDING,
]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function isNonTerminalHoldStatus(status) {
  return NON_TERMINAL_HOLD_STATUSES.has(status);
}

export function isValidUnifiedStatus(status) {
  return UNIFIED_STATUS_SET.has(status);
}

// ===========================================================================
// Collectors
// ===========================================================================

function collectBlockers(sources = []) {
  const seen = new Set();
  const result = [];
  for (const rawSource of sources) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource : {};
    for (const item of list(source.blockers || source.blocking_findings || source.findings)) {
      if (!item || typeof item !== 'object') continue;
      const key = `${item.code || ''}|${item.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.severity === 'blocker' || item.severity === 'major' || !item.severity) {
        result.push({ severity: item.severity || 'blocker', code: item.code || 'unknown', message: item.message || '', source: item.source || 'unified' });
      }
    }
  }
  return result;
}

function collectRepairableBlockers(sources = []) {
  const seen = new Set();
  const result = [];
  for (const rawSource of sources) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource : {};
    for (const item of list(source.repairable_blockers || source.repairableBlockers)) {
      if (!item || typeof item !== 'object') continue;
      const key = `${item.code || ''}|${item.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ severity: item.severity || 'major', code: item.code || 'repairable', message: item.message || '', source: item.source || 'unified' });
    }
  }
  return result;
}

function collectFollowups(sources = []) {
  const seen = new Set();
  const result = [];
  for (const rawSource of sources) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource : {};
    for (const item of list(source.non_blocking_followups || source.followup_findings || source.followups)) {
      if (!item || typeof item !== 'object') continue;
      const key = `${item.title || item.code || ''}|${item.message || item.reason || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function collectQualityNotes(sources = []) {
  const seen = new Set();
  const result = [];
  for (const rawSource of sources) {
    const source = rawSource && typeof rawSource === 'object' ? rawSource : {};
    for (const item of list(source.quality_notes || source.qualityNotes)) {
      if (!item || typeof item !== 'object' && typeof item !== 'string') continue;
      const key = typeof item === 'string' ? item : `${item.title || item.code || ''}|${item.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

// ===========================================================================
// Status derivation
// ===========================================================================

function deriveStatus(sources = {}) {
  const { finalizerDecision, closureDecision, convergenceDecision, gateDecision, verification, taskResult } = sources;
  const decision = finalizerDecision || closureDecision || gateDecision || convergenceDecision || verification || taskResult || {};
  if (decision.status && UNIFIED_STATUS_SET.has(decision.status)) return decision.status;
  if (decision.nextStatus && UNIFIED_STATUS_SET.has(decision.nextStatus)) return decision.nextStatus;
  if (verification && verification.status && UNIFIED_STATUS_SET.has(verification.status)) return verification.status;
  if (verification && verification.passed === true) return UNIFIED_STATUSES.COMPLETED;
  if (verification && verification.passed === false) return UNIFIED_STATUSES.WAITING_FOR_REVIEW;
  if (taskResult && taskResult.status && UNIFIED_STATUS_SET.has(taskResult.status)) return taskResult.status;
  return UNIFIED_STATUSES.WAITING_FOR_REVIEW;
}

function deriveRequiresReview({ status, decision, verification } = {}) {
  if (status === UNIFIED_STATUSES.COMPLETED || status === UNIFIED_STATUSES.FAILED || status === UNIFIED_STATUSES.BLOCKED) return false;
  // Auto-handled statuses do NOT require human review
  const autoHandled = new Set([
    UNIFIED_STATUSES.WAITING_FOR_REPAIR,
    UNIFIED_STATUSES.WAITING_FOR_INTEGRATION,
    UNIFIED_STATUSES.WAITING_FOR_CAPACITY,
    UNIFIED_STATUSES.RETRY_WAIT,
    UNIFIED_STATUSES.QUOTA_WAIT,
    UNIFIED_STATUSES.RESTART_PENDING,
  ]);
  if (autoHandled.has(status)) return false;
  const d = asObject(decision);
  if (d.requires_review === true) return true;
  if (d.blocking_passed === false) return true;
  if (verification && verification.requires_review === true) return true;
  if (status === UNIFIED_STATUSES.WAITING_FOR_REVIEW || status === UNIFIED_STATUSES.WAITING_FOR_HUMAN_REVIEW) return true;
  return false;
}

function deriveRequiresRepair({ status, decision, verification } = {}) {
  if (status === UNIFIED_STATUSES.COMPLETED || status === UNIFIED_STATUSES.FAILED) return false;
  const d = asObject(decision);
  if (d.requires_repair === true || d.needs_repair === true) return true;
  if (list(d.repairable_blockers).length > 0) return true;
  if (status === UNIFIED_STATUSES.WAITING_FOR_REPAIR) return true;
  if (verification && list(verification.repairable_blockers).length > 0) return true;
  return false;
}

function deriveRequiresIntegration({ status, decision, taskResult } = {}) {
  if (status === UNIFIED_STATUSES.COMPLETED) return false;
  const d = asObject(decision);
  const tr = asObject(taskResult);
  if (d.requires_integration === true || d.integration_required === true) return true;
  if (tr.needs_integration === true) return true;
  if (d.integration_effect && d.integration_effect.required === true && d.integration_effect.terminal !== true) return true;
  if (status === UNIFIED_STATUSES.WAITING_FOR_INTEGRATION) return true;
  return false;
}

function deriveSafeToAutoAdvance({ status, decision, verification } = {}) {
  if (status === UNIFIED_STATUSES.COMPLETED) {
    const d = asObject(decision);
    return d.safe_to_auto_advance !== false && d.blocking_passed !== false;
  }
  return false;
}

// ===========================================================================
// Main normalizer
// ===========================================================================

export function normalizeToUnifiedDecision({
  finalizerDecision,
  closureDecision,
  convergenceDecision,
  gateDecision,
  verification,
  contractVerification,
  taskResult,
  task,
  now,
} = {}) {
  const timestamp = now || new Date().toISOString();
  const fd = asObject(finalizerDecision);
  const cd = asObject(closureDecision);
  const gd = asObject(gateDecision);
  const vd = asObject(verification);
  const tr = asObject(taskResult);

  const status = deriveStatus({ finalizerDecision: fd, closureDecision: cd, convergenceDecision, gateDecision: gd, verification: vd, taskResult: tr });

  const reason = firstOf(
    fd.reason, cd.reason, gd.reason,
    convergenceDecision && convergenceDecision.reason,
    vd.reason, tr.reason, tr.summary, status
  );

  const closureReason = firstOf(
    fd.closure_reason,
    convergenceDecision && convergenceDecision.closureReason,
    cd.reason, gd.reason, null
  );

  const profile = firstOf(
    convergenceDecision && convergenceDecision.profile,
    tr.acceptance_profile,
    tr.convergence && tr.convergence.profile,
    tr.profile, null
  );

  const blockers = collectBlockers([fd, cd, gd, vd, contractVerification, tr]);
  const repairableBlockers = collectRepairableBlockers([fd, cd, gd, contractVerification, tr]);
  const followups = collectFollowups([fd, cd, gd, contractVerification, tr]);
  const qualityNotes = collectQualityNotes([fd, cd, gd, contractVerification, tr]);

  const blockingPassed = blockers.length === 0 && repairableBlockers.length === 0;
  const requiresReview = deriveRequiresReview({ status, decision: fd, verification: vd });
  const requiresRepair = deriveRequiresRepair({ status, decision: fd, verification: vd });
  const requiresIntegration = deriveRequiresIntegration({ status, decision: fd, taskResult: tr });
  const safeToAutoAdvance = deriveSafeToAutoAdvance({ status, decision: fd, verification: vd });

  const integrationEffect = buildIntegrationEffect({ status, decision: fd, taskResult: tr });
  const goalEffect = buildGoalEffect({ status, decision: fd });
  const queueEffect = buildQueueEffect({ status, decision: fd });

  const source = fd.status ? 'finalizer' : cd.status ? 'closure' : gd.status ? 'gate' : 'normalizer';

  const requiresRestart = status === UNIFIED_STATUSES.RESTART_PENDING
    || (convergenceDecision && convergenceDecision.nextStatus === UNIFIED_STATUSES.RESTART_PENDING)
    || tr.restart_required === true;

  return {
    status,
    reason,
    closure_reason: closureReason,
    profile,
    blocking_passed: blockingPassed,
    requires_review: requiresReview,
    requires_repair: requiresRepair,
    requires_integration: requiresIntegration,
    requires_restart: requiresRestart,
    safe_to_auto_advance: safeToAutoAdvance,
    blockers,
    repairable_blockers: repairableBlockers,
    non_blocking_followups: followups,
    quality_notes: qualityNotes,
    findings: [...blockers, ...repairableBlockers],
    integration_effect: integrationEffect,
    goal_effect: goalEffect,
    queue_effect: queueEffect,
    source,
    normalized_at: timestamp,
  };
}

/**
 * Convenience: create a UnifiedAcceptanceDecision from a finalizer decision.
 */
export function fromFinalizerDecision(finalizerDecision, taskResult, task, now) {
  return normalizeToUnifiedDecision({ finalizerDecision, taskResult, task, now });
}

/**
 * Convenience: create a UnifiedAcceptanceDecision from a closure decision.
 */
export function fromClosureDecision(closureDecision, taskResult, task, now) {
  return normalizeToUnifiedDecision({ closureDecision, taskResult, task, now });
}

// ===========================================================================
// Consistency checker
// ===========================================================================

export function checkDecisionConsistency(decision) {
  if (!decision || typeof decision !== 'object') {
    return { consistent: false, issues: ['Decision is null or not an object'] };
  }

  const issues = [];

  if (!decision.status) {
    issues.push('Missing status');
  }

  if (decision.status === UNIFIED_STATUSES.COMPLETED && decision.requires_review) {
    issues.push('status=completed but requires_review=true');
  }

  if (decision.status === UNIFIED_STATUSES.COMPLETED && decision.requires_integration && !decision.integration_effect.satisfied) {
    issues.push('status=completed but requires_integration=true without integration satisfied');
  }

  if (decision.status === UNIFIED_STATUSES.COMPLETED && decision.queue_effect && decision.queue_effect.hold_queue === true) {
    issues.push('status=completed but queue_effect.hold_queue=true');
  }

  if (decision.status === UNIFIED_STATUSES.WAITING_FOR_REPAIR && list(decision.repairable_blockers).length === 0) {
    issues.push('status=waiting_for_repair but no repairable_blockers');
  }

  if (decision.status === UNIFIED_STATUSES.WAITING_FOR_INTEGRATION && decision.integration_effect && decision.integration_effect.terminal === true) {
    issues.push('status=waiting_for_integration but integration_effect.terminal=true');
  }

  if (list(decision.blockers).length > 0 && decision.blocking_passed === true) {
    issues.push('Has blockers but blocking_passed=true');
  }

  return {
    consistent: issues.length === 0,
    issues,
  };
}
