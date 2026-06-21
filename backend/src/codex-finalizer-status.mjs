import { STATUS_COMPLETED, VALID_STATUSES } from "./codex-finalizer-constants.mjs";

export function isValidStatus(s) {
  return VALID_STATUSES.includes(s);
}

// ===========================================================================
// No-op detection
// ===========================================================================

/**
 * Detect whether a parsed result represents a "no-op" execution — one that
 * produced no meaningful changes, test evidence, or commit to push.
 *
 * A result is considered a no-op when all of these hold:
 *   - `status` is "completed"
 *   - `changed_files` is empty (or missing)
 *   - `tests` is null, undefined, or the literal "none"
 *   - `commit` is null, undefined, or the literal "none"
 *
 * @param {object|null|undefined} result - A parsed result object.
 * @returns {boolean} `true` when the result is a no-op.
 */
export function isNoopResult(result) {
  if (!result || result.status !== STATUS_COMPLETED) return false;

  const noChangedFiles = !Array.isArray(result.changed_files) || result.changed_files.length === 0;
  const noTests = !result.tests || result.tests === 'none';
  const noCommit = !result.commit || result.commit === 'none';

  return noChangedFiles && noTests && noCommit;
}

// ===========================================================================
// Factory functions — produce contract-compliant result objects
// ===========================================================================

/**
 * Build a standardized success (completed) result object.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {string[]}[fields.changed_files]
 * @param {string}  [fields.tests]
 * @param {string}  [fields.commit]
 * @param {string}  [fields.remote_head]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant success result.
 */
