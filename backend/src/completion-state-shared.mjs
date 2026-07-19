/**
 * completion-state-shared.mjs — Shared completion-state constants and helpers.
 *
 * P0: Single source of truth for profile sets, integration statuses, and
 * evidence-checking predicates used across convergence, finalizer, closure,
 * and classifier modules.
 *
 * Consolidates definitions that were duplicated in:
 *   - task-convergence.mjs
 *   - goal-convergence.mjs
 *   - task-finalizer.mjs
 *   - no-change-repair-classifier.mjs
 *   - auto-integration-completion.mjs
 *   - closure/task-closure-reconciler.mjs
 *
 * Consumers should import from here instead of defining their own copies.
 */

// ===========================================================================
// Profile constants
// ===========================================================================

/**
 * Tasks where changed_files=[] is a legitimate terminal state.
 * These profiles do NOT require integration, changed_files, or verification
 * evidence to complete.
 */
export const NO_MUTATION_PROFILES = new Set([
  'diagnostic', 'noop', 'readonly_validation', 'already_integrated',
  'repair_noop', 'network_retry', 'verification_only', 'sync_only',
  'github_sync_only', 'docs_only',
]);

/**
 * Subset of NO_MUTATION_PROFILES that are "sync-like" — used by
 * isNonBlockerForProfile to determine which findings should not block
 * auto-completion for sync, verification, or noop tasks.
 */
export const SYNC_LIKE_PROFILES = new Set([
  'sync_only', 'github_sync_only', 'verification_only', 'noop',
  'repair_noop', 'network_retry',
]);

// ===========================================================================
// Integration status constants
// ===========================================================================

/**
 * Terminal integration statuses — when the integration queue reaches any
 * of these, integration is satisfied and no further integration work is
 * needed for this task.
 */
export const TERMINAL_INTEGRATION_STATUSES = new Set([
  'merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated',
]);

/**
 * Non-terminal integration statuses — integration work is still in progress
 * or pending but not yet terminal.
 */
export const NON_TERMINAL_INTEGRATION_STATUSES = new Set([
  'branch_pushed', 'pr_opened', 'pending', 'queued', 'locked', 'waiting',
]);

/**
 * Repairable integration statuses — integration failures that can be
 * automatically repaired through retry/rebuild.
 */
export const REPAIRABLE_INTEGRATION_STATUSES = new Set([
  'conflict', 'check_failed', 'push_failed', 'pr_failed',
]);

// ===========================================================================
// Evidence-checking helpers
// ===========================================================================

/**
 * Check if verification evidence is present and passing.
 *
 * Accepts both direct verification and auto-integration-completion sources.
 * Used by task-finalizer, no-change-repair-classifier, and closure-reconciler.
 *
 * @param {object} result - Task result object (or evidence object)
 * @returns {boolean}
 */
export function verificationPassed(result = {}) {
  const verification = result.verification || result.final_verification || {};
  if (verification.passed === true) return true;
  if (result.auto_integration_completion?.completed === true &&
      result.auto_integration_completion?.verification_report?.passed !== false) return true;
  return false;
}

/**
 * Collect unresolved blocking/major findings from the task result.
 *
 * @param {object} result - Task result object
 * @returns {Array} Filtered array of {severity, code, message, ...}
 */
export function unresolvedBlockingFindings(result = {}) {
  const findings = [
    ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
    ...(Array.isArray(result.findings) ? result.findings : []),
    ...(Array.isArray(result.verification?.findings) ? result.verification.findings : []),
  ];
  return findings.filter(f => f?.resolved !== true &&
    (f?.severity === 'blocker' || f?.severity === 'major'));
}

/**
 * Check if acceptance evidence has passed.
 *
 * Accepts reviewer_decision, acceptance_gate, and verification-based signals.
 *
 * @param {object} result - Task result object
 * @returns {boolean}
 */
export function acceptancePassed(result = {}) {
  const reviewer = result.reviewer_decision || {};
  const acceptance = result.acceptance_gate || result.acceptance || {};
  if (acceptance.passed === true || acceptance.status === 'accepted') return true;
  if (reviewer.passed === true || reviewer.status === 'accepted' || reviewer.decision === 'accepted') return true;
  if (reviewer.decision?.passed === true || reviewer.decision?.status === 'accepted' || reviewer.decision?.decision === 'accepted') return true;
  if (result.requires_review !== true && verificationPassed(result) && unresolvedBlockingFindings(result).length === 0) return true;
  return false;
}

/**
 * Check if integration evidence is satisfied (terminal state reached or not required).
 *
 * @param {object} result - Task result object
 * @param {object} [integrationResult] - Separate integration result (optional)
 * @returns {boolean}
 */
export function integrationIsSatisfied(result = {}, integrationResult = {}) {
  const integration = result.integration || integrationResult || {};
  if (result.needs_integration === false) return true;
  if (integration.required === false || integration.satisfied === true ||
      integration.merged === true || integration.auto_completed === true) return true;
  if (result.auto_integration_completion?.completed === true &&
      result.auto_integration_completion?.verification_report?.passed !== false) return true;
  return TERMINAL_INTEGRATION_STATUSES.has(String(integration.status || '').toLowerCase());
}

/**
 * Check if a finding code should not block auto-completion for a given profile.
 *
 * Sync-like, noop, and certain repair profiles are allowed to complete
 * even with tests_missing or changed_files_mismatch findings.
 *
 * @param {string} code - Finding code
 * @param {string} profile - Acceptance profile
 * @returns {boolean}
 */
export function isNonBlockerForProfile(code, profile) {
  if (!code || !profile) return false;
  if (code === 'tests_missing') return SYNC_LIKE_PROFILES.has(profile);
  if (code === 'changed_files_mismatch') return SYNC_LIKE_PROFILES.has(profile);
  if (code === 'git_worktree_lifecycle_metadata_only') return true;
  if (code === 'worktree_no_changes_yet') return true;
  if (code === 'no_worktree_artifact') return true;
  return false;
}

/**
 * Check if the task result contains sufficient completion evidence.
 *
 * Used by goal-convergence to determine if a task with 'completed' status
 * should result in the goal also reaching 'completed'.
 *
 * @param {object} taskResult - Task result object
 * @returns {boolean}
 */
export function hasCompletionEvidence(taskResult = {}) {
  if (!taskResult || typeof taskResult !== 'object') return false;
  if (taskResult.closure_decision?.auto_complete_allowed === true) return true;
  if (['auto_completed_clean', 'auto_completed_with_followups'].includes(taskResult.closure_decision?.status)) return true;
  if (taskResult.reviewer_decision?.passed === true) return true;
  if (['accepted', 'accepted_with_followups'].includes(taskResult.reviewer_decision?.status)) return true;
  if (verificationPassed(taskResult)) return true;
  if (taskResult.integration?.status === 'merged' || taskResult.integration?.status === 'skipped' || taskResult.integration?.merged === true) return true;
  // Unified decision canonical completion
  if (taskResult.unified_decision?.status === 'completed') return true;
  return false;
}

/**
 * Determine if a profile is a no-mutation profile (no code changes expected).
 *
 * @param {string} profile - Profile name to check
 * @returns {boolean}
 */
export function isNoMutationProfile(profile) {
  return NO_MUTATION_PROFILES.has(profile);
}

/**
 * Determine if a profile is a sync-like profile (sync/verification/noop).
 *
 * @param {string} profile - Profile name to check
 * @returns {boolean}
 */
export function isSyncLikeProfile(profile) {
  return SYNC_LIKE_PROFILES.has(profile);
}
