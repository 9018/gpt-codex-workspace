import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeLegacyModes, taskPayloadFromTask } from '../src/task-lifecycle.mjs';

describe('full mode worker routing', () => {
  it('normalizes all ordinary legacy task and goal modes to full', async () => {
    const state = {
      tasks: [
        { id: 'a', mode: 'builder', title: 'a' },
        { id: 'b', mode: 'deploy', title: 'b' },
        { id: 'c', mode: 'admin', title: 'c' },
        { id: 'd', mode: 'readonly', title: 'd' },
      ],
      goals: [
        { id: 'g1', mode: 'builder' },
        { id: 'g2', mode: 'deploy' },
      ],
    };
    const store = { async save() {} };
    await normalizeLegacyModes(store, state);
    assert.deepEqual(state.tasks.map((x) => x.mode), ['full', 'full', 'full', 'full']);
    assert.deepEqual(state.goals.map((x) => x.mode), ['full', 'full']);
  });

  it('compatibility task payload always uses full mode', () => {
    const payload = taskPayloadFromTask({ id: 't', title: 'x', mode: 'admin' });
    assert.equal(payload.mode, 'full');
  });
});

it('full lifecycle statuses are indexed as active execution states', async () => {
  const { TASK_STATUSES, ACTIVE_EXECUTION_STATUSES } = await import('../src/task-status-taxonomy.mjs');
  for (const key of ['STARTING', 'COLLECTING', 'ACCEPTING', 'REPAIRING', 'INTEGRATING']) {
    assert.equal(typeof TASK_STATUSES[key], 'string');
    assert.equal(ACTIVE_EXECUTION_STATUSES.has(TASK_STATUSES[key]), true, key);
  }
  assert.equal(TASK_STATUSES.NEEDS_DECISION, 'needs_decision');
});
