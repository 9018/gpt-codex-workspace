export function createWorkerState() {
  return {
    enabled: false,
    running: false,
    started_at: null,
    last_tick_started_at: null,
    last_tick_finished_at: null,
    last_tick_duration_ms: null,
    interval_ms: null,
    limit: null,
    concurrency: null,
    last_tick_result: null,
    last_error: null,
  };
}

export function markWorkerStarted(workerState, { intervalMs, limit, concurrency, now = new Date() } = {}) {
  workerState.enabled = true;
  workerState.running = false;
  workerState.started_at = now.toISOString();
  workerState.interval_ms = intervalMs ?? null;
  workerState.limit = limit ?? null;
  workerState.concurrency = concurrency ?? null;
  return workerState;
}

export function markWorkerTickStarted(workerState, { now = new Date() } = {}) {
  workerState.running = true;
  workerState.last_tick_started_at = now.toISOString();
  workerState.last_error = null;
  return workerState;
}

export function recordWorkerTickSuccess(workerState, workerResult = {}) {
  const tasks = Array.isArray(workerResult.tasks) ? workerResult.tasks : [];
  workerState.last_tick_result = {
    ok: true,
    inspected: workerResult.inspected ?? 0,
    completed: workerResult.completed ?? 0,
    skipped: workerResult.skipped ?? 0,
    task_count: tasks.length,
  };
  return workerState;
}

export function recordWorkerTickError(workerState, error) {
  const message = error?.message || String(error || "unknown error");
  workerState.last_tick_result = { ok: false, error: message };
  workerState.last_error = message;
  return workerState;
}

export function markWorkerTickFinished(workerState, { now = new Date() } = {}) {
  workerState.last_tick_finished_at = now.toISOString();
  if (workerState.last_tick_started_at) {
    const started = new Date(workerState.last_tick_started_at).getTime();
    const finished = new Date(workerState.last_tick_finished_at).getTime();
    workerState.last_tick_duration_ms = finished - started;
  }
  workerState.running = false;
  return workerState;
}

export function workerStatusSnapshot(workerState) {
  return {
    enabled: workerState.enabled,
    running: workerState.running,
    started_at: workerState.started_at,
    last_tick_started_at: workerState.last_tick_started_at,
    last_tick_finished_at: workerState.last_tick_finished_at,
    last_tick_duration_ms: workerState.last_tick_duration_ms,
    interval_ms: workerState.interval_ms,
    concurrency: workerState.concurrency,
    limit: workerState.limit,
    last_tick_result: workerState.last_tick_result,
    last_error: workerState.last_error,
  };
}
