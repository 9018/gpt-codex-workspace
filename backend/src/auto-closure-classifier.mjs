/**
 * auto-closure-classifier.mjs — Auto-closure classification for Codex task results.
 *
 * P0: Central decision module for task auto-closure.
 *
 * Responsibilities:
 * 1. Classify completed task results into types: code_change, sync (no changes),
 *    noop, verification-only.
 * 2. Determine the correct closure path: complete, integrate, retry, repair, review.
 * 3. Route network failures (rate_limited, gateway_error, transient_network_error)
 *    to retry/wait instead of the code repair loop.
 * 4. Provide human-readable closure summaries for result.md.
 *
 * This module is the single source of truth for what happens after a task
 * finishes execution. It replaces ad-hoc type detection scattered across
 * acceptance-agent, task-acceptance, and task-final-writeback.
 *
 * Since P0-MA2: consumes normalized evidence fields (operation_kind, noop_result,
 * readonly_result, already_integrated_result, tests_derived_from_verification)
 * from the evidence normalizer. Falls back to raw field detection when normalized
 * evidence is not present.
 */

import { classifyFailure, failureClassRequiresRepair, failureClassIsTerminalNonRepairable } from './failure-classifier.mjs';

// ---------------------------------------------------------------------------
// Task type constants
// ---------------------------------------------------------------------------

export const TASK_TYPES = {
  /** Code or config changes that require integration */
  CODE_CHANGE: 'code_change',
  /** Pure sync task with no changes (poll, status check) */
  SYNC: 'sync',
  /** Explicitly flagged no-op task */
  NOOP: 'noop',
  /** Verification-only task (test run, lint, typecheck) */
  VERIFICATION: 'verification',
};

// ---------------------------------------------------------------------------
// Closure path constants
// ---------------------------------------------------------------------------

export const CLOSURE_PATHS = {
  /** Terminal: task completed successfully, no further action needed */
  COMPLETE: 'complete',
  /** Task has code changes, needs integration queue */
  INTEGRATE: 'integrate',
  /** Network/transient failure, needs retry with backoff */
  RETRY: 'retry',
  /** Repairable failure, enter repair loop */
  REPAIR: 'repair',
  /** Needs human review (exceeded retry budget, contract violation) */
  REVIEW: 'review',
};

// ---------------------------------------------------------------------------
// Helper: detect noop-like operations from normalized evidence
// ---------------------------------------------------------------------------

const NOOP_LIKE_KINDS = new Set(['noop', 'readonly_validation', 'already_integrated', 'diagnostic', 'sync']);

/**
 * Check if a result represents a noop-like operation.
 * Uses normalized evidence fields when available, falls back to raw fields.
 *
 * @param {object} taskResult
 * @returns {boolean}
 */
function isNoopLikeResult(taskResult) {
  if (!taskResult || typeof taskResult !== 'object') return false;

  // Normalized evidence fields (from evidence-normalizer)
  if (taskResult.noop_result === true) return true;
  if (taskResult.readonly_result === true) return true;
  if (taskResult.already_integrated_result === true) return true;
  if (taskResult.integration_not_required === true) return true;

  // Fallback: operation_kind based detection
  if (NOOP_LIKE_KINDS.has(taskResult.operation_kind)) return true;

  // Raw field detection (legacy)
  if (taskResult.noop === true || taskResult.kind === 'noop') return true;
  if (taskResult.operation_kind === 'readonly_validation' || taskResult.operation_kind === 'already_integrated') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Helper: detect tests evidence from normalized or raw fields
// ---------------------------------------------------------------------------

/**
 * Check if result has tests evidence.
 * Uses normalized tests field (which may be derived from verification.commands).
 *
 * @param {object} taskResult
 * @returns {boolean}
 */
function hasTestsEvidence(taskResult) {
  if (!taskResult || typeof taskResult !== 'object') return false;

  // Normalized: tests was derived from verification.commands
  if (taskResult.tests_derived_from_verification === true && taskResult.tests) return true;

  // Raw tests field
  if (taskResult.tests && taskResult.tests !== 'none' && taskResult.tests !== 'null') return true;

  // Check verification.commands as test evidence
  const verification = taskResult.verification || {};
  if (Array.isArray(verification.commands) && verification.commands.length > 0) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Task type classification
// ---------------------------------------------------------------------------

/**
 * Classify a completed task result into a task type.
 *
 * @param {object} taskResult - Task result object (from result.json)
 * @param {object} [task] - Optional task object for additional context
 * @returns {{ type: string, typeLabel: string }}
 */
export function classifyTaskType(taskResult, task) {
  if (!taskResult || typeof taskResult !== 'object') {
    return { type: TASK_TYPES.SYNC, typeLabel: 'sync' };
  }

  // 1. Explicit noop-like operations (readonly_validation, already_integrated, noop, diagnostic)
  if (isNoopLikeResult(taskResult)) {
    return { type: TASK_TYPES.NOOP, typeLabel: taskResult.operation_kind ? taskResult.operation_kind.replace(/_/g, ' ') : 'no-op' };
  }

  // 2. Check for verification-only: no changed files but has test/verification evidence
  const changedFiles = Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [];
  const hasTests = hasTestsEvidence(taskResult);
  if (changedFiles.length === 0 && hasTests) {
    return { type: TASK_TYPES.VERIFICATION, typeLabel: 'verification' };
  }

  // 3. No changed files → sync/status task (no test evidence)
  if (changedFiles.length === 0) {
    return { type: TASK_TYPES.SYNC, typeLabel: 'sync' };
  }

  // 4. Has changed files → code change
  return { type: TASK_TYPES.CODE_CHANGE, typeLabel: 'code change' };
}

// ---------------------------------------------------------------------------
// Failure-based closure path determination
// ---------------------------------------------------------------------------

/**
 * Determine the correct closure path for a task result.
 *
 * Decision order:
 * 1. Network failures (rate_limited, gateway_error, transient_network_error)
 *    → RETRY (not code repair)
 * 2. Repairable failures (test_failed, missing_result_json, etc.)
 *    → REPAIR (auto-repair loop)
 * 3. Terminal non-repairable failures (stale_running_task, task_failed, unknown)
 *    → REVIEW (needs human review)
 * 4. Noop-like result → COMPLETE (no integration needed)
 * 5. Code change with success → INTEGRATE
 * 6. Sync/noop/verification with success → COMPLETE
 *
 * @param {object} taskResult - Task result object
 * @param {object} [task] - Optional task object for additional context (retry count, mode)
 * @returns {{
 *   path: string,
 *   status: string,
 *   skipRepair: boolean,
 *   needsBackoff: boolean,
 *   needsIntegration: boolean,
 *   needsRestartCheck: boolean,
 *   reason: string,
 *   taskType: { type: string, typeLabel: string },
 * }}
 */
export function determineClosurePath(taskResult, task) {
  const taskType = classifyTaskType(taskResult, task);
  const failureClass = taskResult.failure_class || classifyFailure({
    resultJson: taskResult,
    result: taskResult,
    message: taskResult.summary || '',
  });

  // ====================================================================
  // 1. Network/terminal failures → retry/wait (not code repair)
  // ====================================================================
  if (failureClassIsTerminalNonRepairable(failureClass)) {
    return {
      path: CLOSURE_PATHS.RETRY,
      status: 'queued',
      skipRepair: true,
      needsBackoff: true,
      needsIntegration: false,
      needsRestartCheck: false,
      reason: `Network/terminal failure (${failureClass}). Will retry.`,
      taskType,
      failureClass,
    };
  }

  // ====================================================================
  // 2. Repairable failures → repair loop
  // ====================================================================
  if (failureClassRequiresRepair(failureClass)) {
    return {
      path: CLOSURE_PATHS.REPAIR,
      status: 'waiting_for_repair',
      skipRepair: false,
      needsBackoff: false,
      needsIntegration: false,
      needsRestartCheck: false,
      reason: `Repairable failure (${failureClass}). Auto-repair queued.`,
      taskType,
      failureClass,
    };
  }

  // ====================================================================
  // 3. Unclassified failures → review
  // ====================================================================
  if (failureClass && failureClass !== 'unknown') {
    return {
      path: CLOSURE_PATHS.REVIEW,
      status: 'waiting_for_review',
      skipRepair: true,
      needsBackoff: false,
      needsIntegration: false,
      needsRestartCheck: false,
      reason: `Unhandled failure (${failureClass}). Requires review.`,
      taskType,
      failureClass,
    };
  }

  // ====================================================================
  // 4. Success paths
  // ====================================================================

  // 4a. Noop-like operations → complete without integration
  if (isNoopLikeResult(taskResult)) {
    if (failureClass && failureClass !== 'unknown') {
      return {
        path: CLOSURE_PATHS.REVIEW,
        status: 'waiting_for_review',
        skipRepair: true,
        needsBackoff: false,
        needsIntegration: false,
        needsRestartCheck: false,
        reason: `Unhandled failure (${failureClass}) in noop-like result. Requires review.`,
        taskType,
        failureClass,
      };
    }
    return {
      path: CLOSURE_PATHS.COMPLETE,
      status: taskResult.status === 'failed' ? 'failed' : 'completed',
      skipRepair: true,
      needsBackoff: false,
      needsIntegration: false,
      needsRestartCheck: false,
      reason: `Task completed (${taskType.typeLabel}). No changes to integrate.`,
      taskType,
      failureClass: null,
    };
  }

  // 4b. Code change → needs integration
  if (taskType.type === TASK_TYPES.CODE_CHANGE) {
    const fileCount = Array.isArray(taskResult.changed_files) ? taskResult.changed_files.length : 0;
    return {
      path: CLOSURE_PATHS.INTEGRATE,
      status: taskResult.verification?.passed === false ? 'waiting_for_review' : 'waiting_for_integration',
      skipRepair: true,
      needsBackoff: false,
      needsIntegration: true,
      needsRestartCheck: true,
      reason: `Code change task (${fileCount} file${fileCount !== 1 ? 's' : ''}). Needs integration.`,
      taskType,
      failureClass: null,
    };
  }

  // 4c. Pure sync / noop / verification → complete directly
  return {
    path: CLOSURE_PATHS.COMPLETE,
    status: 'completed',
    skipRepair: true,
    needsBackoff: false,
    needsIntegration: false,
    needsRestartCheck: taskType.type === TASK_TYPES.VERIFICATION,
    reason: `Task completed (${taskType.typeLabel}). No integration needed.`,
    taskType,
    failureClass: null,
  };
}

// ---------------------------------------------------------------------------
// Notification consistency check
// ---------------------------------------------------------------------------

/**
 * Check whether task, GitHub, and Bark notification states are consistent.
 *
 * @param {object} task - Task object with its result and log
 * @param {object} [githubResult] - Result from github.syncTask()
 * @returns {{ consistent: boolean, channels: { bark: { notified: boolean, ok: boolean|undefined }, github: { synced: boolean, ok: boolean|undefined } }, findings: Array }}
 */
export function checkNotificationConsistency(task, githubResult) {
  const findings = [];
  const notifications = Array.isArray(task.notifications) ? task.notifications : [];

  // Check Bark notification
  const barkNotification = notifications.find(n => n.channel === 'bark');
  const barkOk = barkNotification ? barkNotification.ok === true : undefined;
  const barkNotified = barkNotification != null;

  if (!barkNotified && ['completed', 'failed'].includes(task.status)) {
    findings.push({
      severity: 'minor',
      code: 'bark_notification_missing',
      message: `No Bark notification found for terminal state ${task.status}`,
      source: 'auto_closure',
    });
  }

  // Check GitHub sync
  const githubOk = githubResult ? githubResult.ok === true : undefined;
  const githubSynced = githubResult != null;

  if (!githubSynced && task.status === 'completed') {
    findings.push({
      severity: 'minor',
      code: 'github_sync_missing',
      message: 'No GitHub sync result for completed task',
      source: 'auto_closure',
    });
  }

  // Cross-channel consistency: if both are present, both should be ok
  if (barkOk === false && githubOk === false) {
    findings.push({
      severity: 'major',
      code: 'notification_channels_both_failed',
      message: 'Both Bark and GitHub notification/sync failed',
      source: 'auto_closure',
    });
  }

  return {
    consistent: findings.length === 0,
    channels: {
      bark: { notified: barkNotified, ok: barkOk },
      github: { synced: githubSynced, ok: githubOk },
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// Full closure classification
// ---------------------------------------------------------------------------

/**
 * Full auto-closure classification for a completed task.
 * Combines task type detection, closure path, and notification consistency.
 *
 * @param {object} taskResult - Parsed result object
 * @param {object} task - Task object
 * @param {object} [githubResult] - Optional GitHub sync result
 * @returns {{
 *   taskType: { type: string, typeLabel: string },
 *   closurePath: object,
 *   consistency: object,
 *   needsRestartCheck: boolean,
 *   needsIntegration: boolean,
 *   requiresReview: boolean,
 *   requiresRepair: boolean,
 *   requiresRetry: boolean,
 *   summary: string,
 * }}
 */
export function classifyClosure(taskResult, task, githubResult) {
  const taskType = classifyTaskType(taskResult, task);
  const closurePath = determineClosurePath(taskResult, task);
  const consistency = checkNotificationConsistency(task, githubResult);

  const summary = [
    `Task type: ${taskType.typeLabel}`,
    `Closure path: ${closurePath.path}`,
    closurePath.reason,
    `Notifications: Bark=${consistency.channels.bark.ok ? 'ok' : consistency.channels.bark.notified ? 'sent' : 'none'}, GitHub=${consistency.channels.github.ok ? 'ok' : consistency.channels.github.synced ? 'synced' : 'none'}`,
    closurePath.needsRestartCheck ? 'Restart check: required' : 'Restart check: not required',
  ].join(' | ');

  return {
    taskType,
    closurePath,
    consistency,
    needsRestartCheck: closurePath.needsRestartCheck,
    needsIntegration: closurePath.needsIntegration,
    requiresReview: closurePath.path === CLOSURE_PATHS.REVIEW,
    requiresRepair: closurePath.path === CLOSURE_PATHS.REPAIR,
    requiresRetry: closurePath.path === CLOSURE_PATHS.RETRY,
    summary,
  };
}
