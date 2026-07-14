/**
 * task-retry.mjs — Bounded retry and quarantine logic for Codex task failures.
 *
 * Provides:
 * - Retry policy definitions per failure class
 * - Backoff computation (exponential with jitter)
 * - Budget exhaustion checks
 * - Forward-compatible re-exports from failure-classifier.mjs
 */

import {
  classifyFailure,
  failureClassRequiresRepair,
  failureClassIsTerminalNonRepairable,
  classifyFailureStructured,
  getFailureClassDefinition,
  failureClassIsQuarantined,
  failureClassIsRetryable,
} from "./failure-classifier.mjs";

// Re-export for backward compatibility
// Delivery-spec compatible re-exports - repair-loop functions for task finalizer and tests
export { shouldAttemptRepair, createRepairGoalFromFindings } from "./repair-loop.mjs";
export { classifyFailure, failureClassRequiresRepair, failureClassIsTerminalNonRepairable, classifyFailureStructured, getFailureClassDefinition, failureClassIsQuarantined, failureClassIsRetryable };

// ---------------------------------------------------------------------------
// Retry policy definitions
// ---------------------------------------------------------------------------

/**
 * Default retry configuration per failure class.
 *
 * maxRetries: max number of automatic retries before escalating
 * baseDelayMs: base delay for exponential backoff
 * maxDelayMs: max delay cap
 * fallbackStatus: status to use if retries are exhausted (not repairable)
 * dedupeWindowMs: deduplication window
 */
const DEFAULT_RETRY_POLICIES = {
  rate_limited: { maxRetries: 3, baseDelayMs: 30_000, maxDelayMs: 300_000, fallbackStatus: "blocked", dedupeWindowMs: 60_000 },
  quota_exceeded: { maxRetries: 2, baseDelayMs: 60_000, maxDelayMs: 600_000, fallbackStatus: "blocked", dedupeWindowMs: 120_000 },
  gateway_error: { maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 120_000, fallbackStatus: "blocked", dedupeWindowMs: 30_000 },
  service_unavailable: { maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 120_000, fallbackStatus: "blocked", dedupeWindowMs: 30_000 },
  transient_network_error: { maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 60_000, fallbackStatus: "blocked", dedupeWindowMs: 15_000 },
  provider_interruption: { maxRetries: 2, baseDelayMs: 15_000, maxDelayMs: 120_000, fallbackStatus: "blocked", dedupeWindowMs: 30_000 },
  execution_timeout: { maxRetries: 1, baseDelayMs: 30_000, maxDelayMs: 120_000, fallbackStatus: "failed", dedupeWindowMs: 60_000 },
  startup_timeout: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 60_000, fallbackStatus: "failed", dedupeWindowMs: 30_000 },
  result_missing: { maxRetries: 1, baseDelayMs: 5_000, maxDelayMs: 30_000, fallbackStatus: "failed", dedupeWindowMs: 15_000 },
  codex_timeout: { maxRetries: 1, baseDelayMs: 30_000, maxDelayMs: 120_000, fallbackStatus: "failed", dedupeWindowMs: 60_000 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the retry policy for a given failure class.
 *
 * Falls back to a conservative policy for unknown failures.
 *
 * @param {string} failureClass
 * @returns {{ maxRetries: number, baseDelayMs: number, maxDelayMs: number, fallbackStatus: string, dedupeWindowMs: number }}
 */
export function getRetryPolicy(failureClass) {
  return DEFAULT_RETRY_POLICIES[failureClass] || {
    maxRetries: 1,
    baseDelayMs: 30_000,
    maxDelayMs: 120_000,
    fallbackStatus: "failed",
    dedupeWindowMs: 30_000,
  };
}

/**
 * Compute the backoff delay for a given attempt and failure class.
 *
 * Uses exponential backoff with jitter:
 *   delay = min(baseDelay * 2^(attempt-1), maxDelay)
 *   jitter = random(0.5, 1.5) * delay
 *
 * @param {number} attempt - Current attempt (1-based)
 * @param {string} failureClass - Failure class name
 * @returns {number} Backoff delay in milliseconds
 */
export function computeRetryBackoff(attempt, failureClass) {
  const policy = getRetryPolicy(failureClass);
  const delay = Math.min(policy.baseDelayMs * Math.pow(2, attempt - 1), policy.maxDelayMs);
  const jitter = delay * (0.5 + Math.random());
  return Math.round(jitter);
}

/**
 * Determine the status hint for a retry.
 *
 * For rate_limited/quota_exceeded → "quota_wait"
 * For other retryable failures → "retry_wait"
 * For non-retryable → fallbackStatus from policy
 *
 * @param {string} failureClass
 * @returns {string}
 */
export function getRetryStatusHint(failureClass) {
  const def = getFailureClassDefinition(failureClass);
  if (def) return def.nextStatusHint;

  const policy = getRetryPolicy(failureClass);
  return policy.fallbackStatus;
}

/**
 * Check whether the retry budget is exhausted for a given task.
 *
 * Compares current attempt count against the policy's maxRetries.
 *
 * @param {object} options
 * @param {number} options.attempt - Current attempt count (0-based or 1-based)
 * @param {string} options.failureClass - Failure class name
 * @param {number} [options.maxRetries] - Override max retries
 * @returns {{ exhausted: boolean, maxRetries: number, currentAttempt: number, reason: string }}
 */
export function isRetryBudgetExhausted({ attempt, failureClass, maxRetries } = {}) {
  const policy = getRetryPolicy(failureClass);
  const max = maxRetries != null ? maxRetries : policy.maxRetries;
  // Normalize: if attempt is 0-based, add 1 for comparison
  const currentAttempt = attempt;
  const exhausted = currentAttempt >= max;

  return {
    exhausted,
    maxRetries: max,
    currentAttempt,
    reason: exhausted
      ? `Retry budget exhausted: ${currentAttempt}/${max} attempts for ${failureClass}`
      : `Retry budget remaining: ${currentAttempt}/${max} attempts for ${failureClass}`,
  };
}

/**
 * Get the recommended next status when retry budget is exhausted.
 *
 * @param {string} failureClass - Failure class name
 * @returns {string} "blocked" or "failed"
 */
export function getRetryExhaustedStatus(failureClass) {
  const policy = getRetryPolicy(failureClass);
  return policy.fallbackStatus;
}

/**
 * Compute the deduplication key for a retry event.
 *
 * @param {string} taskId - Task ID
 * @param {string} failureClass - Failure class name
 * @param {number} attempt - Current attempt
 * @returns {string}
 */
export function computeRetryDedupeKey(taskId, failureClass, attempt) {
  return `${taskId}:retry:${failureClass}:${attempt}`;
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Determine the next status for a task based on failure classification and retry state.
 *
 * This is the main entry point for the convergence module to decide:
 * - quota_wait for rate_limited/quota_exceeded
 * - retry_wait for retryable network/transient errors
 * - waiting_for_repair for repairable failures
 * - blocked/failed for exhausted retries
 *
 * @param {object} options
 * @param {object} options.taskResult - Task result object
 * @param {number} [options.attempt=0] - Current attempt count
 * @param {string} [options.failureClass] - Pre-classified failure class (optional)
 * @returns {{ status: string, reason: string, retryable: boolean, repairable: boolean, exhausted: boolean }}
 */
export function determineRetryStatus({ taskResult, attempt = 0, failureClass } = {}) {
  const fc = failureClass || (taskResult ? classifyFailure({
    resultJson: taskResult,
    result: taskResult,
    message: taskResult.summary || "",
  }) : "unknown");

  // When failureClass is provided, use getFailureClassDefinition for structured lookup
  // When not provided, derive from classifyFailureStructured
  const structured = failureClass
    ? (getFailureClassDefinition(failureClass) || { ...classifyFailureStructured({ resultJson: taskResult, result: taskResult, message: fc }), class: failureClass })
    : classifyFailureStructured({
        resultJson: taskResult,
        result: taskResult,
        message: taskResult.summary || "",
      });

  // Network/transient → check retry budget
  if (structured.retryable) {
    const budget = isRetryBudgetExhausted({ attempt, failureClass: fc });
    if (budget.exhausted) {
      return {
        status: getRetryExhaustedStatus(fc),
        reason: budget.reason,
        retryable: false,
        repairable: false,
        exhausted: true,
        failureClass: fc,
      };
    }
    return {
      status: structured.nextStatusHint, // quota_wait or retry_wait
      reason: `${structured.description} (attempt ${attempt + 1})`,
      retryable: true,
      repairable: false,
      exhausted: false,
      failureClass: fc,
    };
  }

  // Repairable failures → repair
  if (structured.repairable) {
    return {
      status: "waiting_for_repair",
      reason: `${structured.description} — attempting repair`,
      retryable: false,
      repairable: true,
      exhausted: false,
      failureClass: fc,
    };
  }

  // Unknown / non-retryable → failed
  return {
    status: structured.nextStatusHint || "failed",
    reason: `${structured.description} — cannot retry or repair`,
    retryable: false,
    repairable: false,
    exhausted: true,
    failureClass: fc,
  };
}

// ---------------------------------------------------------------------------
// P1: Contract-inheriting retry iteration (full mode)
// ---------------------------------------------------------------------------
// Per the repair plan, retries must inherit the full contract from the parent
// task, with NO semantic re-inference. The contract hash must match exactly.

import { createHash } from "node:crypto";

/**
 * Compute a deterministic hash of an acceptance contract for inheritance check.
 */
export function hashContract(contract) {
  if (!contract) return null;
  return createHash("sha256").update(JSON.stringify(contract, Object.keys(contract).sort())).digest("hex").slice(0, 16);
}

/**
 * Create a retry iteration that inherits the parent's full acceptance contract.
 *
 * @param {object} tx - Transaction handle with tasks.create, tasks.setState, queue
 * @param {object} aggregate - TaskRuntimeAggregate for the failed task
 * @param {object} failure - Failure classification { class, reason, ... }
 * @returns {Promise<{ terminal: boolean, retry_task_id?: string }>}
 *
 * Key invariants:
 * - The retry's acceptance_contract is a deep clone of the parent's, with ONLY
 *   attempt, iteration, and failure_context updated.
 * - The contract hash matches the parent's contract hash.
 * - No semantic inference (inferOperationKind) is called.
 * - No workflow apply proposal is created.
 */
export async function createRetryIterationAtomic(tx, aggregate, failure) {
  const task = aggregate.task;
  const policy = task.acceptance_contract?.retry_policy || { max_attempts: 3 };
  const nextAttempt = (task.attempt || 0) + 1;

  if (nextAttempt > (policy.max_attempts || 3)) {
    // Budget exhausted — fail terminally
    await tx.tasks.setState(task.id, "failed", {
      failure_class: "retry_budget_exhausted",
      previous_failure: failure,
    });
    await tx.locks.releaseForTask(task.id);
    return { terminal: true };
  }

  await tx.tasks.setState(task.id, "repairing");

  // Clone the acceptance contract — NO re-inference
  const inheritedContract = structuredClone(task.acceptance_contract || {});

  // Verify the clone hash matches parent
  const parentHash = hashContract(task.acceptance_contract);
  const cloneHash = hashContract(inheritedContract);
  if (parentHash && parentHash !== cloneHash) {
    throw new Error(
      `Contract hash mismatch on retry: parent=${parentHash} clone=${cloneHash}. ` +
      "Retry must inherit the exact contract without modification."
    );
  }

  const retryTask = await tx.tasks.create({
    id: `${task.root_task_id || task.id}_retry_${nextAttempt}`,
    root_task_id: task.root_task_id || task.id,
    parent_task_id: task.id,
    attempt: nextAttempt,
    acceptance_contract: inheritedContract,
    failure_context: {
      class: failure.class || failure.failure_class || "unknown",
      reason: failure.reason || "",
      at: new Date().toISOString(),
    },
    // Carry forward identity fields
    goal_id: task.goal_id,
    repo_id: task.repo_id,
    workspace_id: task.workspace_id,
    title: task.title,
    mode: "full",
    execution_mode: task.execution_mode || "worktree",
    worktree: task.worktree ? structuredClone(task.worktree) : undefined,
    metadata: task.metadata?.codex_execution_provider ? {
      codex_execution_provider: task.metadata.codex_execution_provider,
    } : {},
  });

  // Update queue: replace the current queue item's iteration
  if (tx.queue && typeof tx.queue.replaceIteration === "function") {
    await tx.queue.replaceIteration(task.id, retryTask.id);
  }
  if (tx.goals && typeof tx.goals.replaceTask === "function") {
    await tx.goals.replaceTask(task.goal_id, retryTask.id);
  }
  await tx.tasks.setState(task.id, "cancelled", {
    superseded_by_retry_task_id: retryTask.id,
    failure_class: failure.class || failure.failure_class || "unknown",
  });

  // Schedule retry with backoff
  const backoffDelay = policy.backoff_ms?.[nextAttempt - 1] || 0;
  if (tx.scheduler && typeof tx.scheduler.schedule === "function") {
    await tx.scheduler.schedule(retryTask.id, backoffDelay);
  }

  return { retry_task_id: retryTask.id };
}
