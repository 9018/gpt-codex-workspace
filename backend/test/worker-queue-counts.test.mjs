import test from 'node:test';
import assert from 'node:assert/strict';

import { collectWorkerQueueCounts } from '../src/worker-queue-counts.mjs';

const ZERO_AGES = {
  assigned: 0,
  queued: 0,
  running: 0,
  waiting_for_lock: 0,
  waiting_for_review: 0,
  completed: 0,
  failed: 0,
};

test('collectWorkerQueueCounts counts codex task statuses in one pass shape', async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'assigned', created_at: old },
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

  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.assigned, 1);
  assert.equal(result.queued, 1);
  assert.equal(result.running, 1);
  assert.equal(result.waiting_for_lock, 1);
  assert.equal(result.waiting_for_review, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.ok(result.oldest_age_ms.assigned >= 0);
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
    actionable_review: 0,
    oldest_age_ms: ZERO_AGES,
  });
});
