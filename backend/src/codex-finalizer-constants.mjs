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
