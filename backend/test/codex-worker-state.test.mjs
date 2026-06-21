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
