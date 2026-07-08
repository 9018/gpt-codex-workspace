/**
 * review-tools-group.mjs — Lightweight actionable review query tools.
 *
 * Provides a dedicated tool (list_actionable_reviews) that ChatGPT can call
 * in one invocation to learn which reviews currently block automatic progress,
 * without pulling large historical review records.
 *
 * This is the primary ChatGPT entrypoint for questions like
 * "what are the current reviews?" and avoids forcing large list_tasks calls.
 *
 * Default: only current actionable reviews.
 * Optional flag: include_historical=true also returns legacy resolved items.
 *
 * The query is read-only and avoids runtime/repo lock paths.
 */

import { TASK_STATUSES } from '../task-status-taxonomy.mjs';
import { REVIEW_STATE_META } from '../task-review-status-taxonomy.mjs';
import { REVIEW_STATES } from '../task-review-status-taxonomy.mjs';
import { buildTaskQueueIndexes, hasImplicitSuccessor } from '../worker-queue-counts.mjs';
import { classifyCurrentBlockerTask } from '../current-blocker-policy.mjs';
import { isResolvedLegacyReviewTask } from '../legacy-reconciliation.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All review-related statuses this tool scans. */
const REVIEW_RELATED_STATUSES = new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.TIMED_OUT,
  TASK_STATUSES.WAITING_FOR_LOCK,
  ...Object.values(REVIEW_STATES),
]);

const MAX_ITEMS_DEFAULT = 50;

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Scan all Codex tasks and classify them as current actionable reviews,
 * historical resolved reviews, or other non-blocking items.
 *
 * Uses the existing classifyCurrentBlockerTask policy directly to determine
 * whether each review-state task is a current blocker or resolved/historical.
 *
 * @param {object} store - StateStore instance
 * @param {object} [options]
 * @param {boolean} [options.include_historical=false] - Include legacy/historical review items
 * @param {number} [options.max_items=50] - Max items to return before truncation
 * @returns {Promise<object>} Compact review query result
 */
export async function collectActionableReviews(store, { include_historical = false, max_items = MAX_ITEMS_DEFAULT } = {}) {
  const state = await store.load();
  const tasks = state.tasks || [];
  const indexes = buildTaskQueueIndexes(tasks);

  // Filter to Codex tasks with review-related statuses
  const reviewTasks = tasks.filter(t => {
    if (!t || typeof t !== 'object') return false;
    if (t.assignee !== 'codex') return false;
    return REVIEW_RELATED_STATUSES.has(t.status);
  });

  // Classify each review task
  const currentReviews = [];
  const historicalReviews = [];
  const excludedOther = [];

  for (const task of reviewTasks) {
    const decision = classifyCurrentBlockerTask(task);
    const isLegacyResolved = isResolvedLegacyReviewTask(task);

    const hasSuccessor = (task.status === TASK_STATUSES.FAILED || task.status === TASK_STATUSES.TIMED_OUT)
      ? hasImplicitSuccessor(task, indexes)
      : false;

    if (isLegacyResolved || hasSuccessor) {
      historicalReviews.push(buildReviewItem(task, decision, { is_resolved: true }));
    } else {
      currentReviews.push(buildReviewItem(task, decision));
    }
  }

  // Sort current reviews by priority: human_required first, then by recency
  currentReviews.sort(sortReviewItems);
  historicalReviews.sort(sortReviewItems);

  // Apply truncation
  let truncated = false;
  let currentDisplay = currentReviews;
  if (currentDisplay.length > max_items) {
    currentDisplay = currentDisplay.slice(0, max_items);
    truncated = true;
  }

  let historicalDisplay = historicalReviews;
  if (include_historical && historicalDisplay.length > max_items) {
    historicalDisplay = historicalDisplay.slice(0, max_items);
    truncated = true;
  }

  return {
    scanned_at: new Date().toISOString(),
    summary: buildSummary(currentReviews.length, historicalReviews.length, excludedOther.length),
    counts: {
      current_actionable_reviews: currentReviews.length,
      historical_resolved_reviews: historicalReviews.length,
      excluded_by_policy: excludedOther.length,
      total_codex_review_tasks: reviewTasks.length,
    },
    current_reviews: currentDisplay,
    historical_reviews: include_historical ? historicalDisplay : undefined,
    truncated,
    _meta: {
      query: {
        include_historical,
        max_items,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Review item builder
// ---------------------------------------------------------------------------

/**
 * Build a compact review item from a task record and its policy decision.
 */
function buildReviewItem(task, decision, { is_resolved = false } = {}) {
  const result = task.result || {};
  const acceptanceFindings = Array.isArray(result.acceptance_findings) ? result.acceptance_findings : [];
  const contractVerification = result.contract_verification || {};

  const blockerCodes = [
    ...acceptanceFindings
      .filter(f => f.severity === 'blocker' || f.severity === 'major')
      .map(f => f.code || 'unknown'),
    ...(Array.isArray(contractVerification.blockers) ? contractVerification.blockers.map(b => b.code || 'unknown') : []),
  ].filter(Boolean);

  const shortReason = reasonForStatus(task.status, result);
  const nextAction = recommendedAction(task.status, decision);
  const safeToAdvance = isReviewSafeToAdvance(task.status, decision);
  const resolvedByTaskId = result.resolved_by_task_id || null;
  const supersededByTaskId = result.superseded_by_task_id || null;

  return {
    task_id: task.id,
    goal_id: task.goal_id || null,
    title: task.title || 'untitled',
    status: task.status,
    short_reason: shortReason,
    blocker_codes: blockerCodes,
    recommended_next_action: nextAction,
    safe_to_advance: safeToAdvance,
    resolved_by_task_id: resolvedByTaskId,
    superseded_by_task_id: supersededByTaskId,
    is_resolved: is_resolved || Boolean(resolvedByTaskId || supersededByTaskId),
    created_at: task.created_at || null,
    updated_at: task.updated_at || null,
  };
}

function reasonForStatus(status, result = {}) {
  const meta = REVIEW_STATE_META[status];
  if (meta) {
    const label = meta.label || status;
    if (meta.machine_repairable) {
      return `${label} — machine repairable`;
    }
    return `${label} — requires human judgment`;
  }

  switch (status) {
    case TASK_STATUSES.WAITING_FOR_REVIEW:
      return 'Waiting for review — blocking findings or missing evidence';
    case TASK_STATUSES.WAITING_FOR_REPAIR:
      return 'Waiting for repair — auto-repair needed';
    case TASK_STATUSES.WAITING_FOR_INTEGRATION:
      return 'Waiting for integration — commit or merge pending';
    case TASK_STATUSES.FAILED:
      return 'Task failed — needs triage';
    case TASK_STATUSES.TIMED_OUT:
      return 'Task timed out — needs triage';
    default:
      return `Status: ${status}`;
  }
}

function recommendedAction(status, decision) {
  const meta = REVIEW_STATE_META[status];
  if (meta) {
    return meta.next_action || 'manual_review';
  }

  switch (status) {
    case TASK_STATUSES.WAITING_FOR_REVIEW:
      return decision.blocks_current_work ? 'manual_review' : 'auto_resolve';
    case TASK_STATUSES.WAITING_FOR_REPAIR:
      return 'auto_repair';
    case TASK_STATUSES.WAITING_FOR_INTEGRATION:
      return 'auto_integrate';
    case TASK_STATUSES.FAILED:
    case TASK_STATUSES.TIMED_OUT:
      return 'triage_failure';
    default:
      return 'inspect';
  }
}

function isReviewSafeToAdvance(status, decision) {
  if (REVIEW_STATE_META[status]) {
    return REVIEW_STATE_META[status].machine_repairable;
  }

  switch (status) {
    case TASK_STATUSES.WAITING_FOR_REVIEW:
      return !decision.blocks_current_work;
    case TASK_STATUSES.WAITING_FOR_REPAIR:
      return true;
    case TASK_STATUSES.WAITING_FOR_INTEGRATION:
      return true;
    case TASK_STATUSES.FAILED:
    case TASK_STATUSES.TIMED_OUT:
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Sorting and summary
// ---------------------------------------------------------------------------

function sortReviewItems(a, b) {
  const aSafe = a.safe_to_advance ? 1 : 0;
  const bSafe = b.safe_to_advance ? 1 : 0;
  if (aSafe !== bSafe) return aSafe - bSafe;

  const aUpdated = Date.parse(a.updated_at || a.created_at || 0);
  const bUpdated = Date.parse(b.updated_at || b.created_at || 0);
  return bUpdated - aUpdated;
}

function buildSummary(current, historical, excluded) {
  const parts = [];
  parts.push(`${current} current actionable review${current !== 1 ? 's' : ''}`);
  if (historical > 0) {
    parts.push(`${historical} historical resolved`);
  }
  if (excluded > 0) {
    parts.push(`${excluded} excluded`);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Tool group factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {Function} deps.tool — MCP tool factory from tool-registry.mjs
 * @param {Function} deps.schema — schema factory from mcp-tooling.mjs
 * @param {object}   deps.store — StateStore instance
 * @param {object}   deps.config — Runtime config
 */
export function createReviewToolsGroup({ tool, schema, store, config } = {}) {
  return {
    list_actionable_reviews: tool({
      name: 'list_actionable_reviews',
      description: 'List current actionable reviews that block automatic progress. Default: only current blockers, no historical resolved items. Optionally include historical/legacy resolved reviews with include_historical=true. Compact output with counts per category suitable for ChatGPT reasoning.',
      inputSchema: schema({
        include_historical: {
          type: 'boolean',
          description: 'Include legacy/historical resolved review items in the result. Default: false.',
          default: false,
        },
        max_items: {
          type: 'integer',
          description: 'Maximum number of items to return per category (current + historical). Default: 50.',
          minimum: 1,
          maximum: 200,
          default: 50,
        },
      }),
      modes: ['standard', 'codex', 'operator', 'full'],
      audience: ['chatgpt', 'codex', 'operator'],
      tags: ['review', 'blockers', 'dashboard'],
      outputTemplate: 'ui://widget/gptwork-tool-card-v5.html',
      resourceUri: 'ui://widget/gptwork-tool-card-v5.html',
      handler: async ({ include_historical, max_items } = {}) => {
        return collectActionableReviews(store, {
          include_historical: include_historical === true,
          max_items: Number.isFinite(max_items) ? Math.min(Math.max(1, max_items), 200) : MAX_ITEMS_DEFAULT,
        });
      },
    }),
  };
}
