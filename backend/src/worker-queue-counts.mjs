import { isResolvedLegacyReviewTask, isResolvedLegacyTerminalTask, hasCompletionEvidence, taskRelationIds } from "./legacy-reconciliation.mjs";
import { classifyCurrentBlockerTask } from "./current-blocker-policy.mjs";
import { TASK_STATUSES } from "./task-status-taxonomy.mjs";

const EMPTY_QUEUE_COUNTS = {
  [TASK_STATUSES.ASSIGNED]: 0,
  [TASK_STATUSES.QUEUED]: 0,
  [TASK_STATUSES.RUNNING]: 0,
  [TASK_STATUSES.WAITING_FOR_LOCK]: 0,
  [TASK_STATUSES.WAITING_FOR_REVIEW]: 0,
  [TASK_STATUSES.WAITING_FOR_REPAIR]: 0,
  [TASK_STATUSES.WAITING_FOR_INTEGRATION]: 0,
  [TASK_STATUSES.COMPLETED]: 0,
  [TASK_STATUSES.FAILED]: 0,
};

const EMPTY_LEGACY_COUNTS = {
  resolved_legacy_failed: 0,
  unresolved_failed: 0,
  resolved_legacy_review: 0,
};

const COUNTED_STATUSES = new Set([
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.QUEUED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
]);

function emptyQueueAges() {
  return Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((status) => [status, 0]));
}

function taskTimestamp(task) {
  const ts = Date.parse(task.created_at || task.updated_at || "");
  return Number.isFinite(ts) ? ts : null;
}

function computeOldestAges(tasks = [], now = Date.now()) {
  const oldestTs = Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((status) => [status, null]));
  for (const task of tasks || []) {
    if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
    const ts = taskTimestamp(task);
    if (ts == null) continue;
    if (oldestTs[task.status] == null || ts < oldestTs[task.status]) oldestTs[task.status] = ts;
  }
  const ages = emptyQueueAges();
  for (const [status, ts] of Object.entries(oldestTs)) {
    ages[status] = ts == null ? 0 : Math.max(0, now - ts);
  }
  return ages;
}

/**
 * Check if a failed/timed_out task has been implicitly resolved by a later
 * completed task that carries completion evidence and references the
 * original task through task-ID, result, or shared-goal relationships.
 */
function hasImplicitSuccessor(failedTask, allTasks) {
  if (!failedTask || !failedTask.id) return false;
  const failedTaskIds = taskRelationIds(failedTask);

  for (const task of allTasks) {
    if (task.id === failedTask.id) continue;
    if (task.assignee !== "codex") continue;
    if (task.status !== TASK_STATUSES.COMPLETED) continue;
    if (!hasCompletionEvidence(task.result || {})) continue;

    // 1) Direct task-ID-based references (successor's parent/root/repair
    //    matches any of failed task's own IDs, root IDs, etc.)
    if (failedTaskIds.size > 0) {
      const taskRefs = new Set([task.parent_task_id, task.root_task_id, task.repair_of_task_id].filter(Boolean));
      for (const ref of taskRefs) {
        if (failedTaskIds.has(ref)) return true;
      }

      // 2) Successor's full task relation set (including result.repair etc.)
      //    references the failed task's ID
      if (taskRelationIds(task).has(failedTask.id)) return true;
    }

    // 3) Shared goal_id: both tasks serve the same goal, so a completed task
    //    with evidence implicitly resolves earlier failures for that goal.
    if (task.goal_id && task.goal_id === failedTask.goal_id) return true;
  }
  return false;
}

function currentWorkDecision(task, tasks = []) {
  const decision = classifyCurrentBlockerTask(task);
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return decision;
  if (hasImplicitSuccessor(task, tasks)) return { ...decision, blocks_current_work: false };
  return decision;
}

function isFailedCurrentWorkTask(task, tasks = []) {
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return false;
  if (isResolvedLegacyTerminalTask(task)) return false;
  return currentWorkDecision(task, tasks).blocks_current_work;
}

function isResolvedLegacyFailedTask(task, tasks = []) {
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return false;
  return !isFailedCurrentWorkTask(task, tasks);
}

function computePolicyQueueCounts(tasks = []) {
  const counts = { ...EMPTY_QUEUE_COUNTS };
  for (const task of tasks || []) {
    if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
    if (task.status === TASK_STATUSES.COMPLETED) {
      counts[task.status] += 1;
      continue;
    }
    if (task.status === TASK_STATUSES.FAILED) {
      if (isFailedCurrentWorkTask(task, tasks)) counts.failed += 1;
      continue;
    }
    if (currentWorkDecision(task, tasks).blocks_current_work) counts[task.status] += 1;
  }
  return counts;
}

function computeRawQueueCounts(tasks = []) {
  const counts = { ...EMPTY_QUEUE_COUNTS };
  for (const task of tasks || []) {
    if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
    counts[task.status] += 1;
  }
  return counts;
}

function computeCurrentBlockers(policyCounts = {}) {
  return (policyCounts[TASK_STATUSES.WAITING_FOR_LOCK] || 0)
    + (policyCounts[TASK_STATUSES.WAITING_FOR_INTEGRATION] || 0)
    + (policyCounts[TASK_STATUSES.WAITING_FOR_REPAIR] || 0)
    + (policyCounts[TASK_STATUSES.WAITING_FOR_REVIEW] || 0)
    + (policyCounts[TASK_STATUSES.FAILED] || 0);
}

function buildQueueResult({ rawCounts, policyCounts, legacy_failed_policy, oldest_age_ms }) {
  const normalizedPolicyCounts = { ...EMPTY_QUEUE_COUNTS, ...(policyCounts || {}) };
  const normalizedRawCounts = { ...EMPTY_QUEUE_COUNTS, ...(rawCounts || {}) };
  const actionable_review = normalizedPolicyCounts[TASK_STATUSES.WAITING_FOR_REVIEW] || 0;
  const current_blockers = computeCurrentBlockers(normalizedPolicyCounts);
  return {
    ...normalizedPolicyCounts,
    raw_counts: normalizedRawCounts,
    policy_counts: normalizedPolicyCounts,
    actionable_review,
    current_blockers,
    legacy_failed_policy,
    oldest_age_ms,
  };
}

function legacyFailedPolicySummary(tasks = []) {
  const counts = { ...EMPTY_LEGACY_COUNTS };

  for (const task of tasks || []) {
    if (task.assignee !== "codex") continue;
    if (isResolvedLegacyFailedTask(task, tasks)) {
      counts.resolved_legacy_failed += 1;
    } else if (isFailedCurrentWorkTask(task, tasks)) {
      counts.unresolved_failed += 1;
    }
    if (isResolvedLegacyReviewTask(task)) counts.resolved_legacy_review += 1;
  }

  return {
    policy: "resolved_legacy_failed_excluded_from_current_blockers",
    ...counts,
    blocks_current_work: counts.unresolved_failed > 0,
  };
}

export async function collectWorkerQueueCounts(store) {
  try {
    const state = await store.load();
    const oldest_age_ms = computeOldestAges(state.tasks || []);
    const legacy_failed_policy = legacyFailedPolicySummary(state.tasks || []);
    const policyCounts = computePolicyQueueCounts(state.tasks || []);
    let rawCounts = computeRawQueueCounts(state.tasks || []);
    // Prefer indexed lookup when available (O(1) per status)
    if (typeof store.getCodexTaskQueue === "function") {
      const q = store.getCodexTaskQueue();
      rawCounts = { ...EMPTY_QUEUE_COUNTS };
      for (const st of Object.keys(EMPTY_QUEUE_COUNTS)) {
        if (q?.counts?.[st] !== undefined) {
          rawCounts[st] = q.counts[st];
        }
      }
    }
    return buildQueueResult({ rawCounts, policyCounts, legacy_failed_policy, oldest_age_ms });
  } catch {
    const zeroCounts = { ...EMPTY_QUEUE_COUNTS };
    return buildQueueResult({
      rawCounts: zeroCounts,
      policyCounts: zeroCounts,
      legacy_failed_policy: { ...EMPTY_LEGACY_COUNTS, policy: "resolved_legacy_failed_excluded_from_current_blockers", blocks_current_work: false },
      oldest_age_ms: emptyQueueAges(),
    });
  }
}
