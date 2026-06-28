import { isResolvedLegacyReviewTask, isResolvedLegacyTerminalTask, hasCompletionEvidence, taskRelationIds } from "./legacy-reconciliation.mjs";

const EMPTY_QUEUE_COUNTS = {
  assigned: 0,
  queued: 0,
  running: 0,
  waiting_for_lock: 0,
  waiting_for_review: 0,
  waiting_for_integration: 0,
  completed: 0,
  failed: 0,
};

const EMPTY_LEGACY_COUNTS = {
  resolved_legacy_failed: 0,
  unresolved_failed: 0,
  resolved_legacy_review: 0,
};

const COUNTED_STATUSES = new Set(Object.keys(EMPTY_QUEUE_COUNTS));

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
    if (task.status !== "completed") continue;
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

function legacyFailedPolicySummary(tasks = []) {
  const counts = { ...EMPTY_LEGACY_COUNTS };
  const unresolvedTasks = [];

  for (const task of tasks || []) {
    if (task.assignee !== "codex") continue;
    if (isResolvedLegacyTerminalTask(task)) {
      counts.resolved_legacy_failed += 1;
    } else if (task.status === "failed" || task.status === "timed_out") {
      unresolvedTasks.push(task);
    }
    if (isResolvedLegacyReviewTask(task)) counts.resolved_legacy_review += 1;
  }

  for (const task of unresolvedTasks) {
    if (hasImplicitSuccessor(task, tasks)) {
      counts.resolved_legacy_failed += 1;
    } else {
      counts.unresolved_failed += 1;
    }
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
    const counts = { ...EMPTY_QUEUE_COUNTS };
    const oldest_age_ms = computeOldestAges(state.tasks || []);
    const legacy_failed_policy = legacyFailedPolicySummary(state.tasks || []);
    // Prefer indexed lookup when available (O(1) per status)
    if (typeof store.getCodexTaskQueue === "function") {
      const q = store.getCodexTaskQueue();
      for (const st of Object.keys(EMPTY_QUEUE_COUNTS)) {
        if (q.counts[st] !== undefined) {
          counts[st] = q.counts[st];
        }
      }
      let resolvedCount = 0;
      for (const task of state.tasks || []) {
        if (task.assignee === "codex" && isResolvedLegacyReviewTask(task)) resolvedCount++;
      }
      counts.waiting_for_review = Math.max(0, counts.waiting_for_review - resolvedCount);
      counts.failed = Math.max(0, counts.failed - legacy_failed_policy.resolved_legacy_failed);
      return { ...counts, actionable_review: counts.waiting_for_review, legacy_failed_policy, oldest_age_ms };
    }
    for (const task of state.tasks || []) {
      if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
      if (isResolvedLegacyReviewTask(task)) continue;
      if (isResolvedLegacyTerminalTask(task)) continue;
      if ((task.status === "failed" || task.status === "timed_out") && hasImplicitSuccessor(task, state.tasks || [])) continue;
      counts[task.status] += 1;
    }
    return { ...counts, actionable_review: counts.waiting_for_review, legacy_failed_policy, oldest_age_ms };
  } catch {
    return { ...EMPTY_QUEUE_COUNTS, actionable_review: 0, legacy_failed_policy: { ...EMPTY_LEGACY_COUNTS, policy: "resolved_legacy_failed_excluded_from_current_blockers", blocks_current_work: false }, oldest_age_ms: emptyQueueAges() };
  }
}
