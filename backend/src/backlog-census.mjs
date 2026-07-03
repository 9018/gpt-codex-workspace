/**
 * backlog-census.mjs — Typed Backlog Census and Status Migration Baseline
 *
 * P0-MA1: Scans the current state store for blocked backlog tasks and classifies them
 * into typed categories for machine-executable migration planning.
 *
 * Blocker classifications:
 * - true_human_review:    Requires human judgment (semantic ambiguity, product decisions)
 * - missing_evidence_repair:  Missing result evidence, can be auto-repaired
 * - result_contract_repair:   Invalid result contract or acceptance failure
 * - integration_recovery:     Integration failure, can be auto-retried
 * - noop_evidence:        No-mutation change needs evidence that no functional changes were made
 * - repair_budget_exhausted:  Repair budget exhausted, human must decide next action
 * - resolved_legacy:      Already resolved by successor/noop/legacy reconciliation
 * - unrecoverable_failed:     Failed terminal with no recovery path
 *
 * This module is a dry-run/census module — it never modifies task state.
 */

import {
  TASK_STATUSES,
  isFailedTerminalStatus,
  isTerminalStatus,
  normalizeTaskStatus,
} from './task-status-taxonomy.mjs';
import {
  REVIEW_STATES,
  TYPED_REVIEW_STATES,
  classifyReviewState,
  isTypedReviewState,
} from './task-review-status-taxonomy.mjs';
import {
  classifyCurrentBlockerTask,
  CURRENT_WORK_DECISION_LABELS,
} from './current-blocker-policy.mjs';
import {
  buildTaskQueueIndexes,
  hasImplicitSuccessor,
} from './worker-queue-counts.mjs';
import {
  isResolvedLegacyReviewTask,
  isResolvedLegacyTerminalTask,
} from './legacy-reconciliation.mjs';
import {
  classifyResultShape,
  RESULT_SHAPE_TYPES,
} from './result-shape-classifier.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 8 typed blocker classifications from the P0-MA1 spec. */
export const BLOCKER_CLASSIFICATIONS = Object.freeze({
  TRUE_HUMAN_REVIEW: 'true_human_review',
  MISSING_EVIDENCE_REPAIR: 'missing_evidence_repair',
  RESULT_CONTRACT_REPAIR: 'result_contract_repair',
  INTEGRATION_RECOVERY: 'integration_recovery',
  NOOP_EVIDENCE: 'noop_evidence',
  REPAIR_BUDGET_EXHAUSTED: 'repair_budget_exhausted',
  RESOLVED_LEGACY: 'resolved_legacy',
  UNRECOVERABLE_FAILED: 'unrecoverable_failed',
});

/** Broader backlog categories for grouping blockers. */
export const BACKLOG_CATEGORIES = Object.freeze({
  WAITING_FOR_REVIEW: 'waiting_for_review',
  WAITING_FOR_REPAIR: 'waiting_for_repair',
  WAITING_FOR_INTEGRATION: 'waiting_for_integration',
  FAILED: 'failed',
  TYPED_REVIEW: 'typed_review',
});

/** Migration action candidates for legacy waiting_for_review tasks. */
export const LEGACY_MIGRATION_ACTIONS = Object.freeze({
  AUTO_MIGRATE_TO_TYPED: 'auto_migrate_to_typed',
  AUTO_ACCEPT: 'auto_accept',
  TRUE_HUMAN_REVIEW_REQUIRED: 'true_human_review_required',
});

// ---------------------------------------------------------------------------
// Backlog category helpers
// ---------------------------------------------------------------------------

/**
 * Map a task status to its broader backlog category.
 * @param {string} status
 * @returns {string|null}
 */
export function backlogCategoryForStatus(status) {
  const s = normalizeTaskStatus(status);
  if (s === TASK_STATUSES.WAITING_FOR_REVIEW) return BACKLOG_CATEGORIES.WAITING_FOR_REVIEW;
  if (s === TASK_STATUSES.WAITING_FOR_REPAIR) return BACKLOG_CATEGORIES.WAITING_FOR_REPAIR;
  if (s === TASK_STATUSES.WAITING_FOR_INTEGRATION) return BACKLOG_CATEGORIES.WAITING_FOR_INTEGRATION;
  if (isFailedTerminalStatus(s)) return BACKLOG_CATEGORIES.FAILED;
  if (isTypedReviewState(s)) return BACKLOG_CATEGORIES.TYPED_REVIEW;
  return null;
}

// ---------------------------------------------------------------------------
// Legacy waiting_for_review migration analysis
// ---------------------------------------------------------------------------

/**
 * Analyse a legacy waiting_for_review task to determine whether it can
 * auto-migrate to a typed state, auto-accept, or requires true human review.
 *
 * @param {object} task - Task record with result, blockers, etc.
 * @returns {{
 *   migration_action: string,
 *   target_review_state: string|null,
 *   reason: string,
 *   evidence: object,
 * }}
 */
export function classifyLegacyWaitingForReviewMigration(task) {
  if (!task || normalizeTaskStatus(task.status) !== TASK_STATUSES.WAITING_FOR_REVIEW) {
    return {
      migration_action: LEGACY_MIGRATION_ACTIONS.TRUE_HUMAN_REVIEW_REQUIRED,
    target_review_state: null,
      reason: 'Task is not in waiting_for_review state',
      evidence: { actual_status: task?.status },
    };
  }

  // 1. Already resolved by upstream — auto-accept
  if (isResolvedLegacyReviewTask(task)) {
    return {
    migration_action: LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT,
    target_review_state: null,
      reason: 'Legacy review task has been resolved by a successor or explicit resolution marker',
      evidence: {
        resolved_by_task_id: task.result?.resolved_by_task_id || task.resolved_by_task_id,
        superseded_by_task_id: task.result?.superseded_by_task_id || task.superseded_by_task_id,
        noop: task.result?.noop,
        resolved_legacy: task.result?.resolved_legacy,
      },
    };
  }

  // 1a. Explicit noop/resolved_legacy markers — auto-accept
  if (task.result?.noop === true || task.result?.resolved_legacy === true) {
    return {
      migration_action: LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT,
      target_review_state: null,
      reason: 'Legacy review task has noop/resolved_legacy marker and can be auto-accepted',
      evidence: { noop: task.result.noop, resolved_legacy: task.result.resolved_legacy },
    };
  }
  
  // 2. Try to classify using the existing review state classifier
  const reason = task.result?.reason || '';
  const blockers = task.result?.blockers || task.blockers || [];
  const repairBudgetExhausted = task.result?.repair_budget_exhausted === true ||
    task.metadata?.repair_attempts >= (task.metadata?.max_repairs || 3);

  const reviewClassification = classifyReviewState({
    reason,
    blockers,
    repairBudgetExhausted,
  });

  const reviewState = reviewClassification.reviewState;

  // 3. Machine-repairable — auto-migrate to typed state
  if (reviewClassification.metadata?.machine_repairable) {
    return {
      migration_action: LEGACY_MIGRATION_ACTIONS.AUTO_MIGRATE_TO_TYPED,
      target_review_state: reviewState,
      reason: `Legacy review task can be auto-migrated to typed state ${reviewState}`,
      evidence: {
        reason,
        blocker_codes: blockers.map(b => b?.code).filter(Boolean),
        review_state: reviewState,
        machine_repairable: true,
      },
    };
  }

  // 4. Non-machine-repairable typed state -> map to true human review
  //    But also check if the task has completion evidence -> could be auto-accepted
  const resultShape = classifyResultShape(task.result);
  if (resultShape === RESULT_SHAPE_TYPES.COMPLETION_EVIDENCE) {
    return {
    migration_action: LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT,
    target_review_state: null,
      reason: 'Legacy review task has completion evidence and can be auto-accepted',
      evidence: { result_shape: resultShape, review_state: reviewState },
    };
  }

  // 5. Default: true human review required
  return {
    migration_action: LEGACY_MIGRATION_ACTIONS.TRUE_HUMAN_REVIEW_REQUIRED,
    target_review_state: reviewState,
    reason: 'Legacy review task classified as needing human review',
    evidence: {
      reason,
      blocker_codes: blockers.map(b => b?.code).filter(Boolean),
      review_state: reviewState,
      machine_repairable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Single-task blocker classification
// ---------------------------------------------------------------------------

/**
 * Classify a single task into one of the 8 typed blocker classifications.
 *
 * @param {object} task - Task record from state store
 * @param {object} [indexes] - Pre-built task queue indexes (from buildTaskQueueIndexes)
 * @returns {{
 *   classification: string,
 *   backlog_category: string|null,
 *   evidence: object,
 *   reason: string,
 *   recommended_next_action: string,
 * }}
 */
export function classifyBlocker(task, indexes) {
  if (!task) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.UNRECOVERABLE_FAILED,
      backlog_category: null,
      evidence: {},
      reason: 'Task record is null or undefined',
      recommended_next_action: 'manual_review',
    };
  }

  const resolvedIndexes = indexes && typeof indexes === 'object' && !Array.isArray(indexes)
    ? indexes
    : buildTaskQueueIndexes([]);
  const status = normalizeTaskStatus(task.status);
  const result = task.result || {};
  const backlogCategory = backlogCategoryForStatus(status);

  // ===================================================================
  // RESOLVED_LEGACY — task already resolved by successor/noop/upstream
  // ===================================================================

  // 1a. Explicit resolution markers on the result
  if (
    result.resolved_by_task_id ||
    result.superseded_by_task_id ||
    result.noop === true ||
    result.resolved_legacy === true
  ) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
      backlog_category: backlogCategory,
      evidence: {
        resolved_by_task_id: result.resolved_by_task_id,
        superseded_by_task_id: result.superseded_by_task_id,
        noop: result.noop,
        resolved_legacy: result.resolved_legacy,
      },
      reason: 'Task has explicit resolution marker',
      recommended_next_action: 'skip_or_accept',
    };
  }

  // 1b. Legacy review reconciliation
  if (isResolvedLegacyReviewTask(task)) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
      backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REVIEW,
      evidence: { status, reconciliation: 'resolved_legacy_review' },
      reason: 'Legacy waiting_for_review task resolved by reconciliation rules',
      recommended_next_action: 'auto_accept',
    };
  }

  // 1c. Failed terminal with implicit successor
  if (isFailedTerminalStatus(status) && hasImplicitSuccessor(task, resolvedIndexes)) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
      backlog_category: backlogCategory,
      evidence: { status, has_implicit_successor: true },
      reason: 'Failed terminal task has implicit successor with completion evidence',
      recommended_next_action: 'skip_or_accept',
    };
  }

  // 1d. Legacy failed terminal reconciliation
  if (isTerminalStatus(status) && isResolvedLegacyTerminalTask(task)) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
      backlog_category: backlogCategory,
      evidence: { status, reconciliation: 'resolved_legacy_terminal' },
      reason: 'Failed terminal task resolved by reconciliation rules',
      recommended_next_action: 'skip',
    };
  }

  // ===================================================================
  // WAITING_FOR_REVIEW — legacy generic review
  // ===================================================================
  if (status === TASK_STATUSES.WAITING_FOR_REVIEW) {
    const migration = classifyLegacyWaitingForReviewMigration(task);

    // Already resolved — auto-accept
    if (migration.migration_action === LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
        backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REVIEW,
        evidence: migration.evidence,
        reason: migration.reason,
        recommended_next_action: 'auto_accept',
    };
    }

    // Map migration target to blocker classification
    if (migration.target_review_state) {
      return {
        classification: reviewStateToBlockerClassification(migration.target_review_state),
        backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REVIEW,
        evidence: {
          ...migration.evidence,
          legacy_migration: migration.migration_action,
          target_review_state: migration.target_review_state,
        },
        reason: migration.reason,
        recommended_next_action: migrationActionToNextAction(migration.migration_action, migration.target_review_state),
    };
    }

    // Fallback: treat as true human review
    return {
      classification: BLOCKER_CLASSIFICATIONS.TRUE_HUMAN_REVIEW,
      backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REVIEW,
      evidence: { status, result_fields: Object.keys(result) },
      reason: 'Legacy waiting_for_review task with no clear machine-classifiable path',
      recommended_next_action: 'human_review_required',
    };
  }

  // ===================================================================
  // TYPED REVIEW STATES — map directly to blocker classification
  // ===================================================================
  if (isTypedReviewState(status)) {
    return {
      classification: reviewStateToBlockerClassification(status),
      backlog_category: BACKLOG_CATEGORIES.TYPED_REVIEW,
      evidence: { status, review_state: status },
      reason: `Task is already in typed review state: ${status}`,
      recommended_next_action: typedStateToNextAction(status),
    };
  }

  // ===================================================================
  // WAITING_FOR_REPAIR
  // ===================================================================
  if (status === TASK_STATUSES.WAITING_FOR_REPAIR) {

    // Check for contract/acceptance issues first (before result shape check)
    if (
      result.contract_issue === true ||
      result.acceptance_failed === true ||
      result.failure_class === 'acceptance_failed' ||
      result.failure_class === 'contract_invalid' ||
      result.failure_class === 'contract_requires_review'
    ) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.RESULT_CONTRACT_REPAIR,
        backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REPAIR,
        evidence: { status, contract_issue: true, failure_class: result.failure_class, acceptance_failed: result.acceptance_failed },
        reason: 'Task in repair state with contract/acceptance issues',
        recommended_next_action: 'contract_repair',
    };
    }

    // Classify by looking at the result content and closure path
    const decision = classifyCurrentBlockerTask(task);
    const resultShape = classifyResultShape(result);

    // Check if repair budget was exhausted
    if (
      result.repair_budget_exhausted === true ||
      task.repair_count >= (task.max_repairs || 3)
    ) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.REPAIR_BUDGET_EXHAUSTED,
        backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REPAIR,
        evidence: {
          repair_count: task.repair_count,
          max_repairs: task.max_repairs,
          repair_budget_exhausted: true,
        },
        reason: 'Repair budget has been exhausted for this task',
        recommended_next_action: 'human_review_of_exhausted_repairs',
    };
    }

    // Check result shape for evidence type
    if (resultShape === RESULT_SHAPE_TYPES.FAILURE_EVIDENCE || resultShape === RESULT_SHAPE_TYPES.CODE_EVIDENCE) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
        backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REPAIR,
        evidence: { status, result_shape: resultShape, decision: decision.label },
        reason: 'Task in repair state with evidence of failure — can be auto-repaired',
        recommended_next_action: 'auto_repair',
    };
    }

    // Default repair: missing evidence
    return {
      classification: BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
      backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_REPAIR,
      evidence: { status, result_shape: resultShape },
      reason: 'Task in repair state — classified as missing evidence repair',
      recommended_next_action: 'auto_repair',
    };
  }

  // ===================================================================
  // WAITING_FOR_INTEGRATION
  // ===================================================================
  if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
    return {
      classification: BLOCKER_CLASSIFICATIONS.INTEGRATION_RECOVERY,
      backlog_category: BACKLOG_CATEGORIES.WAITING_FOR_INTEGRATION,
      evidence: { status },
      reason: 'Task is waiting for integration — can be retried or auto-recovered',
      recommended_next_action: 'integration_recovery',
    };
  }

  // ===================================================================
  // FAILED TERMINAL
  // ===================================================================
  if (isFailedTerminalStatus(status)) {
    // Delegate to the existing current-blocker-policy for detailed classification
    const decision = classifyCurrentBlockerTask(task);

    // Non-blocking (resolved) — already caught above
    if (!decision.blocks_current_work) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
        backlog_category: BACKLOG_CATEGORIES.FAILED,
        evidence: { status, decision: decision.label, blocks_current_work: false },
        reason: `Failed terminal classified as non-blocking (${decision.label})`,
        recommended_next_action: 'skip',
    };
    }

    // Blocking failed with failure evidence — check if repairable
    if (decision.label === CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE) {
      // Check if the failure is repairable
      const hasRepairInfo = result.repair_count != null || result.failure_class != null;
      if (hasRepairInfo && (result.repair_attempted === true || result.repair_count > 0)) {
        if (result.repair_count >= (result.max_repairs || 3)) {
          return {
            classification: BLOCKER_CLASSIFICATIONS.REPAIR_BUDGET_EXHAUSTED,
            backlog_category: BACKLOG_CATEGORIES.FAILED,
            evidence: {
              status,
              repair_count: result.repair_count,
              max_repairs: result.max_repairs,
              failure_class: result.failure_class,
            },
            reason: 'Failed terminal with exhausted repair budget',
            recommended_next_action: 'human_review_of_exhausted_repairs',
        };
        }
        return {
          classification: BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
          backlog_category: BACKLOG_CATEGORIES.FAILED,
          evidence: { status, failure_class: result.failure_class, decision: decision.label },
          reason: `Failed terminal with repairable failure evidence (${result.failure_class || 'unknown'})`,
          recommended_next_action: 'auto_repair',
      };
      }

      // No repair info — treat as potentially recoverable
      return {
        classification: BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
        backlog_category: BACKLOG_CATEGORIES.FAILED,
        evidence: { status, decision: decision.label, has_repair_info: hasRepairInfo },
        reason: 'Failed terminal with failure evidence — repairable',
        recommended_next_action: 'auto_repair',
    };
    }

    // Code evidence failure — potentially repairable
    if (decision.label === CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE) {
      return {
        classification: BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
        backlog_category: BACKLOG_CATEGORIES.FAILED,
        evidence: { status, decision: decision.label },
        reason: 'Failed terminal with code evidence — repairable',
        recommended_next_action: 'auto_repair',
    };
    }

    // Default: unrecoverable
    return {
      classification: BLOCKER_CLASSIFICATIONS.UNRECOVERABLE_FAILED,
      backlog_category: BACKLOG_CATEGORIES.FAILED,
      evidence: { status, decision: decision.label, result_shape: classifyResultShape(result) },
      reason: `Failed terminal with no clear recovery path (decision=${decision.label})`,
      recommended_next_action: 'manual_review',
    };
  }

  // ===================================================================
  // UNKNOWN / UNREACHABLE
  // ===================================================================
  return {
    classification: BLOCKER_CLASSIFICATIONS.UNRECOVERABLE_FAILED,
    backlog_category: backlogCategory,
    evidence: { status },
    reason: `Unable to classify task with status=${status}`,
    recommended_next_action: 'manual_review',
  };
}

// ---------------------------------------------------------------------------
// Census scan — full backlog scan over a StateStore instance
// ---------------------------------------------------------------------------

/**
 * Scan the state store for all backlog tasks and produce a structured census.
 *
 * @param {object} store - StateStore instance (must expose load() and getCodexTasksByStatus())
 * @returns {Promise<{
 *   scanned_at: string,
 *   total_tasks: number,
 *   backlog_tasks: number,
 *   raw_counts: object,
 *   policy_counts: object,
 *   classification_summary: object,
 *   by_category: object,
 *   tasks: Array,
 *   legacy_review_migration: object,
 *   convergence_report: object,
 * }>}
 */
export async function scanBacklogCensus(store) {
  const state = await store.load();
  const tasks = state.tasks || [];
  const indexes = buildTaskQueueIndexes(tasks);
  const rawCounts = {};
  const policyCounts = {};

  // Build raw status counts
  for (const task of tasks) {
    if (task.assignee !== 'codex') continue;
    const s = task.status;
    rawCounts[s] = (rawCounts[s] || 0) + 1;
  }

  // Use existing policy-aware counting
  const { default: workerQueueCounts } = await import('./worker-queue-counts.mjs');
  // Actually use collectWorkerQueueCounts
  // But since it's a named export, import properly — let's inline reflection
  const workerCounts = await (await import('./worker-queue-counts.mjs')).collectWorkerQueueCounts(store);
  Object.assign(policyCounts, workerCounts.policy_counts || workerCounts);

  // Classify all backlog tasks
  const backlogStatuses = new Set([
    TASK_STATUSES.WAITING_FOR_REVIEW,
    TASK_STATUSES.WAITING_FOR_REPAIR,
    TASK_STATUSES.WAITING_FOR_INTEGRATION,
    ...Object.values(REVIEW_STATES),
  ]);
  for (const s of Object.values(TASK_STATUSES)) {
    if (isFailedTerminalStatus(s)) backlogStatuses.add(s);
  }

  const classifiedTasks = [];
  const classificationCounts = {};
  const byCategory = {};
  const legacyReviewTasks = [];

  for (const task of tasks) {
    if (task.assignee !== 'codex') continue;
    if (!backlogStatuses.has(task.status)) continue;

    const classification = classifyBlocker(task, indexes);
    classifiedTasks.push({
      task_id: task.id,
      status: task.status,
      classification: classification.classification,
      backlog_category: classification.backlog_category,
      reason: classification.reason,
      recommended_next_action: classification.recommended_next_action,
      evidence: classification.evidence,
      goal_id: task.goal_id,
      created_at: task.created_at,
      updated_at: task.updated_at,
    });

    // Count classifications
    const cls = classification.classification;
    classificationCounts[cls] = (classificationCounts[cls] || 0) + 1;

    // Group by backlog category
    const cat = classification.backlog_category || 'other';
    if (!byCategory[cat]) byCategory[cat] = { count: 0, tasks: [], classifications: {} };
    byCategory[cat].count += 1;
    byCategory[cat].tasks.push(task.id);
    byCategory[cat].classifications[cls] = (byCategory[cat].classifications[cls] || 0) + 1;

    // Collect legacy review tasks for migration analysis
    if (task.status === TASK_STATUSES.WAITING_FOR_REVIEW) {
      legacyReviewTasks.push({
        task_id: task.id,
        goal_id: task.goal_id,
        classification: classification.classification,
        ...classifyLegacyWaitingForReviewMigration(task),
      });
    }
  }

  // Legacy review migration summary
  const migrationSummary = {
    total_legacy_review: legacyReviewTasks.length,
    auto_migrate: legacyReviewTasks.filter(t => t.migration_action === LEGACY_MIGRATION_ACTIONS.AUTO_MIGRATE_TO_TYPED).length,
    auto_accept: legacyReviewTasks.filter(t => t.migration_action === LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT).length,
    true_human_review_required: legacyReviewTasks.filter(t => t.migration_action === LEGACY_MIGRATION_ACTIONS.TRUE_HUMAN_REVIEW_REQUIRED).length,
    tasks: legacyReviewTasks,
  };

  // Convergence report
  const convergenceReport = generateBacklogConvergenceReport(classifiedTasks, classificationCounts, byCategory);

  return {
    scanned_at: new Date().toISOString(),
    total_tasks: tasks.length,
    backlog_tasks: classifiedTasks.length,
    raw_counts: rawCounts,
    policy_counts: policyCounts,
    classification_summary: classificationCounts,
    by_category: byCategory,
    tasks: classifiedTasks,
    legacy_review_migration: migrationSummary,
    convergence_report: convergenceReport,
  };
}

// ---------------------------------------------------------------------------
// Convergence report builder
// ---------------------------------------------------------------------------

/**
 * Generate a structured backlog convergence report from classified tasks.
 *
 * @param {Array} classifiedTasks - Array of classified blocker entries
 * @param {object} classificationCounts - Counts per classification type
 * @param {object} byCategory - Grouped tasks by backlog category
 * @returns {{
 *   total_blockers: number,
 *   machine_repairable: number,
 *   human_review_required: number,
 *   resolved_skip: number,
 *   unrecoverable: number,
 *   recommended_actions: Array,
 *   summary: string,
 * }}
 */
export function generateBacklogConvergenceReport(classifiedTasks, classificationCounts, byCategory) {
  const machineRepairable = new Set([
    BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR,
    BLOCKER_CLASSIFICATIONS.RESULT_CONTRACT_REPAIR,
    BLOCKER_CLASSIFICATIONS.INTEGRATION_RECOVERY,
    BLOCKER_CLASSIFICATIONS.NOOP_EVIDENCE,
  ]);

  const humanReview = new Set([
    BLOCKER_CLASSIFICATIONS.TRUE_HUMAN_REVIEW,
    BLOCKER_CLASSIFICATIONS.REPAIR_BUDGET_EXHAUSTED,
  ]);

  const resolvedSkip = new Set([
    BLOCKER_CLASSIFICATIONS.RESOLVED_LEGACY,
  ]);

  const unrecoverable = new Set([
    BLOCKER_CLASSIFICATIONS.UNRECOVERABLE_FAILED,
  ]);

  let machineCount = 0;
  let humanCount = 0;
  let resolvedCount = 0;
  let unrecoverableCount = 0;

  for (const [cls, count] of Object.entries(classificationCounts || {})) {
    if (machineRepairable.has(cls)) machineCount += count;
    if (humanReview.has(cls)) humanCount += count;
    if (resolvedSkip.has(cls)) resolvedCount += count;
    if (unrecoverable.has(cls)) unrecoverableCount += count;
  }

  const recommendedActions = [];
  for (const task of (classifiedTasks || [])) {
    const existing = recommendedActions.find(a => a.action === task.recommended_next_action);
    if (existing) {
      existing.count += 1;
    } else {
      recommendedActions.push({
        action: task.recommended_next_action,
        count: 1,
        example_task_ids: [task.task_id],
      });
    }
  }

  const total = classifiedTasks?.length || 0;

  const summaryParts = [
    `Backlog Census: ${total} total blockers identified.`,
    `Machine-repairable: ${machineCount}`,
    `Human review required: ${humanCount}`,
    `Resolved/skip: ${resolvedCount}`,
    `Unrecoverable: ${unrecoverableCount}.`,
    `${recommendedActions.length} distinct recommended actions.`,
  ];

  return {
    total_blockers: total,
    machine_repairable: machineCount,
    human_review_required: humanCount,
    resolved_skip: resolvedCount,
    unrecoverable: unrecoverableCount,
    recommended_actions: recommendedActions.sort((a, b) => b.count - a.count),
    summary: summaryParts.join(' '),
  };
}

// ---------------------------------------------------------------------------
// Convenience runner
// ---------------------------------------------------------------------------

/**
 * Run scanBacklogCensus against a flat array of tasks without requiring a
 * full StateStore instance.  Creates a minimal store-like adapter internally.
 *
 * This is the primary entrypoint for CLI / ad-hoc census scans.  It always
 * creates a fresh store wrapper so callers never need to know about the
 * StateStore interface.
 *
 * @param {Array} tasks - Array of task objects
 * @returns {Promise<object>} Complete census result from scanBacklogCensus
 */
export async function runBacklogCensus(tasks) {
  const adapterStore = {
    async load() {
      return { tasks: tasks || [] };
    },
    getCodexTasksByStatus() {
      const filtered = (tasks || []).filter(t => t.assignee === 'codex');
      const byStatus = {};
      for (const task of filtered) {
        const s = task.status;
        byStatus[s] = (byStatus[s] || 0) + 1;
      }
      return filtered; // legacy path: return array; collector handles counts
    },
  };
  return scanBacklogCensus(adapterStore);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a typed review state to one of the 8 blocker classifications.
 * @param {string} reviewState
 * @returns {string}
 */
function reviewStateToBlockerClassification(reviewState) {
  switch (reviewState) {
    case REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW:
      return BLOCKER_CLASSIFICATIONS.TRUE_HUMAN_REVIEW;
    case REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR:
      return BLOCKER_CLASSIFICATIONS.MISSING_EVIDENCE_REPAIR;
    case REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY:
      return BLOCKER_CLASSIFICATIONS.INTEGRATION_RECOVERY;
    case REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR:
      return BLOCKER_CLASSIFICATIONS.RESULT_CONTRACT_REPAIR;
    case REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE:
      return BLOCKER_CLASSIFICATIONS.NOOP_EVIDENCE;
    case REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION:
      return BLOCKER_CLASSIFICATIONS.TRUE_HUMAN_REVIEW;
    case REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED:
      return BLOCKER_CLASSIFICATIONS.REPAIR_BUDGET_EXHAUSTED;
    default:
      return BLOCKER_CLASSIFICATIONS.UNRECOVERABLE_FAILED;
  }
}

/**
 * Map a migration action + target state to a recommended next action string.
 * @param {string} migrationAction
 * @param {string|null} targetState
 * @returns {string}
 */
function migrationActionToNextAction(migrationAction, targetState) {
  switch (migrationAction) {
    case LEGACY_MIGRATION_ACTIONS.AUTO_MIGRATE_TO_TYPED:
      return 'auto_migrate';
    case LEGACY_MIGRATION_ACTIONS.AUTO_ACCEPT:
      return 'auto_accept';
    case LEGACY_MIGRATION_ACTIONS.TRUE_HUMAN_REVIEW_REQUIRED:
      return 'human_review_required';
    default:
      return 'manual_review';
  }
}

/**
 * Map a typed review state to a recommended next action string.
 * @param {string} state
 * @returns {string}
 */
function typedStateToNextAction(state) {
  switch (state) {
    case REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW:
      return 'human_review_required';
    case REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR:
      return 'auto_repair';
    case REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY:
      return 'integration_recovery';
    case REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR:
      return 'contract_repair';
    case REVIEW_STATES.WAITING_FOR_NOOP_EVIDENCE:
      return 'evidence_collection';
    case REVIEW_STATES.WAITING_FOR_MANUAL_TERMINAL_DECISION:
      return 'human_terminal_decision';
    case REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED:
      return 'human_review_of_exhausted_repairs';
    default:
      return 'manual_review';
  }
}
