import assert from 'node:assert/strict';
import test from 'node:test';

import { findLinkedRepair } from '../src/codex-worker-runner.mjs';

test('findLinkedRepair ignores failed linked repair so parent can converge', () => {
  const parent = { id: 'parent-1', result: { repair_task_id: 'repair-1' } };
  const tasks = [
    parent,
    { id: 'repair-1', parent_task_id: 'parent-1', status: 'failed' },
  ];

  assert.equal(findLinkedRepair(tasks, parent), null);
});

test('findLinkedRepair returns active linked repair while it is still actionable', () => {
  const parent = { id: 'parent-1', result: { repair_task_id: 'repair-1' } };
  const activeRepair = { id: 'repair-1', parent_task_id: 'parent-1', status: 'waiting_for_review' };

  assert.equal(findLinkedRepair([parent, activeRepair], parent), activeRepair);
});

test('findLinkedRepair ignores completed child repair when scanning parent lineage', () => {
  const parent = { id: 'parent-1' };
  const completedRepair = { id: 'repair-1', parent_task_id: 'parent-1', status: 'completed' };

  assert.equal(findLinkedRepair([parent, completedRepair], parent), null);
});
