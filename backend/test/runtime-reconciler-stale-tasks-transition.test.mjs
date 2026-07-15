import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRunningTasks } from '../src/runtime-reconciler-stale-tasks.mjs';

function makeStore(state) {
  return {
    state,
    async load() { return this.state; },
    async mutate(fn) { return fn(this.state); },
    async save() {},
  };
}

test('startup stale-task reconciliation uses canonical transition history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-stale-transition-'));
  const state = {
    tasks: [{ id: 'task_stale', status: 'running', result: {}, logs: [] }],
    goals: [], activities: [], task_transition_events: [], task_transition_idempotency: {},
  };
  const store = makeStore(state);

  const result = await reconcileRunningTasks({
    state,
    store,
    config: { defaultWorkspaceRoot: root, codexStallThreshold: 1 },
    notifyTerminalTaskIfNeeded: async () => {},
  });

  assert.equal(result.length, 1);
  assert.equal(state.tasks[0].status, 'waiting_for_review');
  assert.equal(state.task_transition_events.length, 1);
  assert.equal(state.task_transition_events[0].event, 'reconciliation_correction');
  assert.equal(state.task_transition_events[0].previous_status, 'running');
  assert.equal(state.task_transition_events[0].next_status, 'waiting_for_review');
});
