import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkerProgressCount } from '../src/codex-worker-loop.mjs';

test('getWorkerProgressCount uses explicit worker result counters', () => {
  assert.equal(getWorkerProgressCount({ progressed: 2, completed: 1, failed: 1, tasks: [] }), 4);
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
