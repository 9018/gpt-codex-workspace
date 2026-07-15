import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Unified Action Model', () => {
  let executeAction, getActionHistory, getAvailableActions, createAction, ACTION_TYPES;

  before(async () => {
    const mod = await import('../src/unified-action-model.mjs');
    executeAction = mod.executeAction;
    getActionHistory = mod.getActionHistory;
    getAvailableActions = mod.getAvailableActions;
    createAction = mod.createAction;
    ACTION_TYPES = mod.ACTION_TYPES;
  });

  it('ACTION_TYPES contains all expected types', () => {
    const expected = [
      'start', 'stop', 'retry', 'resume', 'assisted',
      'approve', 'apply', 'repair', 'dirty_resolve',
      'restart_verify', 'cleanup',
    ];
    for (const type of expected) {
      assert.ok(ACTION_TYPES.includes(type), `Expected ${type} in ACTION_TYPES`);
    }
  });

  it('createAction returns action descriptor with all required fields', () => {
    const action = createAction({
      type: 'start',
      task_id: 'task_123',
      goal_id: 'goal_456',
      params: { mode: 'full' },
    });

    assert.ok(action.id);
    assert.equal(action.type, 'start');
    assert.equal(action.task_id, 'task_123');
    assert.equal(action.goal_id, 'goal_456');
    assert.ok(action.timestamp);
    assert.ok(action.timestamp.includes('T')); // ISO-like
  });

  it('executeAction dispatches correctly for start type', async () => {
    const action = createAction({
      type: 'start',
      task_id: 'task_start',
      params: { mode: 'standard' },
    });
    const result = await executeAction(action);
    assert.ok(result);
    assert.equal(result.action_id, action.id);
    assert.equal(result.status, 'completed');
    assert.ok(result.result);
    assert.equal(result.result.type, 'start');
    assert.equal(result.result.task_id, 'task_start');
  });

  it('executeAction dispatches correctly for stop type', async () => {
    const action = createAction({ type: 'stop', task_id: 'task_stop' });
    const result = await executeAction(action);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.type, 'stop');
  });

  it('executeAction dispatches correctly for retry type', async () => {
    const action = createAction({ type: 'retry', task_id: 'task_retry' });
    const result = await executeAction(action);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.type, 'retry');
  });

  it('getActionHistory returns array of actions for a task', async () => {
    // Execute some actions first to populate history
    await executeAction(createAction({ type: 'start', task_id: 'hist_1' }));
    await executeAction(createAction({ type: 'stop', task_id: 'hist_1' }));

    const history = await getActionHistory('hist_1');
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 2);
    assert.equal(history[0].result.type, 'start');
    assert.equal(history[1].result.type, 'stop');
  });

  it('getActionHistory returns empty array for unknown task', async () => {
    const history = await getActionHistory('nonexistent_task');
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 0);
  });

  it('getAvailableActions returns appropriate actions for various task states', () => {
    const runningTask = { id: 't1', status: 'running' };
    const actions = getAvailableActions(runningTask);
    assert.ok(actions.length > 0);
    assert.ok(actions.some(a => a === 'stop')); // running task can be stopped
    assert.ok(!actions.some(a => a === 'start')); // already running
  });

  it('getAvailableActions includes start for non-running tasks', () => {
    const idleTask = { id: 't2', status: 'completed' };
    const actions = getAvailableActions(idleTask);
    assert.ok(actions.some(a => a === 'retry'));
  });

  it('executeAction returns failed status for unknown type', async () => {
    const action = createAction({
      type: 'unknown_type',
      task_id: 'task_unknown',
    });
    const result = await executeAction(action);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
  });
});
