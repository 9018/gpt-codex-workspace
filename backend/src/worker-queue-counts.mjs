const EMPTY_QUEUE_COUNTS = {
  assigned: 0,
  queued: 0,
  running: 0,
  waiting_for_lock: 0,
  waiting_for_review: 0,
  completed: 0,
  failed: 0,
};

const COUNTED_STATUSES = new Set(Object.keys(EMPTY_QUEUE_COUNTS));

export async function collectWorkerQueueCounts(store) {
  try {
    const state = await store.load();
    const counts = { ...EMPTY_QUEUE_COUNTS };
    // Prefer indexed lookup when available (O(1) per status)
    if (typeof store.getCodexTaskQueue === "function") {
      const q = store.getCodexTaskQueue();
      for (const st of Object.keys(EMPTY_QUEUE_COUNTS)) {
        if (q.counts[st] !== undefined) {
          counts[st] = q.counts[st];
        }
      }
      return counts;
    }
    for (const task of state.tasks || []) {
      if (task.assignee !== "codex" || !COUNTED_STATUSES.has(task.status)) continue;
      counts[task.status] += 1;
    }
    return counts;
  } catch {
    return { ...EMPTY_QUEUE_COUNTS };
  }
}
