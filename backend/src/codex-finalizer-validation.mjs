import { RESULT_FIELDS } from "./codex-finalizer-constants.mjs";
import { isValidStatus } from "./codex-finalizer-status.mjs";

export function validateFinalizerResult(result) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    return { valid: false, errors: ['result must be a non-null object'] };
  }

  if (!isValidStatus(result.status)) {
    errors.push(`invalid status: ${result.status}`);
  }

  if (result.summary !== undefined && result.summary !== null && typeof result.summary !== 'string') {
    errors.push('summary must be a string or null');
  }

  if (result.changed_files !== undefined && !Array.isArray(result.changed_files)) {
    errors.push('changed_files must be an array');
  }

  if (result.tests !== undefined && result.tests !== null && typeof result.tests !== 'string') {
    errors.push('tests must be a string or null');
  }

  if (result.commit !== undefined && result.commit !== null && typeof result.commit !== 'string') {
    errors.push('commit must be a string or null');
  }

  if (result.remote_head !== undefined && result.remote_head !== null && typeof result.remote_head !== 'string') {
    errors.push('remote_head must be a string or null');
  }

  if (result.warnings !== undefined && !Array.isArray(result.warnings)) {
    errors.push('warnings must be an array');
  }

  if (result.followups !== undefined && !Array.isArray(result.followups)) {
    errors.push('followups must be an array');
  }

  if (result.reviewer_decision !== undefined && result.reviewer_decision !== null && typeof result.reviewer_decision !== 'object') {
    errors.push('reviewer_decision must be an object or null');
  }

  if (result.acceptance_findings !== undefined && !Array.isArray(result.acceptance_findings)) {
    errors.push('acceptance_findings must be an array');
  }

  if (result.next_tasks !== undefined && !Array.isArray(result.next_tasks)) {
    errors.push('next_tasks must be an array');
  }

  if (result.repair_proposal !== undefined && result.repair_proposal !== null && typeof result.repair_proposal !== 'object') {
    errors.push('repair_proposal must be an object or null');
  }

  if (result.completed_at !== undefined && result.completed_at !== null && typeof result.completed_at !== 'string') {
    errors.push('completed_at must be a string or null');
  }

  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// Runtime code change detection
// ===========================================================================

/**
 * Check whether a list of changed files includes any runtime server source
 * files that would require a safe restart.
 *
 * Pattern matches are performed against RUNTIME_SRC_PATTERNS.
 *
 * @param {string[]} changedFiles - File paths to check.
 * @returns {{ hasRuntimeChanges: boolean, matchedFiles: string[] }}
 */
