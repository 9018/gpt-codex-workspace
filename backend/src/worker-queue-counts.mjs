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

const WORKER_QUEUE_COUNTS_CACHE_KEY = "worker_queue_counts";

function isNonActionableHistoricalTask(task) {
  if (task?.retention_compacted === true || task?.historical_import === true) return true;
  const imported = task?.created_by === "github-import"
    || task?.source === "github"
    || task?.source_type === "github-import";
  return imported && task?.auto_advance !== true;
}

function emptyQueueAges() {
  return Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((status) => [status, 0]));
}

function taskTimestamp(task) {
  const ts = Date.parse(task.created_at || task.updated_at || "");
  return Number.isFinite(ts) ? ts : null;
}

function computeOldestTimestamps(tasks = []) {
  const oldestTs = Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((status) => [status, null]));
  for (const task of tasks || []) {
    if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
    const ts = taskTimestamp(task);
    if (ts == null) continue;
    if (oldestTs[task.status] == null || ts < oldestTs[task.status]) oldestTs[task.status] = ts;
  }
  return oldestTs;
}

function computeOldestAgesFromTimestamps(oldestTs = {}, now = Date.now()) {
  const ages = emptyQueueAges();
  for (const [status, ts] of Object.entries({ ...Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((key) => [key, null])), ...(oldestTs || {}) })) {
    ages[status] = ts == null ? 0 : Math.max(0, now - ts);
  }
  return ages;
}

function computeOldestAges(tasks = [], now = Date.now()) {
  return computeOldestAgesFromTimestamps(computeOldestTimestamps(tasks), now);
}

function addToSetMap(map, key, value) {
  if (!key) return;
  const normalizedKey = String(key);
  const values = map.get(normalizedKey) || new Set();
  values.add(value);
  map.set(normalizedKey, values);
}

function addRefsToSet(map, refs = [], value) {
  for (const ref of refs || []) addToSetMap(map, ref, value);
}

function taskDirectRelationRefs(task = {}) {
  return [task.parent_task_id, task.root_task_id, task.repair_of_task_id].filter(Boolean);
}

/**
 * Build one-pass lookup structures used by queue policy decisions.
 * Successor indexes only include completed Codex tasks with completion
 * evidence, preserving the historical implicit-successor semantics.
 */
export function buildTaskQueueIndexes(tasks = []) {
  const indexes = {
    tasksById: new Map(),
    completedWithEvidenceByGoalId: new Map(),
    completedRelationRefs: new Map(),
    completedDirectRelationRefs: new Map(),
    completedFullRelationRefs: new Map(),
    resolvedByTaskIds: new Set(),
    supersededByTaskIds: new Set(),
    relationsByTaskId: new Map(),
  };

  for (const task of tasks || []) {
    if (!task || typeof task !== "object") continue;
    if (task.id) indexes.tasksById.set(task.id, task);

    const relationIds = taskRelationIds(task);
    if (task.id) indexes.relationsByTaskId.set(task.id, relationIds);

    for (const ref of [task.resolved_by_task_id, task.result?.resolved_by_task_id].filter(Boolean)) {
      indexes.resolvedByTaskIds.add(ref);
    }
    for (const ref of [task.superseded_by_task_id, task.result?.superseded_by_task_id].filter(Boolean)) {
      indexes.supersededByTaskIds.add(ref);
    }

    if (task.assignee !== "codex") continue;
    if (task.status !== TASK_STATUSES.COMPLETED) continue;
    if (!hasCompletionEvidence(task.result || {})) continue;

    addToSetMap(indexes.completedWithEvidenceByGoalId, task.goal_id, task.id);
    addRefsToSet(indexes.completedDirectRelationRefs, taskDirectRelationRefs(task), task.id);
    addRefsToSet(indexes.completedFullRelationRefs, relationIds, task.id);
    addRefsToSet(indexes.completedRelationRefs, taskDirectRelationRefs(task), task.id);
    addRefsToSet(indexes.completedRelationRefs, relationIds, task.id);
  }

  return indexes;
}

/**
 * Check if a failed/timed_out task has been implicitly resolved by a later
 * completed task that carries completion evidence and references the
 * original task through task-ID, result, or shared-goal relationships.
 */
export function hasImplicitSuccessor(failedTask, indexes = buildTaskQueueIndexes([])) {
  if (!failedTask || !failedTask.id) return false;
  const taskIndexes = Array.isArray(indexes) ? buildTaskQueueIndexes(indexes) : indexes || buildTaskQueueIndexes([]);
  const failedTaskIds = taskIndexes.relationsByTaskId?.get(failedTask.id) || taskRelationIds(failedTask);

  // 1) Direct task-ID-based references (successor's parent/root/repair
  //    matches any of failed task's own IDs, root IDs, etc.)
  if (failedTaskIds.size > 0) {
    for (const ref of failedTaskIds) {
      const successorIds = taskIndexes.completedDirectRelationRefs?.get(ref);
      if (successorIds) {
        for (const successorId of successorIds) {
          if (successorId !== failedTask.id) return true;
        }
      }
    }

    // 2) Successor's full task relation set (including result.repair etc.)
    //    references the failed task's ID.
    const successorIds = taskIndexes.completedFullRelationRefs?.get(failedTask.id);
    if (successorIds) {
      for (const successorId of successorIds) {
        if (successorId !== failedTask.id) return true;
      }
    }
  }

  // 3) Shared goal_id: both tasks serve the same goal, so a completed task
  //    with evidence implicitly resolves earlier failures for that goal.
  if (failedTask.goal_id) {
    const successorIds = taskIndexes.completedWithEvidenceByGoalId?.get(failedTask.goal_id);
    if (successorIds) {
      for (const successorId of successorIds) {
        if (successorId !== failedTask.id) return true;
      }
    }
  }
  return false;
}

function currentWorkDecision(task, indexes = buildTaskQueueIndexes([])) {
  const decision = classifyCurrentBlockerTask(task);
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return decision;
  if (hasImplicitSuccessor(task, indexes)) return { ...decision, blocks_current_work: false };
  return decision;
}

export function policyCurrentWorkDecision(task, indexes = buildTaskQueueIndexes([])) {
  const decision = currentWorkDecision(task, indexes);
  if (isNonActionableHistoricalTask(task)) return { ...decision, blocks_current_work: false };
  if (task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT) {
    if (isResolvedLegacyTerminalTask(task)) return { ...decision, blocks_current_work: false };
    if (hasImplicitSuccessor(task, indexes)) return { ...decision, blocks_current_work: false };
  }
  return decision;
}

function isFailedCurrentWorkTask(task, indexes = buildTaskQueueIndexes([])) {
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return false;
  return policyCurrentWorkDecision(task, indexes).blocks_current_work === true;
}

export function isPolicyCurrentBlockerTask(task, indexes = buildTaskQueueIndexes([])) {
  if (task?.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) return false;
  if (task.status === TASK_STATUSES.COMPLETED) return false;
  return policyCurrentWorkDecision(task, indexes).blocks_current_work === true;
}

function isResolvedLegacyFailedTask(task, indexes = buildTaskQueueIndexes([])) {
  if (!(task?.status === TASK_STATUSES.FAILED || task?.status === TASK_STATUSES.TIMED_OUT)) return false;
  return !isFailedCurrentWorkTask(task, indexes);
}

export function computePolicyQueueCounts(tasks = [], indexes = buildTaskQueueIndexes(tasks)) {
  const counts = { ...EMPTY_QUEUE_COUNTS };
  for (const task of tasks || []) {
    if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
    if (task.status === TASK_STATUSES.COMPLETED) {
      counts[task.status] += 1;
      continue;
    }
    if (task.status === TASK_STATUSES.FAILED) {
      if (isFailedCurrentWorkTask(task, indexes)) counts.failed += 1;
      continue;
    }
    if (isPolicyCurrentBlockerTask(task, indexes)) counts[task.status] += 1;
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

  // P0-UA5: Compute raw_legacy_resolved, raw_unresolved, policy_excluded
  const rawLegacyResolved = legacy_failed_policy
    ? (legacy_failed_policy.resolved_legacy_failed || 0) + (legacy_failed_policy.resolved_legacy_review || 0)
    : 0;
  const rawUnresolved = legacy_failed_policy
    ? (legacy_failed_policy.unresolved_failed || 0) +
      (normalizedPolicyCounts.waiting_for_lock || 0) +
      (normalizedPolicyCounts.waiting_for_review || 0) +
      (normalizedPolicyCounts.waiting_for_repair || 0) +
      (normalizedPolicyCounts.waiting_for_integration || 0)
    : 0;

  // policy_excluded = raw non-terminal/completed count minus policy-blocking count
  let rawNonTerminalTotal = 0;
  for (const [st, count] of Object.entries(normalizedRawCounts)) {
    if (st === TASK_STATUSES.COMPLETED) continue;
    if (st === TASK_STATUSES.FAILED && legacy_failed_policy) {
      rawNonTerminalTotal += count;
      continue;
    }
    if (st && !Array.isArray(count)) rawNonTerminalTotal += count;
  }
  const policyBlockingTotal = current_blockers;
  const policyExcluded = Math.max(0, rawNonTerminalTotal - policyBlockingTotal);

  return {
    ...normalizedPolicyCounts,
    raw_counts: normalizedRawCounts,
    policy_counts: normalizedPolicyCounts,
    actionable_review,
    current_blockers,
    raw_legacy_resolved: rawLegacyResolved,
    raw_unresolved: rawUnresolved,
    policy_excluded: policyExcluded,
    policy_excluded_count: policyExcluded,
    legacy_failed_policy,
    oldest_age_ms,
  };
}

function legacyFailedPolicySummary(tasks = [], indexes = buildTaskQueueIndexes(tasks)) {
  const counts = { ...EMPTY_LEGACY_COUNTS };

  for (const task of tasks || []) {
    if (task.assignee !== "codex") continue;
    if (isResolvedLegacyFailedTask(task, indexes)) {
      counts.resolved_legacy_failed += 1;
    } else if (isFailedCurrentWorkTask(task, indexes)) {
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

function computeIndexedRawQueueCounts(store) {
  const q = store.getCodexTaskQueue();
  const rawCounts = { ...EMPTY_QUEUE_COUNTS };
  for (const st of Object.keys(EMPTY_QUEUE_COUNTS)) {
    if (q?.counts?.[st] !== undefined) rawCounts[st] = q.counts[st];
  }
  return rawCounts;
}

function buildWorkerQueueDerivedSnapshot(store, tasks = []) {
  const indexes = buildTaskQueueIndexes(tasks);
  const oldest_timestamps = computeOldestTimestamps(tasks);
  const legacy_failed_policy = legacyFailedPolicySummary(tasks, indexes);
  const policyCounts = computePolicyQueueCounts(tasks, indexes);
  const rawCounts = typeof store.getCodexTaskQueue === "function"
    ? computeIndexedRawQueueCounts(store)
    : computeRawQueueCounts(tasks);
  return { rawCounts, policyCounts, legacy_failed_policy, oldest_timestamps };
}

function getWorkerQueueDerivedSnapshot(store, tasks = []) {
  const build = () => buildWorkerQueueDerivedSnapshot(store, tasks);
  if (typeof store.getOrBuildDerived === "function") {
    return store.getOrBuildDerived(WORKER_QUEUE_COUNTS_CACHE_KEY, build);
  }
  return build();
}

export async function collectWorkerQueueCounts(store) {
  try {
    const state = await store.load();
    const derived = getWorkerQueueDerivedSnapshot(store, state.tasks || []);
    const oldest_age_ms = computeOldestAgesFromTimestamps(derived.oldest_timestamps);
    return buildQueueResult({
      rawCounts: derived.rawCounts,
      policyCounts: derived.policyCounts,
      legacy_failed_policy: derived.legacy_failed_policy,
      oldest_age_ms,
    });
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
