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

const COUNTED_STATUSES = new Set(Object.keys(EMPTY_QUEUE_COUNTS));

function emptyQueueAges() {
  return Object.fromEntries(Object.keys(EMPTY_QUEUE_COUNTS).map((status) => [status, 0]));
}

function taskTimestamp(task) {
  const ts = Date.parse(task.created_at || task.updated_at || "");
  return Number.isFinite(ts) ? ts : null;
}

function isResolvedReviewTask(task) {
  if (task.status !== "waiting_for_review") return false;
  const result = task.result || {};
  return Boolean(result.resolved_by_task_id || result.superseded_by_task_id || result.auto_accepted || result.accepted_at);
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

export async function collectWorkerQueueCounts(store) {
  try {
    const state = await store.load();
    const counts = { ...EMPTY_QUEUE_COUNTS };
    const oldest_age_ms = computeOldestAges(state.tasks || []);
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
        if (task.assignee === "codex" && isResolvedReviewTask(task)) resolvedCount++;
      }
      counts.waiting_for_review = Math.max(0, counts.waiting_for_review - resolvedCount);
      return { ...counts, actionable_review: counts.waiting_for_review, oldest_age_ms };
    }
    for (const task of state.tasks || []) {
      if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
      if (isResolvedReviewTask(task)) continue;
      counts[task.status] += 1;
    }
    return { ...counts, actionable_review: counts.waiting_for_review, oldest_age_ms };
  } catch {
    return { ...EMPTY_QUEUE_COUNTS, actionable_review: 0, oldest_age_ms: emptyQueueAges() };
  }
}
