/**
 * review-backlog-reconciler.mjs — Review Backlog State Convergence Reconciler
 *
 * P0-MA5: Scans review backlog / acceptance bundles / review packets and
 * reconciles stale states (blockers, result_summary.status, missing_evidence)
 * against current evidence — successor repair, integration, terminal completion.
 *
 * This module is read-only: it never modifies task state. It produces typed
 * reconciliation results that can be consumed by the review-packet-builder
 * to show reconciled/terminal evidence in compact review packets.
 *
 * Reconciliation types:
 *   reconciled_by_successor        — stale blocker resolved by successor repair task
 *   reconciled_by_integration      — stale blocker resolved by integration (merged commit)
 *   reconciled_by_completion       — stale blocker resolved by terminal completion
 *   reconciled_diagnostic_no_mutation — stale changed_files_mismatch for diagnostic/no-mutation
 *                                      with code repair evidence
 *   reconciled_by_noop_evidence    — stale blockers resolved by noop evidence
 *   reconciled_status              — stale result_summary.status resolved
 *   still_blocking                 — true unresolved blocker (remains as-is)
 *   missing_contract_verification  — contract verification still missing
 *   missing_tests_evidence         — tests evidence still missing
 *   integration_recovery_required  — needs integration retry
 *   true_human_review_required     — truly needs human review
 *
 * @module review-backlog-reconciler
 */

import {
  TASK_STATUSES,
  isCompletedStatus,
  isFailedTerminalStatus,
  isTerminalStatus,
  normalizeTaskStatus,
  isHumanReviewStatus,
  isRepairStatus,
} from '../task-status-taxonomy.mjs';
import {
  REVIEW_STATES,
  isTypedReviewState,
  isMachineRepairableReviewState,
} from '../task-review-status-taxonomy.mjs';
import {
  isNonBlockingResultContractCode,
} from '../task-result-status.mjs';
import {
  hasImplicitSuccessor,
} from '../worker-queue-counts.mjs';
import { getTaskAcceptanceBundle } from './task-acceptance-bundle.mjs';

// ---------------------------------------------------------------------------
// Reconciliation type constants
// ---------------------------------------------------------------------------

export const RECONCILIATION_TYPES = Object.freeze({
  RECONCILED_BY_SUCCESSOR: 'reconciled_by_successor',
  RECONCILED_BY_INTEGRATION: 'reconciled_by_integration',
  RECONCILED_BY_COMPLETION: 'reconciled_by_completion',
  RECONCILED_DIAGNOSTIC_NO_MUTATION: 'reconciled_diagnostic_no_mutation',
  RECONCILED_BY_NOOP_EVIDENCE: 'reconciled_by_noop_evidence',
  RECONCILED_STATUS: 'reconciled_status',
  STILL_BLOCKING: 'still_blocking',
  MISSING_CONTRACT_VERIFICATION: 'missing_contract_verification',
  MISSING_TESTS_EVIDENCE: 'missing_tests_evidence',
  INTEGRATION_RECOVERY_REQUIRED: 'integration_recovery_required',
  TRUE_HUMAN_REVIEW_REQUIRED: 'true_human_review_required',
});

/** Map of stale blocker codes that the reconciler can resolve. */
const RECONCILABLE_BLOCKER_CODES = new Set([
  'changed_files_mismatch',
  'changed_files_missing',
  'changed_files_extra_in_git',
  'tests_missing',
  'commit_missing',
  'commit_or_patch_missing',
  'result_missing',
  'verification_missing',
  'contract_verification_missing',
  'existing_blocking_findings',
  'contract_invalid',
  'contract_requires_review',
  'no_mutation_evidence_missing',
  'integration_required_not_terminal',
  'report_missing',
]);

/** Non-mutation / diagnostic-like profiles that can have changed_files_mismatch as non-blocking. */
const DIAGNOSTIC_NO_MUTATION_PROFILES = new Set([
  'diagnostic',
  'noop',
  'readonly_validation',
  'already_integrated',
  'repair_noop',
  'network_retry',
  'verification_only',
  'sync_only',
  'github_sync_only',
]);

// ---------------------------------------------------------------------------
// Single-item reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile a single task's acceptance bundle against current evidence.
 *
 * @param {object} options
 * @param {object} options.store - StateStore instance
 * @param {object} [options.config] - Config object (passed through to bundle builder)
 * @param {string} options.task_id - Task ID to reconcile
 * @returns {Promise<object>} Reconciliation result
 */
export async function reconcileTask({ store, config = {}, task_id } = {}) {
  if (!store || !task_id) {
    return {
      task_id: task_id || null,
      status: 'error',
      error: 'store and task_id are required',
      reconciled: false,
    };
  }

  // Load task and its acceptance bundle
  const state = await store.load();
  const task = typeof store.findTaskById === 'function'
    ? await store.findTaskById(task_id)
    : state.tasks?.find((t) => t.id === task_id) || null;

  if (!task) {
    return { task_id, status: 'error', error: 'Task not found', reconciled: false };
  }

  let bundle;
  try {
    bundle = await getTaskAcceptanceBundle({ store, config, task_id });
  } catch (err) {
    return { task_id, status: 'error', error: `Bundle load failed: ${err.message}`, reconciled: false };
  }

  return reconcileBundle({ task, bundle, state, store });
}

/**
 * Core reconciliation logic: analyze a task and its acceptance bundle for
 * stale states, blockers, and evidence gaps.
 *
 * @param {object} options
 * @param {object} options.task - Raw task record
 * @param {object} options.bundle - Compact acceptance bundle
 * @param {object} [options.state] - Full state (tasks, goals) for cross-referencing
 * @param {object} [options.store] - Store for additional lookups
 * @returns {object} Reconciliation result
 */
export function reconcileBundle({ task, bundle, state, store } = {}) {
  if (!task || !bundle) {
    return { task_id: task?.id || bundle?.task_id || null, status: 'error', error: 'task and bundle are required', reconciled: false };
  }

  const findings = [];
  const staleBlockers = [];
  const reconciledBlockers = [];
  const stillBlocking = [];
  const evidence = {};

  // ---- Determine canonical task state ----
  const taskStatus = normalizeTaskStatus(task.status);
  const resultStatus = bundle.result_summary?.status || null;
  const isCompleted = taskStatus === TASK_STATUSES.COMPLETED || isCompletedStatus(taskStatus);
  const isTerminal = isCompleted || isFailedTerminalStatus(taskStatus) || isTerminalStatus(taskStatus);
  const isIntegrated = Boolean(
    bundle.integration?.merged === true ||
    bundle.integration?.commit
  );
  const hasSuccessor = Boolean(
    task.parent_task_id ||
    task.repair_of_task_id ||
    task.superseded_by_task_id
  );
  const isWaitingForReview = taskStatus === TASK_STATUSES.WAITING_FOR_REVIEW || bundle.status === TASK_STATUSES.WAITING_FOR_REVIEW;
  const isWaitingForRepair = taskStatus === TASK_STATUSES.WAITING_FOR_REPAIR || bundle.status === TASK_STATUSES.WAITING_FOR_REPAIR;

  // ---- Check 1: Stale result_summary.status ----
  // If the task is completed/integrated but the bundle still shows a stale status
  if (isTerminal && resultStatus && resultStatus !== taskStatus && resultStatus !== 'completed') {
    staleBlockers.push({
      code: 'stale_result_summary_status',
      message: `result_summary.status is "${resultStatus}" but task status is "${taskStatus}"`,
      current: resultStatus,
      expected: taskStatus,
    });

    // Determine reconciliation type
    if (isCompleted && isIntegrated) {
      findings.push({
        code: RECONCILIATION_TYPES.RECONCILED_STATUS,
        message: `result_summary.status reconciled from "${resultStatus}" to "${taskStatus}" based on task completion and integration evidence`,
        evidence: {
          task_status: taskStatus,
          integration_status: bundle.integration?.status || null,
          integration_merged: bundle.integration?.merged || false,
        },
        resolved_by: 'terminal_completion_and_integration',
      });
      evidence.stale_status_reconciled = true;
    } else if (isCompleted) {
      findings.push({
        code: RECONCILIATION_TYPES.RECONCILED_STATUS,
        message: `result_summary.status reconciled from "${resultStatus}" to "${taskStatus}" based on task completion evidence`,
        evidence: { task_status: taskStatus },
        resolved_by: 'terminal_completion',
      });
      evidence.stale_status_reconciled = true;
    }
  }

  // ---- Check 2: Stale blockers ----
  const blockers = bundle.blockers || [];
  for (const blocker of blockers) {
    const code = blocker.code || 'unknown';
    if (!RECONCILABLE_BLOCKER_CODES.has(code)) {
      // Non-reconcilable → still blocking
      stillBlocking.push({
        ...blocker,
        stale: false,
        reconciliation: null,
        reconciliation_evidence: null,
      });
      continue;
    }

    const reconcilable = evaluateBlockerReconciliation(code, blocker, {
      task, bundle, state, store,
      isCompleted, isTerminal, isIntegrated, hasSuccessor, isWaitingForReview, isWaitingForRepair,
    });

    if (reconcilable.reconciled) {
      reconciledBlockers.push({
        original_finding: { ...blocker },
        reconciliation: reconcilable.type,
        reconciliation_evidence: reconcilable.evidence,
        message: reconcilable.message,
      });
      findings.push({
        code: reconcilable.type,
        message: reconcilable.message,
        evidence: reconcilable.evidence,
        original_code: code,
        resolved_by: reconcilable.resolved_by,
      });
    } else {
      stillBlocking.push({
        ...blocker,
        stale: false,
        reconciliation: null,
        reconciliation_evidence: null,
        reason_unresolved: reconcilable.reason || 'Cannot auto-reconcile this blocker',
      });
    }
  }

  // ---- Check 3: Stale waiting_for_review / waiting_for_repair status ----
  if (isWaitingForReview && isCompleted) {
    // Task is completed on the top-level but bundle shows waiting_for_review
    if (stillBlocking.length === 0) {
      findings.push({
        code: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        message: `Task status "${taskStatus}" supersedes stale bundle status "${bundle.status}" — no unresolved blockers remain`,
        evidence: { task_status: taskStatus, bundle_status: bundle.status },
        resolved_by: 'completed_without_blockers',
      });
    }
  }

  if (isWaitingForRepair && isCompleted) {
    const hasSuccessorEvidence = hasSuccessor && evaluateSuccessorRepairEvidence(task, state);
    if (hasSuccessorEvidence || isIntegrated) {
      findings.push({
        code: RECONCILIATION_TYPES.RECONCILED_BY_SUCCESSOR,
        message: `Task status "${taskStatus}" with successor repair evidence resolves stale "${bundle.status}" bundle status`,
        evidence: {
          task_status: taskStatus,
          bundle_status: bundle.status,
          successor_evidence: hasSuccessorEvidence,
          integration_evidence: isIntegrated,
        },
        resolved_by: hasSuccessorEvidence ? 'successor_repair' : 'integration',
      });
    }
  }

  // ---- Check 4: Missing evidence reconciliation ----
  const missingEvidence = bundle.missing_evidence || [];
  for (const item of missingEvidence) {
    const code = item.code || 'unknown';

    if (code === 'contract_verification_missing' && isTerminal) {
      // Contract verification may be missing but reconciled if integrated/completed
      if (isIntegrated) {
        findings.push({
          code: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
          message: 'Missing contract_verification reconciled by integration evidence',
          evidence: {
            integration: bundle.integration,
            task_status: taskStatus,
          },
          resolved_by: 'integration_evidence',
          original_code: code,
        });
      } else if (isCompleted && stillBlocking.length === 0) {
        findings.push({
          code: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
          message: 'Missing contract_verification reconciled by terminal completion with no blockers',
          evidence: { task_status: taskStatus },
          resolved_by: 'terminal_completion',
          original_code: code,
        });
      } else if (!isCompleted) {
        // Task truly not complete — report as typed recovery reason
        findings.push({
          code: RECONCILIATION_TYPES.MISSING_CONTRACT_VERIFICATION,
          message: 'Contract verification evidence is genuinely missing — not reconciled',
          evidence: { task_status: taskStatus, pending_evidence: true },
          resolved_by: null,
          original_code: code,
        });
      }
    }
  }

  // ---- Check 5: Check for successor tasks that change the picture ----
  const successorInfo = findSuccessorTasks(task, state);
  if (successorInfo.successor_tasks.length > 0) {
    evidence.successor_tasks = successorInfo.successor_tasks;
  }

  // ---- Build summary ----
  const isReconciled = stillBlocking.length === 0;
  const reconciledCount = findings.filter(f =>
    f.code.startsWith('reconciled')
  ).length;

  return {
    task_id: task.id,
    status: isReconciled ? RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION : RECONCILIATION_TYPES.STILL_BLOCKING,
    reconciled: isReconciled,
    reconciled_count: reconciledCount,
    still_blocking_count: stillBlocking.length,
    bundle_status: bundle.status,
    bundle_result_summary_status: bundle.result_summary?.status || null,
    task_status: taskStatus,
    is_integrated: isIntegrated,
    has_successor: hasSuccessor,
    stale_blockers: staleBlockers,
    reconciled_blockers: reconciledBlockers,
    still_blocking: stillBlocking,
    reconciled_findings: findings,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Full backlog reconciliation
// ---------------------------------------------------------------------------

/**
 * Scan the full store and reconcile all tasks in review backlog / review states.
 *
 * @param {object} options
 * @param {object} options.store - StateStore instance
 * @param {object} [options.config] - Config object
 * @param {string} [options.task_id] - Optional single task ID to reconcile
 * @returns {Promise<object>} Structured reconciliation summary
 */
export async function reconcileReviewBacklog({ store, config = {}, task_id } = {}) {
  if (!store) throw new Error('store is required');

  const state = await store.load();
  const tasks = state.tasks || [];

  // Determine which tasks to reconcile
  let targetTasks = tasks;
  if (task_id) {
    const task = tasks.find(t => t.id === task_id);
    if (!task) {
      return {
        scanned_at: new Date().toISOString(),
        error: `Task ${task_id} not found`,
        total_scanned: 0,
        reconciled_count: 0,
        still_blocked_count: 0,
        human_review_count: 0,
        typed_recovery_counts: {},
        tasks: [],
      };
    }
    targetTasks = [task];
  }

  const reviewStates = new Set([
    TASK_STATUSES.WAITING_FOR_REVIEW,
    TASK_STATUSES.WAITING_FOR_REPAIR,
    TASK_STATUSES.WAITING_FOR_INTEGRATION,
    ...Object.values(REVIEW_STATES),
  ]);
  for (const s of Object.values(TASK_STATUSES)) {
    if (isFailedTerminalStatus(s)) reviewStates.add(s);
  }
  // Also include completed tasks that may have stale bundles
  reviewStates.add(TASK_STATUSES.COMPLETED);

  const results = [];
  const reconciledTasks = [];
  const stillBlockedTasks = [];
  const humanReviewTasks = [];
  const typedRecoveryCounts = {};

  for (const task of targetTasks) {
    if (task.assignee && task.assignee !== 'codex') continue;
    const ns = normalizeTaskStatus(task.status);
    if (!reviewStates.has(ns)) continue;

    let bundle;
    try {
      bundle = await getTaskAcceptanceBundle({ store, config, task_id: task.id });
    } catch {
      // Skip tasks that can't produce a bundle
      continue;
    }

    const result = reconcileBundle({ task, bundle, state, store });
    results.push(result);

    // Count reconciliation outcomes
    if (result.reconciled) {
      reconciledTasks.push(result);
    } else if (result.still_blocking.some(b => b.severity === 'blocker')) {
      stillBlockedTasks.push(result);
    }

    // Count typed recovery reasons
    for (const finding of (result.reconciled_findings || [])) {
      typedRecoveryCounts[finding.code] = (typedRecoveryCounts[finding.code] || 0) + 1;
    }

    // Count human review
    if (result.reconciled_findings.some(f => f.code === RECONCILIATION_TYPES.TRUE_HUMAN_REVIEW_REQUIRED)) {
      humanReviewTasks.push(result);
    }
  }

  return {
    scanned_at: new Date().toISOString(),
    total_scanned: results.length,
    reconciled_count: reconciledTasks.length,
    still_blocked_count: stillBlockedTasks.length,
    human_review_count: humanReviewTasks.length,
    typed_recovery_counts: typedRecoveryCounts,
    tasks: results,
  };
}

// ---------------------------------------------------------------------------
// Blocker reconciliation evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a specific blocker code can be reconciled given current evidence.
 *
 * @param {string} code - Blocker code (e.g., 'changed_files_mismatch')
 * @param {object} blocker - Original blocker object
 * @param {object} context - Evaluation context (task, bundle, state, etc.)
 * @returns {{ reconciled: boolean, type: string|null, evidence: object|null, message: string|null, reason: string|null, resolved_by: string|null }}
 */
function evaluateBlockerReconciliation(code, blocker, context) {
  const {
    task, bundle, state,
    isCompleted, isTerminal, isIntegrated, hasSuccessor,
  } = context;

  // ---- changed_files_mismatch ----
  if (code === 'changed_files_mismatch') {
    // Case 1: Integrated → reconciled by integration
    if (isIntegrated && isCompleted) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: {
          integration_status: bundle.integration?.status,
          integration_merged: bundle.integration?.merged,
          integration_commit: bundle.integration?.commit,
          task_status: task.status,
          reason: 'Post-integration changed_files mismatch is expected — commit diff may differ from worktree diff',
        },
        message: `changed_files_mismatch reconciled by integration evidence (merged=${bundle.integration?.merged}, commit=${bundle.integration?.commit})`,
      };
    }

    // Case 2: Completed + successor repair evidence → reconciled by successor
    if (isCompleted && hasSuccessor) {
      const successorResolved = evaluateSuccessorRepairEvidence(task, state);
      if (successorResolved) {
        return {
          reconciled: true,
          type: RECONCILIATION_TYPES.RECONCILED_BY_SUCCESSOR,
          resolved_by: 'successor_repair',
          evidence: {
            task_status: task.status,
            successor_ids: task.parent_task_id || task.repair_of_task_id || task.superseded_by_task_id,
            reason: 'Successor repair task completed/integrated, resolving stale changed_files_mismatch',
          },
          message: `changed_files_mismatch reconciled by successor repair task`,
        };
      }
    }

    // Case 3: Completed + no blockers → reconciled by completion
    if (isCompleted) {
      // Check if noop/diagnostic profile allows non-blocking changed_files_mismatch
      const profile = bundle.acceptance_contract_summary?.operation_kind || 
        task.result?.operation_kind || '';
      if (DIAGNOSTIC_NO_MUTATION_PROFILES.has(profile)) {
        return {
          reconciled: true,
          type: RECONCILIATION_TYPES.RECONCILED_DIAGNOSTIC_NO_MUTATION,
          resolved_by: 'diagnostic_no_mutation_profile',
          evidence: {
            profile,
            task_status: task.status,
            reason: 'changed_files_mismatch is non-blocking for diagnostic/no-mutation profiles',
          },
          message: `changed_files_mismatch is non-blocking for profile="${profile}"`,
        };
      }
    }

    // Not reconcilable — still blocking
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'Task is not completed, integrated, or has no successor repair evidence',
      resolved_by: null,
    };
  }

  // ---- tests_missing ----
  if (code === 'tests_missing') {
    if (isCompleted && isIntegrated) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: {
          integration: bundle.integration,
          task_status: task.status,
          reason: 'post-integration tests_missing is non-blocking',
        },
        message: 'tests_missing reconciled by integration evidence',
      };
    }
    if (bundle.verification?.passed === true) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        resolved_by: 'verification_passed',
        evidence: {
          verification_passed: true,
          verification_commands: bundle.verification?.commands?.length || 0,
        },
        message: 'tests_missing reconciled by verification passed evidence',
      };
    }
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'No verification or integration evidence to reconcile tests_missing',
      resolved_by: null,
    };
  }

  // ---- contract_verification_missing ----
  if (code === 'contract_verification_missing') {
    if (isIntegrated && isCompleted) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: {
          integration: bundle.integration,
          task_status: task.status,
        },
        message: 'contract_verification_missing reconciled by integration evidence',
      };
    }
    return {
      reconciled: false,
      type: RECONCILIATION_TYPES.MISSING_CONTRACT_VERIFICATION,
      evidence: { task_status: task.status },
      message: null,
      reason: 'Contract verification genuinely missing — no integration or completion evidence to reconcile',
      resolved_by: null,
    };
  }

  // ---- commit_missing / commit_or_patch_missing ----
  if (code === 'commit_missing' || code === 'commit_or_patch_missing') {
    if (isIntegrated) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: {
          integration: bundle.integration,
          task_status: task.status,
        },
        message: `${code} reconciled by integration evidence`,
      };
    }
    if (bundle.result_summary?.commit) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        resolved_by: 'commit_evidence_in_result',
        evidence: {
          commit: bundle.result_summary.commit,
          remote_head: bundle.result_summary.remote_head,
        },
        message: `${code} reconciled by commit evidence in result summary`,
      };
    }
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'No commit or integration evidence to reconcile',
      resolved_by: null,
    };
  }

  // ---- no_mutation_evidence_missing ----
  if (code === 'no_mutation_evidence_missing') {
    if (isCompleted && bundle.verification?.passed === true) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        resolved_by: 'verification_passed',
        evidence: { verification_passed: true, task_status: task.status },
        message: 'no_mutation_evidence_missing reconciled by verification passed',
      };
    }
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'Verification not passed — no_mutation evidence genuinely missing',
      resolved_by: null,
    };
  }

  // ---- integration_required_not_terminal ----
  if (code === 'integration_required_not_terminal') {
    if (isIntegrated) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: { integration: bundle.integration },
        message: 'integration_required_not_terminal reconciled by integration evidence',
      };
    }
    return {
      reconciled: false,
      type: RECONCILIATION_TYPES.INTEGRATION_RECOVERY_REQUIRED,
      evidence: { task_status: task.status },
      message: null,
      reason: 'Integration still pending — not reconciled',
      resolved_by: null,
    };
  }

  // ---- verification_missing ----
  if (code === 'verification_missing') {
    if (bundle.verification?.passed === true) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        resolved_by: 'verification_passed',
        evidence: { verification_passed: true },
        message: 'verification_missing reconciled by verification passed evidence',
      };
    }
    if (isIntegrated) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
        resolved_by: 'integration',
        evidence: { integration: bundle.integration },
        message: 'verification_missing reconciled by integration evidence',
      };
    }
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'Verification still missing — not reconciled',
      resolved_by: null,
    };
  }

  // ---- result_missing ----
  if (code === 'result_missing') {
    if (bundle.result_summary?.status) {
      return {
        reconciled: true,
        type: RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION,
        resolved_by: 'result_exists',
        evidence: { result_summary_status: bundle.result_summary.status },
        message: 'result_missing reconciled by result summary evidence',
      };
    }
    return {
      reconciled: false,
      type: null,
      evidence: null,
      message: null,
      reason: 'Result still genuinely missing',
      resolved_by: null,
    };
  }

  // ---- Generic catch-all for other reconcilable codes ----
  if (isCompleted && isIntegrated) {
    return {
      reconciled: true,
      type: RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION,
      resolved_by: 'integration',
      evidence: {
        integration: bundle.integration,
        task_status: task.status,
        note: `Code ${code} reconciled generically by integration evidence`,
      },
      message: `${code} reconciled by integration evidence`,
    };
  }

  return {
    reconciled: false,
    type: null,
    evidence: null,
    message: null,
    reason: `Cannot auto-reconcile ${code} — no matching reconciliation rule`,
    resolved_by: null,
  };
}

// ---------------------------------------------------------------------------
// Successor evidence helpers
// ---------------------------------------------------------------------------

/**
 * Find successor tasks linked to the given task.
 * Successors include tasks that reference this task via parent/repair/superseded relationships.
 *
 * @param {object} task - Task record
 * @param {object} state - Full state with all tasks
 * @returns {{ successor_ids: string[], successor_tasks: object[] }}
 */
function findSuccessorTasks(task, state) {
  const tasks = state?.tasks || [];
  const taskId = task.id;

  // Find tasks that reference this task
  const successors = tasks.filter(t =>
    t.parent_task_id === taskId ||
    t.repair_of_task_id === taskId ||
    t.supersedes_task_id === taskId
  );

  return {
    successor_ids: successors.map(t => t.id),
    successor_tasks: successors.map(t => ({
      id: t.id,
      status: t.status,
      result_status: t.result?.status || null,
      integrated: t.result?.integration?.merged === true || t.result?.integration?.status === 'merged',
      has_commit: Boolean(t.result?.commit),
    })),
  };
}

/**
 * Evaluate whether a task's successor repair provides evidence that resolves
 * stale blockers on this task.
 *
 * @param {object} task - Original task with stale state
 * @param {object} state - Full state with all tasks
 * @returns {boolean} Whether successor repair evidence exists
 */
function evaluateSuccessorRepairEvidence(task, state) {
  const successors = findSuccessorTasks(task, state);

  // A successor resolves the original task's stale state if:
  // - It completed successfully
  // - It has integration evidence
  // - It has a commit
  for (const succ of successors.successor_tasks) {
    const status = normalizeTaskStatus(succ.status);
    if (status === TASK_STATUSES.COMPLETED && succ.integrated) {
      return true;
    }
    if (status === TASK_STATUSES.COMPLETED && succ.has_commit) {
      return true;
    }
  }

  return false;
}
