/**
 * task-review-status-taxonomy.mjs — Typed review/recovery states for task finalization.
 *
 * Replaces the generic waiting_for_review catch-all with typed interrupt/recovery
 * states so that human review is a precise interrupt, not a default fallback for
 * machine-repairable issues.
 */

// ---------------------------------------------------------------------------
// Typed Review / Recovery States
// ---------------------------------------------------------------------------

export const REVIEW_STATES = Object.freeze({
  /** Ambiguous product decision or semantic ambiguity requiring human judgment. */
  WAITING_FOR_HUMAN_REVIEW: 'waiting_for_human_review',
  /** Missing result evidence (result.json missing, no verification output) that can be auto-repaired. */
  WAITING_FOR_MISSING_EVIDENCE_REPAIR: 'waiting_for_missing_evidence_repair',
  /** Integration failure (conflict, push failed, PR failed) that can be auto-retried. */
  WAITING_FOR_INTEGRATION_RECOVERY: 'waiting_for_integration_recovery',
  /** Invalid result contract or acceptance failure that can be repaired. */
  WAITING_FOR_RESULT_CONTRACT_REPAIR: 'waiting_for_result_contract_repair',
  /** No-mutation change needs evidence that no functional changes were made. */
  WAITING_FOR_NOOP_EVIDENCE: 'waiting_for_noop_evidence',
  /** Task reached a state that requires a human terminal decision (force complete/fail/block). */
  WAITING_FOR_MANUAL_TERMINAL_DECISION: 'waiting_for_manual_terminal_decision',
  /** Repair budget exhausted, human must decide next action. */
  HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED: 'human_interrupted_for_repair_budget_exhausted',
});

/** Legacy catch-all status kept for backward compatibility. */
export const LEGACY_WAITING_FOR_REVIEW = 'waiting_for_review';

/** Set of all typed review/recovery states. */
export const TYPED_REVIEW_STATES = Object.freeze(new Set(Object.values(REVIEW_STATES)));

// ---------------------------------------------------------------------------
// Resume options / next_action metadata per typed state
// ---------------------------------------------------------------------------

export const REVIEW_STATE_META = Object.freeze({
  [REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW]: {
    label: 'Waiting for Human Review',
    resume_options: ['review_and_accept', 'review_and_reject', 'request_changes'],
    next_action: 'human_review_required',
    machine_repairable: false,
    description: 'Ambiguous product decision or semantic ambiguity requiring human judgment.',
  },
  [REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR]: {
    label: 'Waiting for Missing Evidence Repair',
    resume_options: ['retry_repair', 'abort_repair', 'manual_fix'],
    next_action: 'auto_repair',
    machine_repairable: true,
    description: 'Missing result evidence (result.json missing, no verification output) that can be auto-repaired.',
  },
  [REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY]: {
    label: 'Waiting for Integration Recovery',
    resume_options: ['retry_integration', 'manual_integration', 'skip_integration'],
    next_action: 'integration_recovery',
    machine_repairable: true,
    description: 'Integration failure (conflict, push failed, PR failed) that can be auto-retried.',
  },
  [REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR]: {
    label: 'Waiting for Result Contract Repair',
    resume_options: ['retry_repair', 'manual_contract_fix', 'override_acceptance'],
    next_action: 'contract_repair',
    machine_repairable: true,
    description: 'Invalid result contract or acceptance failure that can be repaired.',
  },
  [REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE]: {
    label: 'Waiting for No-op Evidence',
    resume_options: ['confirm_noop', 'request_evidence', 'retry'],
    next_action: 'evidence_collection',
    machine_repairable: true,
    description: 'No-mutation change needs evidence that no functional changes were made.',
  },
  [REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION]: {
    label: 'Waiting for Manual Terminal Decision',
    resume_options: ['force_complete', 'force_fail', 'force_block', 'retry'],
    next_action: 'human_terminal_decision',
    machine_repairable: false,
    description: 'Task reached a state that requires a human terminal decision (force complete/fail/block).',
  },
  [REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED]: {
    label: 'Human Interrupted for Repair Budget Exhausted',
    resume_options: ['review_exhausted', 'extend_budget', 'override_status'],
    next_action: 'human_review_of_exhausted_repairs',
    machine_repairable: false,
    description: 'Repair budget exhausted, human must decide next action.',
  },
});

// ---------------------------------------------------------------------------
// Classifier — map finalizer blockers + reason to a typed review state
// ---------------------------------------------------------------------------

/**
 * Classify a finalizer reason/blocker set into a typed review state.
 *
 * @param {object} options
 * @param {string} [options.reason] - Finalizer reason string (e.g. "manual_review_required")
 * @param {Array}  [options.blockers] - Finalizer blockers array [{code, message, ...}]
 * @param {boolean}[options.repairBudgetExhausted] - Whether repair budget was exhausted
 * @returns {{ reviewState: string, metadata: object }}
 */
export function classifyReviewState({ reason = '', blockers = [], repairBudgetExhausted = false } = {}) {
  const codes = new Set(
    (Array.isArray(blockers) ? blockers : [])
      .map(b => (b && b.code) || '')
      .filter(Boolean)
  );
  const reasonLower = String(reason || '').toLowerCase();

  // --- Repair budget exhausted gets the highest priority ---
  if (repairBudgetExhausted) {
    return {
      reviewState: REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED,
      metadata: REVIEW_STATE_META[REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED],
    };
  }

  // --- Manual approval / state corruption / unsafe operations → human decision ---
  if (codes.has('manual_approval_required') || codes.has('state_corruption') ||
      codes.has('unsafe_operation')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION],
    };
  }

  // --- Integration failures that are repairable ---
  if (codes.has('integration_conflict') || codes.has('integration_push_failed') ||
      codes.has('integration_pr_failed') || codes.has('integration_check_failed') ||
      codes.has('integration_required_not_terminal') ||
      reasonLower.includes('integration')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY],
    };
  }

  // --- Contract/acceptance issues ---
  if (codes.has('semantic_ambiguity')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW],
    };
  }

  if (codes.has('contract_invalid') || codes.has('contract_requires_review')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR],
    };
  }

  // --- Missing evidence (result.json, verification, etc.) ---
  if (codes.has('result_missing') || codes.has('verification_missing') ||
      codes.has('delivery_result_writeback_missing') ||
      reasonLower.includes('result_missing') ||
      reasonLower === 'result_missing_with_diff' || reasonLower === 'result_missing_no_diff') {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR],
    };
  }

  // --- No-op evidence missing (no-mutation changes, commit_missing, changed_files_missing) ---
  if (codes.has('no_mutation_evidence_missing') || codes.has('changed_files_missing') ||
      codes.has('commit_missing') || codes.has('changed_files_mismatch') ||
      codes.has('tests_missing') ||
      reasonLower.includes('noop') || reasonLower.includes('no_mutation') ||
      reasonLower.includes('changed_files_missing') || reasonLower.includes('commit_missing')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE],
    };
  }

  // --- Codex-failed / execution-failed / repair-proposal blockers ---
  // P0-C7: Route execution_failed and codex_failed to auto-repair (missing evidence repair)
  // rather than human review. These are machine-repairable in the productized repair loop.
  if (codes.has('execution_failed') || codes.has('codex_failed') || codes.has('unrecoverable_execution_failure')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR],
    };
  }

  // --- P0-C7: Acceptance failed → result contract repair ---
  if (codes.has('acceptance_failed')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR],
    };
  }

  // --- P0-C7: Context missing → missing evidence repair ---
  if (codes.has('context_missing')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR],
    };
  }

  // --- P0-C7: Deployment failed → human review (non-repairable) ---
  if (codes.has('deployment_failed')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW],
    };
  }

  // --- Insufficient terminal evidence / catch-all ---
  if (codes.has('insufficient_terminal_evidence') ||
      codes.has('contract_missing') ||
      reasonLower.includes('unhandled') || reasonLower.includes('insufficient')) {
    return {
      reviewState: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
      metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW],
    };
  }

  // --- Default: true human review ---
  return {
    reviewState: REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW,
    metadata: REVIEW_STATE_META[REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a status string is one of the typed review/recovery states.
 * @param {string} state
 * @returns {boolean}
 */
export function isTypedReviewState(state) {
  return TYPED_REVIEW_STATES.has(state);
}

/**
 * Check whether a typed review state is machine-repairable.
 * Returns false for non-typed or unknown states.
 * @param {string} state
 * @returns {boolean}
 */
export function isMachineRepairableReviewState(state) {
  const meta = REVIEW_STATE_META[state];
  return meta ? meta.machine_repairable : false;
}

/**
 * Get resume options for a typed review state.
 * Returns empty array for non-typed or unknown states.
 * @param {string} state
 * @returns {string[]}
 */
export function getResumeOptions(state) {
  const meta = REVIEW_STATE_META[state];
  return meta ? [...meta.resume_options] : [];
}

/**
 * Get the recommended next action for a typed review state.
 * @param {string} state
 * @returns {string|null}
 */
export function getNextAction(state) {
  const meta = REVIEW_STATE_META[state];
  return meta ? meta.next_action : null;
}

/**
 * Create a review_state metadata block for attaching to a finalizer decision.
 *
 * @param {object} options - Same as classifyReviewState
 * @returns {{ review_state: string, review_meta: object, resume_options: string[], next_action: string, machine_repairable: boolean }}
 */
export function createReviewStateBlock(options = {}) {
  const { reviewState, metadata } = classifyReviewState(options);
  return {
    review_state: reviewState,
    review_meta: metadata,
    resume_options: [...metadata.resume_options],
    next_action: metadata.next_action,
    machine_repairable: metadata.machine_repairable,
  };
}
