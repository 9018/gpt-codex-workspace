/**
 * queue-health-metrics.mjs — Queue Health & Automation Metrics
 *
 * P0-UA5: Computes automation effectiveness and queue health observability
 * metrics from task state.  Designed to measure new-task E2E maturity rather
 * than historical policy cleanup.
 *
 * Exported functions:
 *   collectQueueHealthMetrics(store)   — gather all metrics from state
 *   formatQueueHealthCard(data)         — format as a diagnostics card string
 *
 * Metrics:
 *   auto_acceptance_rate         — fraction of completed tasks with auto-accept evidence
 *   auto_advance_rate            — fraction of queue items that auto-advanced
 *   manual_review_escape_rate    — tasks that needed human review despite automation
 *   repair_loop_success_rate     — repair attempts that led to completion
 *   provider_noise_rate          — provider no-result / timeout as fraction of total
 *   raw_state_drift_count        — tasks whose raw status differs from policy interpretation
 *   policy_excluded_count        — tasks excluded from current blockers by policy
 *   state_migration_count        — tasks that needed state migration (e.g. legacy -> typed)
 *   time_to_close                — average ms from creation to terminal completion
 *   raw_counts                   — raw status counts for all codex tasks
 *   policy_counts                — policy-filtered counts
 *   raw_legacy_resolved          — tasks resolved by legacy reconciliation
 *   raw_unresolved               — tasks still blocking despite policy
 *   current_blockers             — sum of policy-counted blockers
 *   policy_excluded_count        — tasks excluded by policy from current_blockers
 */

import {
  TASK_STATUSES,
  normalizeTaskStatus,
  isTerminalStatus,
  isCompletedStatus,
  isFailedTerminalStatus,
  isActiveExecutionStatus,
} from './task-status-taxonomy.mjs';
import {
  classifyCurrentBlockerTask,
  CURRENT_WORK_DECISION_LABELS,
} from './current-blocker-policy.mjs';
import {
  classifyBlocker,
  BLOCKER_CLASSIFICATIONS,
  BACKLOG_CATEGORIES,
} from './backlog-census.mjs';
import {
  isResolvedLegacyReviewTask,
  isResolvedLegacyTerminalTask,
  hasCompletionEvidence,
} from './legacy-reconciliation.mjs';
import {
  buildTaskQueueIndexes,
  hasImplicitSuccessor,
  isPolicyCurrentBlockerTask,
  computePolicyQueueCounts,
  collectWorkerQueueCounts,
} from './worker-queue-counts.mjs';
import { classifyResultShape, RESULT_SHAPE_TYPES } from './result-shape-classifier.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_ACCEPT_EVIDENCE_STATUSES = new Set([
  'auto_completed_clean',
  'auto_completed_with_followups',
]);

const REVIEW_ESCAPE_STATUSES = new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
  'waiting_for_human_review',
]);

const LEGACY_COMPLETED_TERMINAL = new Set([
  TASK_STATUSES.COMPLETED,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyTerminalClosure(task) {
  if (!task || !task.result) return 'unknown';
  const r = task.result;
  if (r.closure_decision?.auto_complete_allowed) return 'auto_completed';
  if (r.reviewer_decision?.passed === true) return 'auto_accepted';
  if (r.acceptance?.status === 'accepted') return 'auto_accepted';
  if (r.closure_decision?.status) {
    const s = r.closure_decision.status;
    if (AUTO_ACCEPT_EVIDENCE_STATUSES.has(s)) return 'auto_completed';
    if (s.startsWith('auto_')) return 'auto_completed';
  }
  if (r.verification?.passed === true) return 'auto_accepted';
  if (r.requires_review === true) return 'manual_review_escape';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Collect comprehensive queue health metrics from state store.
 *
 * @param {object} store - StateStore instance
 * @returns {Promise<object>} Health metrics object
 */
export async function collectQueueHealthMetrics(store) {
  const state = await store.load();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const codexTasks = tasks.filter(t => t.assignee === 'codex');
  const indexes = buildTaskQueueIndexes(tasks);

  // Collect raw queue counts via existing worker-queue-counts
  const queueCounts = await collectWorkerQueueCounts(store);

  // Raw counts from state
  const rawCounts = {};
  for (const task of codexTasks) {
    const s = task.status;
    rawCounts[s] = (rawCounts[s] || 0) + 1;
  }

  // Policy counts via existing compute
  const policyCounts = computePolicyQueueCounts(codexTasks, indexes);

  // ---- per-metric computations ----

  // auto_acceptance_rate: completed tasks with auto-accept evidence
  const completedTasks = codexTasks.filter(t => isCompletedStatus(t.status));
  const autoAccepted = completedTasks.filter(t => {
    const closure = classifyTerminalClosure(t);
    return closure === 'auto_completed' || closure === 'auto_accepted';
  });
  const auto_acceptance_rate = completedTasks.length > 0
    ? autoAccepted.length / completedTasks.length
    : 0;

  // auto_advance_rate: queue items that auto-advanced
  const queueItems = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const autoAdvanceCandidates = queueItems.filter(i => i.auto_start !== false);
  const autoAdvanced = autoAdvanceCandidates.filter(i => i.status === 'running' || i.status === 'completed');
  const auto_advance_rate = autoAdvanceCandidates.length > 0
    ? autoAdvanced.length / autoAdvanceCandidates.length
    : 0;

  // manual_review_escape_rate: tasks reaching human review states despite automation
  const reviewEscapes = codexTasks.filter(t => REVIEW_ESCAPE_STATUSES.has(t.status));
  const manual_review_escape_rate = codexTasks.length > 0
    ? reviewEscapes.length / codexTasks.length
    : 0;

  // repair_loop_success_rate: repair attempts that eventually completed
  const repairTasks = codexTasks.filter(t =>
    t.status === TASK_STATUSES.WAITING_FOR_REPAIR ||
    t.metadata?.repair_attempts > 0 ||
    t.repair_count > 0
  );
  const repairSucceeded = repairTasks.filter(t => {
    if (t.status === TASK_STATUSES.COMPLETED) return true;
    if (t.result?.closure_decision?.auto_complete_allowed) return true;
    // Check if repair led to eventual completion via successor
    if (t.id && indexes.tasksById.has(t.id)) return false;
    return hasImplicitSuccessor(t, indexes);
  });
  const repair_loop_success_rate = repairTasks.length > 0
    ? repairSucceeded.length / repairTasks.length
    : 0;

  // provider_noise_rate: provider no-result/timeout as fraction of codex tasks
  const noiseTasks = codexTasks.filter(t => {
    const shape = classifyResultShape(t.result);
    return shape === RESULT_SHAPE_TYPES.PROVIDER_NOOP ||
      shape === RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT ||
      shape === RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE;
  });
  const provider_noise_rate = codexTasks.length > 0
    ? noiseTasks.length / codexTasks.length
    : 0;

  // raw_state_drift_count: tasks whose raw status differs from policy interpretation
  let raw_state_drift_count = 0;
  for (const task of codexTasks) {
    const policyBlocking = isPolicyCurrentBlockerTask(task, indexes);
    const rawBlocking = !isTerminalStatus(task.status) && task.status !== TASK_STATUSES.COMPLETED;
    if (policyBlocking !== rawBlocking) {
      raw_state_drift_count += 1;
    }
  }

  // policy_excluded_count: tasks excluded from current blockers by policy
  let policy_excluded_count = 0;
  for (const task of codexTasks) {
    if (!isTerminalStatus(task.status) && task.status !== TASK_STATUSES.COMPLETED) {
      if (!isPolicyCurrentBlockerTask(task, indexes)) {
        policy_excluded_count += 1;
      }
    }
  }

  // state_migration_count: tasks migrated from legacy to typed
  const migratedTasks = codexTasks.filter(t =>
    t.result?.legacy_migration === true ||
    t.metadata?.state_migration === true ||
    isResolvedLegacyReviewTask(t) ||
    isResolvedLegacyTerminalTask(t)
  );
  const state_migration_count = migratedTasks.length;

  // time_to_close: average ms from creation to terminal completion
  const terminalTasks = codexTasks.filter(t =>
    isCompletedStatus(t.status) || isFailedTerminalStatus(t.status)
  );
  let time_to_close = 0;
  let closeCount = 0;
  for (const task of terminalTasks) {
    const created = Date.parse(task.created_at);
    const updated = Date.parse(task.updated_at);
    if (Number.isFinite(created) && Number.isFinite(updated) && updated >= created) {
      time_to_close += updated - created;
      closeCount += 1;
    }
  }
  time_to_close = closeCount > 0 ? Math.round(time_to_close / closeCount) : 0;

  // raw_legacy_resolved: tasks resolved by legacy reconciliation
  const rawLegacyResolved = codexTasks.filter(t =>
    isResolvedLegacyReviewTask(t) || isResolvedLegacyTerminalTask(t)
  ).length;

  // raw_unresolved: tasks still blocking despite policy
  const rawUnresolved = codexTasks.filter(t =>
    !isTerminalStatus(t.status) &&
    t.status !== TASK_STATUSES.COMPLETED
  ).length;

  // current_blockers from policy counts
  const currentBlockers = (policyCounts.waiting_for_lock || 0)
    + (policyCounts.waiting_for_integration || 0)
    + (policyCounts.waiting_for_repair || 0)
    + (policyCounts.waiting_for_review || 0)
    + (policyCounts.failed || 0);

  return {
    scanned_at: new Date().toISOString(),
    total_codex_tasks: codexTasks.length,
    total_queue_items: queueItems.length,
    metrics: {
      auto_acceptance_rate: Number(auto_acceptance_rate.toFixed(4)),
      auto_advance_rate: Number(auto_advance_rate.toFixed(4)),
      manual_review_escape_rate: Number(manual_review_escape_rate.toFixed(4)),
      repair_loop_success_rate: Number(repair_loop_success_rate.toFixed(4)),
      provider_noise_rate: Number(provider_noise_rate.toFixed(4)),
      raw_state_drift_count,
      policy_excluded_count,
      state_migration_count,
      time_to_close_ms: time_to_close,
    },
    raw_counts: rawCounts,
    policy_counts: policyCounts,
    raw_legacy_resolved: rawLegacyResolved,
    raw_unresolved: rawUnresolved,
    current_blockers: currentBlockers,
    legacy_failed_policy: queueCounts.legacy_failed_policy || {
      policy: 'resolved_legacy_failed_excluded_from_current_blockers',
      resolved_legacy_failed: 0,
      unresolved_failed: 0,
      resolved_legacy_review: 0,
      blocks_current_work: false,
    },
    // Integration with worker-queue-counts fields for card rendering
    ...policyCounts,
    policy_excluded_count,
    current_blockers: currentBlockers,
    // Queue display helpers
    actionable_review: policyCounts.waiting_for_review || 0,
  };
}

/**
 * Format queue health metrics as a diagnostics card text block.
 *
 * @param {object} data - Result from collectQueueHealthMetrics
 * @returns {string}
 */
export function formatQueueHealthCard(data) {
  if (!data) return '  No queue health data.';

  const lines = [];
  const m = data.metrics || {};

  lines.push('  Queue Health Metrics:');
  lines.push(`    auto_acceptance_rate:       ${(m.auto_acceptance_rate * 100).toFixed(1)}%`);
  lines.push(`    auto_advance_rate:          ${(m.auto_advance_rate * 100).toFixed(1)}%`);
  lines.push(`    manual_review_escape_rate:  ${(m.manual_review_escape_rate * 100).toFixed(1)}%`);
  lines.push(`    repair_loop_success_rate:   ${(m.repair_loop_success_rate * 100).toFixed(1)}%`);
  lines.push(`    provider_noise_rate:        ${(m.provider_noise_rate * 100).toFixed(1)}%`);
  lines.push(`    raw_state_drift_count:      ${m.raw_state_drift_count}`);
  lines.push(`    policy_excluded_count:      ${m.policy_excluded_count}`);
  lines.push(`    state_migration_count:      ${m.state_migration_count}`);
  lines.push(`    time_to_close_ms:           ${m.time_to_close_ms}`);
  lines.push('');

  // Queue breakdown with raw + policy clarity
  const raw = data.raw_counts || {};
  const policy = data.policy_counts || {};
  const statuses = [
    'assigned', 'queued', 'running', 'waiting_for_lock',
    'waiting_for_review', 'waiting_for_repair', 'waiting_for_integration',
    'completed', 'failed',
  ];

  lines.push('  Queue Breakdown (raw → policy):');
  for (const st of statuses) {
    const r = raw[st] ?? 0;
    const p = policy[st] ?? 0;
    const marker = r !== p ? ' *' : '';
    lines.push(`    ${st.padEnd(22)} ${String(r).padStart(3)} → ${String(p).padStart(3)}${marker}`);
  }
  lines.push('');

  lines.push('  Summary:');
  lines.push(`    current_blockers:          ${data.current_blockers}`);
  lines.push(`    raw_legacy_resolved:       ${data.raw_legacy_resolved}`);
  lines.push(`    raw_unresolved:            ${data.raw_unresolved}`);
  lines.push(`    policy_excluded_count:     ${data.policy_excluded_count}`);

  if (data.legacy_failed_policy) {
    const lf = data.legacy_failed_policy;
    lines.push(`    legacy_failed_policy:      resolved=${lf.resolved_legacy_failed} unresolved=${lf.unresolved_failed} review=${lf.resolved_legacy_review}`);
  }

  return lines.join('\n');
}
