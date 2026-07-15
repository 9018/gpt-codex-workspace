import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerState,
  markWorkerStarted,
  markWorkerTickStarted,
  recordWorkerTickSuccess,
  recordWorkerTickError,
  markWorkerTickFinished,
  markWorkerNextTickScheduled,
  workerStatusSnapshot,
  computeWorkerHealth,
  workerStatusExtendedSnapshot,
} from '../src/codex-worker-state.mjs';

test('worker state helpers track a successful tick', () => {
  const state = createWorkerState();
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  markWorkerTickStarted(state, { now: new Date('2026-01-01T00:00:01.000Z') });
  recordWorkerTickSuccess(state, { inspected: 2, completed: 1, skipped: 1, tasks: [{}, {}], github_sync: { ok: true, imported_tasks: 3 } });
  markWorkerTickFinished(state, { now: new Date('2026-01-01T00:00:03.500Z') });

  assert.equal(state.enabled, true);
  assert.equal(state.running, false);
  assert.equal(state.interval_ms, 5000);
  assert.equal(state.current_interval_ms, 5000);
  assert.equal(state.next_tick_due_at, null);
  assert.equal(state.limit, 10);
  assert.equal(state.concurrency, 4);
  assert.deepEqual(state.last_tick_result, { ok: true, inspected: 2, completed: 1, skipped: 1, task_count: 2, github_sync: { ok: true, imported_tasks: 3 } });
  assert.equal(state.last_tick_duration_ms, 2500);
  assert.equal(state.last_error, null);
});

test('worker state helpers track tick errors', () => {
  const state = createWorkerState();
  markWorkerTickStarted(state, { now: new Date('2026-01-01T00:00:00.000Z') });
  recordWorkerTickError(state, new Error('boom'));
  markWorkerTickFinished(state, { now: new Date('2026-01-01T00:00:01.000Z') });

  assert.equal(state.running, false);
  assert.deepEqual(state.last_tick_result, { ok: false, error: 'boom' });
  assert.equal(state.last_error, 'boom');
  assert.equal(state.last_tick_duration_ms, 1000);
});

test('worker state records effective next tick interval', () => {
  const state = createWorkerState();
  markWorkerStarted(state, { intervalMs: 5000, limit: 10, concurrency: 4, now: new Date('2026-01-01T00:00:00.000Z') });
  markWorkerNextTickScheduled(state, { intervalMs: 40000, now: new Date('2026-01-01T00:00:10.000Z') });

  assert.equal(state.current_interval_ms, 40000);
  assert.equal(state.next_tick_due_at, '2026-01-01T00:00:50.000Z');
});



test('worker next tick schedule preserves zero effective interval', () => {
  const state = createWorkerState();
  markWorkerStarted(state, { intervalMs: 5000, limit: 10, concurrency: 4, now: new Date('2026-01-01T00:00:00.000Z') });
  markWorkerNextTickScheduled(state, { intervalMs: 0, now: new Date('2026-01-01T00:00:10.000Z') });

  assert.equal(state.current_interval_ms, 0);
  assert.equal(state.next_tick_due_at, '2026-01-01T00:00:10.000Z');
});


test('workerStatusSnapshot returns stable public shape', () => {
  const state = createWorkerState();
  markWorkerStarted(state, { intervalMs: 1, limit: 2, concurrency: 3, now: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(Object.keys(workerStatusSnapshot(state)), [
    'enabled',
    'running',
    'started_at',
    'last_tick_started_at',
    'last_tick_finished_at',
    'last_tick_duration_ms',
    'interval_ms',
    'current_interval_ms',
    'next_tick_due_at',
    'concurrency',
    'limit',
    'last_tick_result',
    'last_error',
  ]);
});

// ===========================================================================
// Worker health diagnostics tests
// ===========================================================================

test('computeWorkerHealth: disabled when worker not enabled', () => {
  const state = createWorkerState();
  // state.enabled defaults to false
  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'disabled');
  assert.equal(health.reason, 'worker not enabled');
});

test('computeWorkerHealth: enabled_but_not_running when never started', () => {
  const state = createWorkerState();
  state.enabled = true;
  // started_at is null, running is false, last_tick_finished_at is null
  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'enabled_but_not_running');
  assert.equal(health.reason, 'worker enabled but never started');
});

test('computeWorkerHealth: idle when between ticks', () => {
  const state = createWorkerState();
  const now = new Date();
  const tickStarted = new Date(now.getTime() - 3000);
  const tickFinished = new Date(now.getTime() - 500);
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date(now.getTime() - 10000),
  });
  markWorkerTickStarted(state, { now: tickStarted });
  recordWorkerTickSuccess(state, { inspected: 2, completed: 1, skipped: 1, tasks: [{}, {}] });
  markWorkerTickFinished(state, { now: tickFinished });
  markWorkerNextTickScheduled(state, { intervalMs: 5000, now: tickFinished });

  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'idle');
  assert.equal(health.reason, 'waiting for next tick');
  assert.ok(health.last_tick_age_ms !== null);
  // next_tick_due should be in the future (500ms ago + 5000ms = 4500ms from now)
  assert.ok(health.next_tick_overdue_ms === null || health.next_tick_overdue_ms === 0);
});

test('computeWorkerHealth: running when tick in progress', () => {
  const state = createWorkerState();
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  markWorkerTickStarted(state, { now: new Date('2026-01-01T00:00:01.000Z') });

  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'running');
  assert.ok(health.reason.startsWith('tick running for'));
  assert.ok(health.current_tick_duration_ms !== null);
});

test('computeWorkerHealth: stalled when last tick is old', () => {
  const state = createWorkerState();
  const now = new Date();
  const tickFinished = new Date(now.getTime() - 120000); // 2 minutes ago (> 6 * 5000ms = 30s)
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date(tickFinished.getTime() - 5000),
  });
  markWorkerTickStarted(state, { now: new Date(tickFinished.getTime() - 1000) });
  recordWorkerTickSuccess(state, { inspected: 1, completed: 0, skipped: 0, tasks: [] });
  markWorkerTickFinished(state, { now: tickFinished });
  // Do NOT schedule next tick — let last_tick_finished_at age

  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'stalled');
  assert.ok(health.reason.includes('last tick'));
  assert.ok(health.last_tick_age_ms !== null);
  assert.ok(health.last_tick_age_ms > 30000);
});

test('computeWorkerHealth: overdue when next tick is overdue', () => {
  const state = createWorkerState();
  const now = new Date();
  const tickFinished = new Date(now.getTime() - 10000);
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date(now.getTime() - 20000),
  });
  markWorkerTickStarted(state, { now: new Date(now.getTime() - 15000) });
  recordWorkerTickSuccess(state, { inspected: 1, completed: 0, skipped: 0, tasks: [] });
  markWorkerTickFinished(state, { now: tickFinished });
  // Schedule next tick way in the past (so it's overdue by more than 3*interval)
  markWorkerNextTickScheduled(state, { intervalMs: 5000, now: new Date(tickFinished.getTime() - 30000) });

  const health = computeWorkerHealth(state);
  assert.equal(health.phase, 'overdue');
  assert.ok(health.reason.includes('overdue'));
  assert.ok(health.next_tick_overdue_ms !== null);
});

test('computeWorkerHealth: workerStatusExtendedSnapshot includes health', () => {
  const state = createWorkerState();
  state.enabled = true;
  const snapshot = workerStatusExtendedSnapshot(state);
  assert.ok(snapshot.health, 'should include health field');
  assert.equal(snapshot.health.phase, 'enabled_but_not_running');
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.running, false);
});

test('computeWorkerHealth: workerStatusExtendedSnapshot with running worker', () => {
  const state = createWorkerState();
  markWorkerStarted(state, {
    intervalMs: 5000,
    limit: 10,
    concurrency: 4,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  markWorkerTickStarted(state, { now: new Date('2026-01-01T00:00:01.000Z') });

  const snapshot = workerStatusExtendedSnapshot(state);
  assert.equal(snapshot.health.phase, 'running');
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.running, true);
});

test('workerStatusSnapshot: stable public shape with health fields', () => {
  const state = createWorkerState();
  markWorkerStarted(state, { intervalMs: 1, limit: 2, concurrency: 3, now: new Date('2026-01-01T00:00:00.000Z') });
  const keys = Object.keys(workerStatusSnapshot(state));
  assert.ok(keys.includes('enabled'));
  assert.ok(keys.includes('running'));
  assert.ok(keys.includes('last_tick_result'));
  assert.ok(keys.includes('last_error'));
});
