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
  'reviewer_decision',
  'acceptance_findings',
  'next_tasks',
  'completed_at',
];

/**
 * Runtime file patterns — changes to files matching any of these patterns
 * require a safe restart of the gptwork-mcp service.
 */
export const RUNTIME_SRC_PATTERNS = [
  /^backend\/src\/.*\.mjs$/,
  /^backend\/bin\/gptwork\.mjs$/,
  /^backend\/package\.json$/,
  /^backend\/src\/server-tools\.mjs$/,
  /^backend\/src\/tool-groups\/.*\.mjs$/,
  /^backend\/src\/.*runtime.*\.mjs$/,
  /^backend\/src\/.*worker.*\.mjs$/,
  /^backend\/src\/.*mcp.*\.mjs$/,
  /^backend\/src\/codex-finalizer-contract\.mjs$/,
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
