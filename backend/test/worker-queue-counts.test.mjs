import test from 'node:test';
import assert from 'node:assert/strict';

import { collectWorkerQueueCounts } from '../src/worker-queue-counts.mjs';

test('collectWorkerQueueCounts counts codex task statuses in one pass shape', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'assigned' },
          { assignee: 'codex', status: 'queued' },
          { assignee: 'codex', status: 'running' },
          { assignee: 'codex', status: 'waiting_for_lock' },
          { assignee: 'codex', status: 'waiting_for_review' },
          { assignee: 'codex', status: 'completed' },
          { assignee: 'codex', status: 'failed' },
          { assignee: 'human', status: 'assigned' },
        ]
      };
    }
  };

  assert.deepEqual(await collectWorkerQueueCounts(store), {
    assigned: 1,
    queued: 1,
    running: 1,
    waiting_for_lock: 1,
    waiting_for_review: 1,
    completed: 1,
    failed: 1,
  });
});

test('collectWorkerQueueCounts returns zero counts when load fails', async () => {
  const store = { async load() { throw new Error('boom'); } };
  assert.deepEqual(await collectWorkerQueueCounts(store), {
    assigned: 0,
    queued: 0,
    running: 0,
    waiting_for_lock: 0,
    waiting_for_review: 0,
    completed: 0,
    failed: 0,
  });
});
