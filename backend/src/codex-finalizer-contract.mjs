/**
 * codex-finalizer-contract.mjs
 *
 * Defines and normalizes the structured result contract produced by Codex
 * execution and consumed by the task finalizer/worker loop.
 *
 * The contract is a cross-module standard for the "result.json" shape:
 *
 *   {
 *     status: "completed" | "failed" | "timed_out",
 *     summary: string | null,
 *     changed_files: string[],
 *     tests: string | null,
 *     commit: string | null,
 *     remote_head: string | null,
 *     warnings: string[],
 *     followups: string[],
 *     completed_at: string (ISO 8601)
 *   }
 *
 * This module is a contract/test hardening point, NOT a worker rewrite.
 * It does NOT replace parseCodexResult() or buildTaskResult() in
 * codex-result-parser.mjs — it provides shared definitions and helpers
 * that those modules and their callers can reference.
 *
 * @module codex-finalizer-contract
 */

// ===========================================================================
// Constants
// ===========================================================================

/** @readonly */
export const STATUS_COMPLETED = 'completed';
/** @readonly */
export const STATUS_FAILED = 'failed';
/** @readonly */
export const STATUS_TIMED_OUT = 'timed_out';

/** All valid result status values. */
export const VALID_STATUSES = [STATUS_COMPLETED, STATUS_FAILED, STATUS_TIMED_OUT];

/** Task result kind constants. */
export const KIND_EXECUTED = 'codex_executed';
/** @readonly */
export const KIND_FAILED = 'codex_failed';
/** @readonly */
export const KIND_TIMEOUT = 'codex_timeout';

/**
 * The canonical list of field names that a well-formed finalizer result
 * is expected to contain.  Used for validation, documentation, and
 * schema-aware tooling.
 */
export const RESULT_FIELDS = [
  'status',
  'summary',
  'changed_files',
  'tests',
  'commit',
  'remote_head',
  'warnings',
  'followups',
  'completed_at',
];

/**
 * Runtime file patterns — changes to files matching any of these patterns
 * require a safe restart of the gptwork-mcp service.
 */
export const RUNTIME_SRC_PATTERNS = [
  /^backend\/src\/.*\.mjs$/,
];

// ===========================================================================
// Status helpers
// ===========================================================================

/**
 * Check whether a value is a valid result status string.
 *
 * @param {*} s - Value to test.
 * @returns {boolean}
 */
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
export function detectRuntimeCodeChanges(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { hasRuntimeChanges: false, matchedFiles: [] };
  }
  const matchedFiles = changedFiles.filter(f =>
    RUNTIME_SRC_PATTERNS.some(pattern => pattern.test(f))
  );
  return {
    hasRuntimeChanges: matchedFiles.length > 0,
    matchedFiles,
  };
}

/**
 * Convenience wrapper: given a full result object, check whether its
 * changed_files array triggers runtime code change detection.
 *
 * This is the "warning pass-through" entry point — it lets callers
 * check a result for restart requirements without extracting
 * changed_files manually.
 *
 * @param {object} result - A parsed result object with changed_files.
 * @returns {{ hasRuntimeChanges: boolean, matchedFiles: string[] }}
 */
export function checkResultForRuntimeChanges(result) {
  if (!result || !Array.isArray(result.changed_files)) {
    return { hasRuntimeChanges: false, matchedFiles: [] };
  }
  return detectRuntimeCodeChanges(result.changed_files);
}
