import { KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT, STATUS_COMPLETED, STATUS_FAILED, STATUS_TIMED_OUT } from "./codex-finalizer-constants.mjs";

export function createSuccessResult(fields = {}) {
  return {
    status: STATUS_COMPLETED,
    kind: KIND_EXECUTED,
    summary: fields.summary || null,
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    tests: fields.tests || null,
    commit: fields.commit || null,
    remote_head: fields.remote_head || null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: fields.reviewer_decision || null,
    acceptance_findings: Array.isArray(fields.acceptance_findings) ? fields.acceptance_findings : [],
    next_tasks: Array.isArray(fields.next_tasks) ? fields.next_tasks : [],
    completed_at: fields.completed_at || new Date().toISOString(),
  };
}

/**
 * Build a standardized no-op result object.
 *
 * Semantically equivalent to createSuccessResult() but explicitly marks
 * the result as a no-op (noop: true) and leaves change/tests/commit fields
 * empty, signifying that no meaningful work was done.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant no-op result.
 */
export function createNoopResult(fields = {}) {
  return {
    status: STATUS_COMPLETED,
    kind: KIND_EXECUTED,
    summary: fields.summary || 'No changes needed (no-op)',
    changed_files: [],
    tests: null,
    commit: null,
    remote_head: null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: fields.reviewer_decision || null,
    acceptance_findings: Array.isArray(fields.acceptance_findings) ? fields.acceptance_findings : [],
    next_tasks: Array.isArray(fields.next_tasks) ? fields.next_tasks : [],
    completed_at: fields.completed_at || new Date().toISOString(),
    noop: true,
  };
}

/**
 * Build a standardized failure result object.
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
 * @returns {object} A contract-compliant failure result.
 */
export function createFailedResult(fields = {}) {
  return {
    status: STATUS_FAILED,
    kind: KIND_FAILED,
    summary: fields.summary || 'Codex execution failed',
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    tests: fields.tests || null,
    commit: fields.commit || null,
    remote_head: fields.remote_head || null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: fields.reviewer_decision || null,
    acceptance_findings: Array.isArray(fields.acceptance_findings) ? fields.acceptance_findings : [],
    next_tasks: Array.isArray(fields.next_tasks) ? fields.next_tasks : [],
    completed_at: fields.completed_at || new Date().toISOString(),
    timed_out: false,
  };
}

/**
 * Build a standardized timeout result object.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {number}  [fields.timeoutSeconds]
 * @param {string[]}[fields.changed_files]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant timeout result.
 */
export function createTimeoutResult(fields = {}) {
  return {
    status: STATUS_TIMED_OUT,
    kind: KIND_TIMEOUT,
    summary: fields.summary || 'Codex execution timed out',
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: fields.reviewer_decision || null,
    acceptance_findings: Array.isArray(fields.acceptance_findings) ? fields.acceptance_findings : [],
    next_tasks: Array.isArray(fields.next_tasks) ? fields.next_tasks : [],
    completed_at: fields.completed_at || new Date().toISOString(),
    timed_out: true,
    timeout_seconds: typeof fields.timeoutSeconds === 'number' ? fields.timeoutSeconds : 0,
  };
}

// ===========================================================================
// Validation
// ===========================================================================

/**
 * Validate a result object against the finalizer contract shape.
 *
 * Checks field types according to the contract documented at the top of
 * this module.  Reports all problems found (not just the first one).
 *
 * @param {*} result - The value to validate.
 * @returns {{ valid: boolean, errors: string[] }}
 */
