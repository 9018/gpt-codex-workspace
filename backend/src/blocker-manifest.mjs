/**
 * blocker-manifest.mjs — Precise Current-Blocker Manifest & Safe Convergence
 *
 * P0-MA11-R6: Produces an exact, categorized manifest of current blockers and
 * applies deterministic convergence only where existing evidence proves safety.
 *
 * Categories:
 *   auto_terminalizable        — Provider-empty / resolved / no-op tasks that
 *                                can be auto-completed safely.
 *   deterministic_repair_needed — Code or failure evidence that is stale/legacy
 *                                and can be repaired deterministically.
 *   external_wait              — waiting_for_integration: depends on external
 *                                infra (git push, PR merge).
 *   true_human_review          — Requires human judgment.
 *   unresolved_failure         — Real unresolved failure with evidence.
 *
 * Convergence evidence rules (only where safe):
 *   a) Already integrated commit (commit reachable from HEAD + passing verification)
 *   b) isVerificationNormalized (canonical verification.passed + blocking_passed)
 *   c) Superseded/resolved_by_task_id markers
 *   d) No-op legacy (noop=true, resolved_legacy=true)
 *   e) Stale fallback noise with PROVIDER_EMPTY result shapes
 */

import { collectWorkerQueueCounts, computePolicyQueueCounts, buildTaskQueueIndexes } from './worker-queue-counts.mjs';
import {
  classifyCurrentBlockerTask,
  isVerificationNormalized,
  CURRENT_WORK_DECISION_LABELS,
  isCommitAncestorOfHead,
} from './current-blocker-policy.mjs';
import { backlogCategoryForStatus } from './backlog-census.mjs';
import {
  TASK_STATUSES,
  isFailedTerminalStatus,
  TRUE_HUMAN_REVIEW_STATUSES,
  isTypedReviewStatus,
} from './task-status-taxonomy.mjs';
import { classifyResultShape, RESULT_SHAPE_TYPES } from './result-shape-classifier.mjs';
import { TYPED_REVIEW_STATES } from './task-review-status-taxonomy.mjs';
import { convergeStaleTaskStates } from './stale-state-sweeper.mjs';
import { hasImplicitSuccessor } from './worker-queue-counts.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_EMPTY_SHAPES = Object.freeze(new Set([
  RESULT_SHAPE_TYPES.NO_RESULT,
  RESULT_SHAPE_TYPES.PROVIDER_NOOP,
  RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT,
  RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE,
]));

const MANIFEST_CATEGORIES = Object.freeze({
  AUTO_TERMINALIZABLE: 'auto_terminalizable',
  DETERMINISTIC_REPAIR_NEEDED: 'deterministic_repair_needed',
  EXTERNAL_WAIT: 'external_wait',
  TRUE_HUMAN_REVIEW: 'true_human_review',
  UNRESOLVED_FAILURE: 'unresolved_failure',
});

// ---------------------------------------------------------------------------
// Task-level classification
// ---------------------------------------------------------------------------

/**
 * Classify a current blocker into one of the 5 manifest categories.
 *
 * Ordering is critical: decision-label-based checks (resolved_by_options,
 * provider_empty, completed) must come BEFORE status-based checks
 * (TRUE_HUMAN_REVIEW_STATUSES) to avoid overriding resolved/noop markers
 * that already made a task non-blocking at the decision level.
 *
 * @param {object} task - Full task record with result
 * @param {object} decision - Result of classifyCurrentBlockerTask(task)
 * @param {object} indexes - Build task queue indexes (for successor detection)
 * @returns {string} One of MANIFEST_CATEGORIES values
 */
export function classifyBlockerManifestCategory(task, decision, indexes) {
  const status = task?.status || '';
  const result = task?.result || {};
  const resultShape = decision?.result_shape || classifyResultShape(result);

  // Ordering: specific status checks before generic result-shape checks.
  // Decision-label checks (resolved_by_options etc.) come before any
  // status-based check because they reflect the most precise classification.

  // 1. external_wait: waiting_for_integration
  if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
    return MANIFEST_CATEGORIES.EXTERNAL_WAIT;
  }

  // 2. Decision-label-based checks (most specific — override any status inference)
  if (decision?.label === CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS) {
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }
  if (decision?.label === CURRENT_WORK_DECISION_LABELS.COMPLETED) {
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }
  if (decision?.label === CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY) {
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }

  // 3. Explicit noop/resolved_legacy in result (deterministic markers)
  if (result?.noop === true || result?.resolved_legacy === true) {
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }

  // 4. True human review statuses (status-level, must come before result-shape checks)
  if (TRUE_HUMAN_REVIEW_STATUSES.has(status)) {
    return MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW;
  }

  // 5. unresolved_failure: failed with real evidence and no implicit successor
  if (isFailedTerminalStatus(status)) {
    const hasSuccessor = hasImplicitSuccessor(task, indexes);
    if (!hasSuccessor) {
      return MANIFEST_CATEGORIES.UNRESOLVED_FAILURE;
    }
    // Has an implicit successor -> can be auto_terminalizable
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }

  // 6. deterministic_repair_needed: waiting_for_repair
  if (status === TASK_STATUSES.WAITING_FOR_REPAIR) {
    return MANIFEST_CATEGORIES.DETERMINISTIC_REPAIR_NEEDED;
  }

  // 7. waiting_for_review with no resolution marker (not in TRUE_HUMAN_REVIEW_STATUSES)
  if (status === TASK_STATUSES.WAITING_FOR_REVIEW) {
    if (resultShape === RESULT_SHAPE_TYPES.FAILURE_EVIDENCE || resultShape === RESULT_SHAPE_TYPES.CODE_EVIDENCE) {
      return MANIFEST_CATEGORIES.UNRESOLVED_FAILURE;
    }
    if (isVerificationNormalized(result)) {
      return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
    }
    return MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW;
  }

  // 8. Provider-empty result shapes (catch-all for other statuses)
  if (PROVIDER_EMPTY_SHAPES.has(resultShape)) {
    return MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE;
  }

  // 9. Fallback for remaining statuses
  return MANIFEST_CATEGORIES.DETERMINISTIC_REPAIR_NEEDED;
}

// ---------------------------------------------------------------------------
// Evidence summary function
// ---------------------------------------------------------------------------

function summarizeEvidence(task) {
  const result = task?.result || {};
  const evidence = [];

  if (result?.commit) evidence.push(`commit=${result.commit.slice(0, 7)}`);
  if (result?.verification?.passed === true) evidence.push('verification=passed');
  if (result?.tests) evidence.push('tests=present');
  if (result?.resolved_by_task_id) evidence.push(`resolved_by=${result.resolved_by_task_id}`);
  if (result?.superseded_by_task_id) evidence.push(`superseded_by=${result.superseded_by_task_id}`);
  if (result?.noop === true) evidence.push('noop=true');
  if (result?.resolved_legacy === true) evidence.push('resolved_legacy=true');
  if (result?.delivery_result_recovery?.reason) evidence.push(`delivery_recovery=${result.delivery_result_recovery.reason}`);
  if (result?.integration?.status) evidence.push(`integration=${result.integration.status}`);
  if (Array.isArray(result?.changed_files) && result.changed_files.length > 0) evidence.push(`changed_files=${result.changed_files.length}`);
  if (result?.failure_class) evidence.push(`failure=${result.failure_class}`);

  return evidence.join(', ') || 'none';
}

// ---------------------------------------------------------------------------
// Deterministic convergence eligibility
// ---------------------------------------------------------------------------

/**
 * Check if a task can be deterministically converged (auto-completed) safely.
 *
 * Safe convergence criteria (ordered by specificity):
 * 1. Explicit resolution markers: noop, resolved_legacy, resolved_by, superseded_by
 * 2. Already integrated commit: commit reachable from HEAD + passing verification
 * 3. Delivery recovery: already_integrated with passing verification
 * 4. Verification normalized: canonical verification.passed + blocking_passed
 * 5. Integration already merged/skipped
 * 6. Provider-empty result shape with no failure evidence
 * 7. Has implicit successor (shared-goal completed task)
 *
 * @param {object} task - Task record
 * @param {object} indexes - Build task queue indexes
 * @returns {{ canConverge: boolean, reason: string, convergenceAction: string }}
 */
export function canDeterministicallyConverge(task, indexes) {
  if (!task) return { canConverge: false, reason: 'no task', convergenceAction: 'none' };

  const rawResult = task.result;
  const safeResult = rawResult || {};
  const status = task?.status;
  const hasNullResult = rawResult === null || rawResult === undefined;
  const resultShape = classifyResultShape(rawResult);

  // Empty tasks cannot be meaningfully processed
  if (!status) return { canConverge: false, reason: 'no status', convergenceAction: 'none' };

  // --- 1. Explicit resolution markers ---
  if (safeResult?.noop === true) {
    return { canConverge: true, reason: 'noop=true marker', convergenceAction: 'complete_task' };
  }
  if (safeResult?.resolved_legacy === true) {
    return { canConverge: true, reason: 'resolved_legacy=true marker', convergenceAction: 'complete_task' };
  }
  if (safeResult?.resolved_by_task_id) {
    return { canConverge: true, reason: `resolved_by_task_id=${safeResult.resolved_by_task_id}`, convergenceAction: 'complete_task' };
  }
  if (safeResult?.superseded_by_task_id) {
    return { canConverge: true, reason: `superseded_by_task_id=${safeResult.superseded_by_task_id}`, convergenceAction: 'complete_task' };
  }

  // --- 2. Already integrated commit ---
  if (safeResult?.commit) {
    const verificationPassed = safeResult?.verification?.passed === true || Boolean(safeResult?.tests);
    if (verificationPassed) {
      const commitReachable = isCommitAncestorOfHead(safeResult.commit, safeResult?.execution_cwd);
      if (commitReachable) {
        return { canConverge: true, reason: `commit ${safeResult.commit.slice(0, 7)} reachable from HEAD + verification passed`, convergenceAction: 'complete_task' };
      }
    }
  }

  // --- 3. Delivery recovery: already_integrated ---
  const deliveryRecovery = safeResult?.delivery_result_recovery;
  if (deliveryRecovery?.reason === 'already_integrated' && deliveryRecovery?.recovered === true) {
    return { canConverge: true, reason: 'delivery_recovery: already_integrated', convergenceAction: 'complete_task' };
  }

  // --- 4. Verification normalized ---
  if (isVerificationNormalized(safeResult)) {
    return { canConverge: true, reason: 'verification normalized (passed + blocking_passed)', convergenceAction: 'complete_task' };
  }

  // --- 5. Integration already merged/skipped ---
  if (safeResult?.integration) {
    const mergedStates = ['merged', 'ff_only_merged', 'already_integrated', 'skipped', 'not_required'];
    if (mergedStates.includes(String(safeResult.integration.status))) {
      return { canConverge: true, reason: `integration status=${safeResult.integration.status}`, convergenceAction: 'complete_task' };
    }
  }

  // --- 6. Provider-empty shape with no failure evidence ---
  // Guard: do not converge pending/review/repair tasks based on null result alone.
  // Those statuses mean the system has explicitly placed the task in a wait state.
  const pendingNonConvergeStatuses = new Set([
    TASK_STATUSES.WAITING_FOR_REVIEW,
    TASK_STATUSES.WAITING_FOR_REPAIR,
    TASK_STATUSES.WAITING_FOR_INTEGRATION,
    ...TYPED_REVIEW_STATES,
  ]);
  if (!pendingNonConvergeStatuses.has(status) && hasNullResult) {
    return { canConverge: true, reason: 'provider-empty: null result — no provider output', convergenceAction: 'complete_task' };
  }
  if (!pendingNonConvergeStatuses.has(status) && PROVIDER_EMPTY_SHAPES.has(resultShape)) {
    const resSummary = safeResult?.verification || {};
    const hasFailureEvidence = resSummary?.passed === false || safeResult?.failure_class === 'verification_failed';
    if (!hasFailureEvidence) {
      return { canConverge: true, reason: `provider-empty result shape (${resultShape})`, convergenceAction: 'complete_task' };
    }
  }

  // --- 7. Has implicit successor (completed task for same goal) ---
  if (hasImplicitSuccessor(task, indexes)) {
    return { canConverge: true, reason: 'has implicit successor task', convergenceAction: 'complete_task' };
  }

  return { canConverge: false, reason: 'no safe convergence evidence', convergenceAction: 'none' };
}

// ---------------------------------------------------------------------------
// Main manifest generator
// ---------------------------------------------------------------------------

/**
 * Generate a precise manifest of current blockers.
 *
 * @param {object} store - StateStore instance
 * @param {object} [options]
 * @param {boolean} [options.verbose=false] - Include full task details
 * @returns {Promise<{
 *   manifest: Array<object>,
 *   beforeCounts: object,
 *   afterCounts: object | null,
 *   categories: object,
 *   converged: Array<object> | null,
 * }>}
 */
export async function generateBlockerManifest(store, { verbose = false } = {}) {
  const state = await store.load();
  const tasks = state.tasks || [];

  // Build indexes for successor detection
  const indexes = buildTaskQueueIndexes(tasks);

  // Get queue counts
  const queueCounts = await collectWorkerQueueCounts(store);

  // Find all current blockers
  const manifest = [];
  const categoryCounts = {};

  for (const task of tasks) {
    if (task.assignee !== 'codex') continue;
    const decision = classifyCurrentBlockerTask(task);
    if (!decision.blocks_current_work) continue;

    const category = classifyBlockerManifestCategory(task, decision, indexes);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    manifest.push({
      task_id: task.id || 'unknown',
      goal_id: task.goal_id || '',
      title: (task.title || task.summary || 'untitled').slice(0, 80),
      status: task.status,
      decision_label: decision.label,
      result_shape: decision.result_shape,
      category,
      reason: inferBlockerReason(task, decision, category),
      evidence: summarizeEvidence(task),
      can_converge: category === MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      created_at: task.created_at,
      updated_at: task.updated_at,
    });
  }

  return {
    manifest,
    beforeCounts: {
      current_blockers: queueCounts.current_blockers,
      ...queueCounts.policy_counts,
    },
    afterCounts: null,
    categories: categoryCounts,
    converged: null,
  };
}

function inferBlockerReason(task, decision, category) {
  const status = task?.status || 'unknown';
  const result = task?.result || {};

  if (category === MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE) {
    if (result?.noop) return 'Task marked as no-op — safe to complete';
    if (result?.resolved_legacy) return 'Task marked as resolved legacy — safe to complete';
    if (result?.resolved_by_task_id) return `Resolved by ${result.resolved_by_task_id}`;
    if (result?.superseded_by_task_id) return `Superseded by ${result.superseded_by_task_id}`;
    if (decision.label === CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY) return 'Provider-empty result — no real output to review';
    if (decision.label === CURRENT_WORK_DECISION_LABELS.COMPLETED) return 'Labeled completed but blocking — stale state';
    return 'Deterministic convergence evidence exists';
  }

  if (category === MANIFEST_CATEGORIES.DETERMINISTIC_REPAIR_NEEDED) {
    return `Status=${status}: requires deterministic repair loop`;
  }

  if (category === MANIFEST_CATEGORIES.EXTERNAL_WAIT) {
    return 'Waiting for integration (git push / PR merge) — external dependency';
  }

  if (category === MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW) {
    return 'Requires human judgment or decision';
  }

  if (category === MANIFEST_CATEGORIES.UNRESOLVED_FAILURE) {
    if (decision.label === CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE) return 'Verification failure with real evidence';
    if (decision.label === CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE) return 'Code change failure with real evidence';
    return 'Unresolved failure with evidence';
  }

  return `Status=${status}, label=${decision.label}`;
}

// ---------------------------------------------------------------------------
// Deterministic convergence application
// ---------------------------------------------------------------------------

/**
 * Apply deterministic convergence to current blockers where safe.
 *
 * @param {object} store - StateStore instance
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, only report without mutating
 * @returns {Promise<{
 *   manifest: Array<object>,
 *   beforeCounts: object,
 *   afterCounts: object,
 *   categories: object,
 *   converged: Array<object>,
 *   dryRun: boolean,
 * }>}
 */
export async function applyDeterministicConvergence(store, { dryRun = false } = {}) {
  const state = await store.load();
  const tasks = state.tasks || [];
  const indexes = buildTaskQueueIndexes(tasks);

  // Generate baseline manifest
  const baseline = await generateBlockerManifest(store, { verbose: false });

  // Find auto-converge candidates
  const converged = [];
  const preserveTasks = [];

  for (const entry of baseline.manifest) {
    if (entry.category === MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE) {
      const task = tasks.find(t => t.id === entry.task_id);
      if (task) {
        const convergeCheck = canDeterministicallyConverge(task, indexes);
        if (convergeCheck.canConverge) {
          converged.push({
            task_id: entry.task_id,
            title: entry.title,
            status: entry.status,
            reason: convergeCheck.reason,
            evidence: entry.evidence,
          });
          continue;
        }
      }
    }
    preserveTasks.push(entry);
  }

  // Apply convergence (unless dry run)
  if (!dryRun && converged.length > 0) {
    const sweepActions = converged.map(c => ({
      taskId: c.task_id,
      currentStatus: state.tasks.find(t => t.id === c.task_id)?.status || 'unknown',
      recommendedStatus: TASK_STATUSES.COMPLETED,
      reason: `[MA11-R6] Deterministic convergence: ${c.reason}`,
      actions: [{ type: 'update_task_status', payload: { status: TASK_STATUSES.COMPLETED } }],
    }));

    await store.mutate(state => {
      for (const action of sweepActions) {
        const taskIdx = (state.tasks || []).findIndex(t => t && t.id === action.taskId);
        if (taskIdx === -1) continue;
        const task = state.tasks[taskIdx];
        Object.assign(task, { status: action.recommendedStatus });
        task.updated_at = new Date().toISOString();
        task.converged_at = task.updated_at;
        task.ma11_convergence = task.ma11_convergence || {};
        task.ma11_convergence.r6_converged = true;
        task.ma11_convergence.r6_reason = action.reason;
        if (!Array.isArray(task.logs)) task.logs = [];
        task.logs.push({
          time: task.updated_at,
          message: `[MA11-R6] ${action.reason}`,
        });
      }
      return state;
    });
  }

  // Generate after counts
  const afterCounts = await collectWorkerQueueCounts(store);

  return {
    manifest: preserveTasks,
    beforeCounts: baseline.beforeCounts,
    afterCounts: {
      current_blockers: afterCounts.current_blockers,
      ...afterCounts.policy_counts,
    },
    categories: baseline.categories,
    converged,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Formatted output
// ---------------------------------------------------------------------------

/**
 * Print a human-readable manifest table.
 * @param {object} result - Result from generateBlockerManifest or applyDeterministicConvergence
 * @returns {string} Formatted table
 */
export function printManifest(result) {
  const lines = [];
  const sep = '─'.repeat(90);

  if (result.dryRun !== undefined) {
    lines.push(`🔥 MA11-R6 Blocker Manifest (${result.dryRun ? 'DRY RUN' : 'CONVERGED'})`);
  } else {
    lines.push('🔥 MA11-R6 Current Blocker Manifest');
  }
  lines.push(sep);

  const before = result.beforeCounts || {};
  lines.push(`Total current_blockers: ${before.current_blockers || 0}`);
  if (result.afterCounts) {
    const after = result.afterCounts;
    const diff = (before.current_blockers || 0) - (after.current_blockers || 0);
    lines.push(`After convergence:      ${after.current_blockers || 0} (Δ=${diff})`);
  }
  lines.push(sep);

  // Category breakdown
  lines.push('Categories:');
  const cats = result.categories || {};
  for (const [cat, count] of Object.entries(cats)) {
    lines.push(`  ${cat}: ${count}`);
  }
  lines.push(sep);

  // Table header
  lines.push('Task ID                          | Category                   | Status                 | Decision            | Evidence');
  lines.push('─'.repeat(105));

  // Individual entries
  for (const entry of result.manifest || []) {
    const taskId = (entry.task_id || '').slice(0, 34).padEnd(34);
    const cat = (entry.category || '').padEnd(26);
    const status = (entry.status || '').padEnd(22);
    const decision = (entry.decision_label || '').padEnd(18);
    const evidence = (entry.evidence || 'none').slice(0, 30);
    lines.push(`${taskId} | ${cat} | ${status} | ${decision} | ${evidence}`);
  }

  // Converged items
  if (result.converged && result.converged.length > 0) {
    lines.push(sep);
    lines.push(`✅ Converged (${result.converged.length} item(s)):`);
    for (const c of result.converged) {
      lines.push(`  ${c.task_id} — ${c.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Print abbreviated queue summary line.
 */
export function printQueueSummary(result) {
  const before = result.beforeCounts || {};
  const parts = [`current_blockers=${before.current_blockers}`];

  if (result.afterCounts) {
    const after = result.afterCounts;
    const diff = (before.current_blockers || 0) - (after.current_blockers || 0);
    parts.push(`→ after=${after.current_blockers} (Δ=${diff >= 0 ? '-' : ''}${diff})`);
  }

  const cats = result.categories || {};
  for (const [cat, count] of Object.entries(cats)) {
    parts.push(`${cat}=${count}`);
  }

  return 'Queue: ' + parts.join(', ');
}

// ---------------------------------------------------------------------------
// CLI entry point for standalone execution
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('--dry');
  const verbose = args.includes('--verbose') || args.includes('-v');

  const statePath = process.env.STATE_PATH || './backend/data/workspaces/default/.gptwork/state.json';
  const { StateStore } = await import('./state-store.mjs');

  let store;
  try {
    store = new StateStore({ statePath });
    await store.load();
  } catch (err) {
    console.error(`[MA11-R6] Warning: could not load state from ${statePath}`);
    console.error(`[MA11-R6] ${err.message}`);
    console.error(`[MA11-R6] Note: state stores are managed by the runtime process.`);
    console.error(`[MA11-R6] This script is designed to be called by the runtime.`);
    process.exit(1);
  }

  if (dryRun) {
    console.error(`[MA11-R6] DRY RUN — no state mutations will be made`);
    const manifest = await generateBlockerManifest(store, { verbose });
    console.log('\n' + printManifest({
      ...manifest,
      dryRun: true,
    }));
    console.log('\n' + printQueueSummary({ ...manifest, dryRun: true }));
  } else {
    console.error(`[MA11-R6] Applying deterministic convergence...`);
    const result = await applyDeterministicConvergence(store, { dryRun: false });
    console.log('\n' + printManifest(result));
    console.log('\n' + printQueueSummary(result));
  }
}

export {
  MANIFEST_CATEGORIES,
  PROVIDER_EMPTY_SHAPES,
};

if (process.argv[1] && (process.argv[1].endsWith('blocker-manifest.mjs') || process.argv[1].endsWith('blocker-manifest'))) {
  main().catch(err => {
    console.error(`[MA11-R6] Fatal: ${err.message}`);
    process.exit(1);
  });
}
