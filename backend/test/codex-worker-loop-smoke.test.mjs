import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getWorkerProgressCount, startCodexWorker } from '../src/codex-worker-loop.mjs';

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
}

test('getWorkerProgressCount prefers explicit progressed counter without double-counting', () => {
  assert.equal(getWorkerProgressCount({ progressed: 2, completed: 1, failed: 1, tasks: [] }), 2);
});

test('getWorkerProgressCount falls back to task result metadata', () => {
  const result = getWorkerProgressCount({
    tasks: [
      { task_id: 'a', status: 'assigned' },
      { task_id: 'b', status: 'completed' },
      { task_id: 'c', transitioned: true },
      { task_id: 'd', progressed: true },
    ],
  });
  assert.equal(result, 3);
});

test('getWorkerProgressCount treats pure skipped output as no progress', () => {
  assert.equal(getWorkerProgressCount({ inspected: 1, skipped: 1, tasks: [{ task_id: 'x', skipped: true }] }), 0);
});

test('getWorkerProgressCount does not double-count transitioned+completed task', () => {
  // Old format fallback: result has both transitioned=1 and completed=1 for same task
  const result = getWorkerProgressCount({
    transitioned: 1,
    completed: 1,
    failed: 0,
    tasks: [
      { task_id: 'a', transitioned: true, status: 'completed', progressed: true }
    ],
  });
  // progressed field is missing, so fallback uses Math.max(transitioned, completed, failed)
  assert.equal(result, 1);
});

test('getWorkerProgressCount does not double-count transitioned+failed task', () => {
  const result = getWorkerProgressCount({
    transitioned: 1,
    completed: 0,
    failed: 1,
    tasks: [
      { task_id: 'b', transitioned: true, status: 'failed', progressed: true }
    ],
  });
  assert.equal(result, 1);
});

test('getWorkerProgressCount prefers explicit progressed when available', () => {
  // New format: explicit progressed counter takes precedence
  const result = getWorkerProgressCount({
    progressed: 3,
    transitioned: 1,
    completed: 2,
    failed: 1,
    tasks: [],
  });
  assert.equal(result, 3);
});

test('getWorkerProgressCount returns 0 for explicit progressed=0', () => {
  const result = getWorkerProgressCount({
    progressed: 0,
    transitioned: 0,
    completed: 0,
    failed: 0,
    tasks: [],
  });
  assert.equal(result, 0);
});

test('getWorkerProgressCount fallback only counts each task once even with multiple matching fields', () => {
  // Per-task fallback: filter counts each task once
  const result = getWorkerProgressCount({
    tasks: [
      { task_id: 'x', progressed: true, transitioned: true, status: 'completed' },
      { task_id: 'y', transitioned: true, status: 'failed' },
      { task_id: 'z', status: 'completed' },
    ],
  });
  assert.equal(result, 3);
});

test('startCodexWorker accepts synchronous default workspace root resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-worker-loop-'));
  const workerState = {};
  let runAssignedCount = 0;
  const server = {
    getDefaultWorkspaceRoot: () => root,
    reconcileStaleTasks: async () => ({ ok: true, reconciled: 0 }),
    runAssignedCodexTasks: async () => {
      runAssignedCount += 1;
      return { inspected: 0, progressed: 0, completed: 0, failed: 0, tasks: [] };
    },
  };

  const worker = startCodexWorker(server, {
    intervalMs: 10000,
    workerState,
    maintenanceIntervalMs: 0,
  });

  try {
    await waitFor(() => workerState.last_tick_finished_at);
    assert.equal(workerState.last_error, null);
    assert.equal(runAssignedCount, 1);
  } finally {
    worker.stop();
  }
});
