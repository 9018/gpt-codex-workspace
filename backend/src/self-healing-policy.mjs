/**
 * self-healing-policy.mjs — Task execution self-healing strategies.
 *
 * Defines recovery strategies for common runtime errors:
 * - ENOSPC / tmp write failures
 * - No first output timeout
 * - Stale repo locks
 * - Worker crashes
 * - Missing result.json
 * - Safe restart interruptions
 */

/**
 * Error categories for self-healing classification.
 */
export const ERROR_CATEGORIES = {
  ENOSPC: 'enospc',
  NO_FIRST_OUTPUT: 'no_first_output',
  STALE_LOCK: 'stale_lock',
  WORKER_CRASH: 'worker_crash',
  RESULT_MISSING: 'result_missing',
  RESTART_INTERRUPTED: 'restart_interrupted',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
};

/**
 * Classify an error into a self-healing category.
 *
 * @param {Error|object|string} error
 * @returns {{ category: string, code: string, recoverable: boolean, retry_budget: number }}
 */
export function classifyError(error) {
  const msg = String(error?.message || error || '').toLowerCase();

  if (msg.includes('enospc') || msg.includes('no space') || msg.includes('disk full')) {
    return { category: ERROR_CATEGORIES.ENOSPC, code: 'ENOSPC', recoverable: true, retry_budget: 1 };
  }
  if (msg.includes('no first output') || msg.includes('first_output_timeout')) {
    return { category: ERROR_CATEGORIES.NO_FIRST_OUTPUT, code: 'no_first_output_timeout', recoverable: true, retry_budget: 1 };
  }
  if (msg.includes('stale lock') || msg.includes('lock stale') || msg.includes('lock not released')) {
    return { category: ERROR_CATEGORIES.STALE_LOCK, code: 'stale_lock', recoverable: true, retry_budget: 2 };
  }
  if (msg.includes('worker crash') || msg.includes('child pid dead') || msg.includes('worker died')) {
    return { category: ERROR_CATEGORIES.WORKER_CRASH, code: 'worker_crash', recoverable: true, retry_budget: 1 };
  }
  if (msg.includes('result.json missing') || msg.includes('result missing') || msg.includes('no result')) {
    return { category: ERROR_CATEGORIES.RESULT_MISSING, code: 'result_missing', recoverable: true, retry_budget: 1 };
  }
  if (msg.includes('restart') && (msg.includes('interrupted') || msg.includes('mismatch'))) {
    return { category: ERROR_CATEGORIES.RESTART_INTERRUPTED, code: 'restart_interrupted', recoverable: false, retry_budget: 0 };
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { category: ERROR_CATEGORIES.TIMEOUT, code: 'timeout', recoverable: true, retry_budget: 1 };
  }

  return { category: ERROR_CATEGORIES.UNKNOWN, code: 'unknown', recoverable: false, retry_budget: 0 };
}

/**
 * Determine the healing action for a given error and task context.
 *
 * @param {object} options
 * @param {Error|string} options.error - The error
 * @param {object} options.task - Task context
 * @param {number} [options.retryCount=0] - Current retry count
 * @returns {{ action: string, next_status: string, compact_context: boolean, cleanup_tmp: boolean, reason: string }}
 */
export function determineHealingAction({ error, task = {}, retryCount = 0 } = {}) {
  const classified = classifyError(error);
  const budget = classified.retry_budget;

  if (!classified.recoverable || retryCount >= budget) {
    return {
      action: 'waiting_for_review',
      next_status: 'waiting_for_review',
      compact_context: false,
      cleanup_tmp: false,
      reason: `Error not recoverable or budget exceeded: ${classified.category} (attempt ${retryCount + 1}/${budget})`,
    };
  }

  switch (classified.category) {
    case ERROR_CATEGORIES.ENOSPC:
      return {
        action: 'cleanup_and_retry',
        next_status: 'repairing',
        compact_context: false,
        cleanup_tmp: true,
        reason: 'ENOSPC: cleaning up tmp and retrying prompt write',
      };

    case ERROR_CATEGORIES.NO_FIRST_OUTPUT:
      return {
        action: 'compact_and_retry',
        next_status: 'repairing',
        compact_context: true,
        cleanup_tmp: false,
        reason: 'No first output: building smaller context bundle and retrying',
      };

    case ERROR_CATEGORIES.STALE_LOCK:
      return {
        action: 'reconcile_lock_and_retry',
        next_status: 'waiting_for_lock',
        compact_context: false,
        cleanup_tmp: false,
        reason: 'Stale lock: reconciling and retrying',
      };

    case ERROR_CATEGORIES.WORKER_CRASH:
      return {
        action: 'recover_and_retry',
        next_status: 'repairing',
        compact_context: false,
        cleanup_tmp: false,
        reason: 'Worker crash: preserving worktree and creating recovery task',
      };

    case ERROR_CATEGORIES.RESULT_MISSING:
      return {
        action: 'fallback_parse_and_retry',
        next_status: 'repairing',
        compact_context: false,
        cleanup_tmp: false,
        reason: 'Result.json missing: falling back to stdout/last-message parser',
      };

    case ERROR_CATEGORIES.TIMEOUT:
      return {
        action: 'compact_and_retry',
        next_status: 'repairing',
        compact_context: true,
        cleanup_tmp: false,
        reason: 'Timeout: building smaller context bundle and retrying',
      };

    default:
      return {
        action: 'waiting_for_review',
        next_status: 'waiting_for_review',
        compact_context: false,
        cleanup_tmp: false,
        reason: `Unknown error: ${classified.category} — requires review`,
      };
  }
}
