import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Worker lifecycle E2E', () => {
  let workerStateModule;
  let state;

  before(async () => {
    workerStateModule = await import('../src/codex-worker-state.mjs');
  });

  it('createWorkerState returns default disabled state', () => {
    state = workerStateModule.createWorkerState();
    assert.equal(state.enabled, false);
    assert.equal(state.running, false);
    assert.equal(state.started_at, null);
    assert.equal(state.last_tick_started_at, null);
    assert.equal(state.last_tick_finished_at, null);
    assert.equal(state.last_error, null);
  });

  it('computeWorkerHealth returns disabled for default state', () => {
    const health = workerStateModule.computeWorkerHealth(state);
    assert.equal(health.phase, 'disabled');
    assert.ok(health.reason.includes('not enabled'));
  });

  it('markWorkerStarted transitions to enabled', () => {
    workerStateModule.markWorkerStarted(state, {
      intervalMs: 5000,
      limit: 10,
      concurrency: 2,
    });
    assert.equal(state.enabled, true);
    assert.equal(state.running, false);
    assert.ok(state.started_at);
    assert.equal(state.interval_ms, 5000);
    assert.equal(state.concurrency, 2);
    assert.equal(state.limit, 10);
  });

  it('computeWorkerHealth reports enabled_but_not_running after start', () => {
    const health = workerStateModule.computeWorkerHealth(state);
    assert.equal(health.phase, 'enabled_but_not_running');
  });

  it('markWorkerTickStarted transitions to running', () => {
    workerStateModule.markWorkerTickStarted(state);
    assert.equal(state.running, true);
    assert.ok(state.last_tick_started_at);
    assert.equal(state.last_error, null);
  });

  it('computeWorkerHealth reports running during tick', () => {
    const health = workerStateModule.computeWorkerHealth(state);
    assert.equal(health.phase, 'running');
    assert.ok(health.current_tick_duration_ms !== null);
  });

  it('recordWorkerTickSuccess captures tick results', () => {
    workerStateModule.recordWorkerTickSuccess(state, {
      inspected: 5,
      completed: 2,
      skipped: 3,
    });
    assert.ok(state.last_tick_result);
    assert.equal(state.last_tick_result.ok, true);
    assert.equal(state.last_tick_result.inspected, 5);
    assert.equal(state.last_tick_result.completed, 2);
    assert.equal(state.last_tick_result.skipped, 3);
  });

  it('markWorkerTickFinished transitions to not running', () => {
    workerStateModule.markWorkerTickFinished(state);
    assert.equal(state.running, false);
    assert.ok(state.last_tick_finished_at);
    assert.ok(state.last_tick_duration_ms !== null);
  });

  it('computeWorkerHealth reports enabled_but_not_running after tick', () => {
    const health = workerStateModule.computeWorkerHealth(state);
    assert.equal(health.phase, 'enabled_but_not_running');
    assert.ok(health.last_tick_age_ms !== null);
  });

  it('markWorkerNextTickScheduled sets next_tick_due_at', () => {
    workerStateModule.markWorkerNextTickScheduled(state, { intervalMs: 5000 });
    assert.ok(state.next_tick_due_at);
    assert.ok(state.current_interval_ms, 5000);
  });

  it('recordWorkerTickError captures error state', () => {
    // Create fresh state for error path
    const errState = workerStateModule.createWorkerState();
    workerStateModule.markWorkerStarted(errState, { intervalMs: 5000 });
    workerStateModule.markWorkerTickStarted(errState);

    const testError = new Error('connection refused');
    workerStateModule.recordWorkerTickError(errState, testError);
    workerStateModule.markWorkerTickFinished(errState);

    assert.equal(errState.running, false);
    assert.equal(errState.last_tick_result.ok, false);
    assert.equal(errState.last_error, 'connection refused');
    assert.equal(errState.last_tick_result.error, 'connection refused');
  });

  it('workerStatusSnapshot returns all expected fields', () => {
    const snapshot = workerStateModule.workerStatusSnapshot(state);
    const expected = [
      'enabled', 'running', 'started_at', 'last_tick_started_at',
      'last_tick_finished_at', 'last_tick_duration_ms',
      'interval_ms', 'current_interval_ms', 'next_tick_due_at',
      'concurrency', 'limit', 'last_tick_result', 'last_error',
    ];
    for (const key of expected) {
      assert.ok(key in snapshot, `Expected "${key}" in snapshot`);
    }
  });

  it('workerStatusExtendedSnapshot includes health', () => {
    const extended = workerStateModule.workerStatusExtendedSnapshot(state);
    assert.ok('health' in extended);
    assert.ok('phase' in extended.health);
    assert.ok('reason' in extended.health);
  });
});
