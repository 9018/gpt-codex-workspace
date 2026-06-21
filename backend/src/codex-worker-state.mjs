export function createWorkerState() {
  return {
    enabled: false,
    running: false,
    started_at: null,
    last_tick_started_at: null,
    last_tick_finished_at: null,
    last_tick_duration_ms: null,
    interval_ms: null,
    current_interval_ms: null,
    next_tick_due_at: null,
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
  workerState.current_interval_ms = intervalMs ?? null;
  workerState.next_tick_due_at = null;
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
    ...(workerResult.github_sync ? { github_sync: workerResult.github_sync } : {}),
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


export function markWorkerNextTickScheduled(workerState, { intervalMs, now = new Date() } = {}) {
  const ms = Number(intervalMs);
  workerState.current_interval_ms = Number.isFinite(ms) && ms >= 0 ? ms : workerState.interval_ms;
  workerState.next_tick_due_at = workerState.current_interval_ms != null
    ? new Date(now.getTime() + workerState.current_interval_ms).toISOString()
    : null;
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
    current_interval_ms: workerState.current_interval_ms ?? workerState.interval_ms ?? null,
    next_tick_due_at: workerState.next_tick_due_at ?? null,
    concurrency: workerState.concurrency,
    limit: workerState.limit,
    last_tick_result: workerState.last_tick_result,
    last_error: workerState.last_error,
  };
}

/**
 * Compute worker health phase from worker state.
 * Phases: disabled / idle / running / overdue / stalled
 * Includes diagnostic timestamps and human-readable reason.
 *
 * @param {object} workerState
 * @returns {{ phase: string, last_tick_age_ms: number|null, current_tick_duration_ms: number|null, next_tick_overdue_ms: number|null, reason: string }}
 */
export function computeWorkerHealth(workerState) {
  if (!workerState.enabled) {
    return { phase: 'disabled', last_tick_age_ms: null, current_tick_duration_ms: null, next_tick_overdue_ms: null, reason: 'worker not enabled' };
  }

  const now = Date.now();
  const lastTickFinishedAt = workerState.last_tick_finished_at
    ? new Date(workerState.last_tick_finished_at).getTime() : null;
  const lastTickStartedAt = workerState.last_tick_started_at
    ? new Date(workerState.last_tick_started_at).getTime() : null;
  const nextTickDueAt = workerState.next_tick_due_at
    ? new Date(workerState.next_tick_due_at).getTime() : null;

  const lastTickAgeMs = lastTickFinishedAt !== null ? Math.max(0, now - lastTickFinishedAt) : null;
  const currentTickDurationMs = (workerState.running && lastTickStartedAt !== null) ? Math.max(0, now - lastTickStartedAt) : null;
  const nextTickOverdueMs = nextTickDueAt !== null ? Math.max(0, now - nextTickDueAt) : null;

  const intervalMs = workerState.current_interval_ms || workerState.interval_ms || 5000;

  if (workerState.running && currentTickDurationMs !== null) {
    const reason = `tick running for ${Math.round(currentTickDurationMs / 1000)}s`;
    return { phase: 'running', last_tick_age_ms: lastTickAgeMs, current_tick_duration_ms: currentTickDurationMs, next_tick_overdue_ms: nextTickOverdueMs, reason };
  }

  if (lastTickFinishedAt === null && !workerState.started_at) {
    return { phase: 'idle', last_tick_age_ms: null, current_tick_duration_ms: null, next_tick_overdue_ms: null, reason: 'never started' };
  }

  if (lastTickAgeMs !== null && lastTickAgeMs > intervalMs * 6) {
    return { phase: 'stalled', last_tick_age_ms: lastTickAgeMs, current_tick_duration_ms: null, next_tick_overdue_ms: nextTickOverdueMs, reason: `last tick ${Math.round(lastTickAgeMs / 1000)}s ago (>${intervalMs * 6}ms)` };
  }

  if (nextTickOverdueMs !== null && nextTickOverdueMs > intervalMs * 3) {
    return { phase: 'overdue', last_tick_age_ms: lastTickAgeMs, current_tick_duration_ms: null, next_tick_overdue_ms: nextTickOverdueMs, reason: `next tick overdue by ${Math.round(nextTickOverdueMs / 1000)}s` };
  }

  return { phase: 'idle', last_tick_age_ms: lastTickAgeMs, current_tick_duration_ms: null, next_tick_overdue_ms: nextTickOverdueMs, reason: 'waiting for next tick' };
}

/**
 * Extended snapshot that includes worker health.
 *
 * @param {object} workerState
 * @returns {object}
 */
export function workerStatusExtendedSnapshot(workerState) {
  return {
    ...workerStatusSnapshot(workerState),
    health: computeWorkerHealth(workerState),
  };
}
