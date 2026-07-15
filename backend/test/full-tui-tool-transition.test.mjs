import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcileStoppedTuiTask } from '../src/tool-groups/codex-tui-tools-group.mjs';

describe('full TUI tool transitions', () => {
  it('stopped TUI task without evidence transitions canonically to waiting_for_repair and clears manual ownership', async () => {
    const state = { tasks: [{ id: 't', status: 'running', metadata: { tui_session_owner: 'manual', manual_tui_session_starting: false } }], activities: [] };
    const store = { async mutate(fn) { return fn(state); } };
    const updated = await reconcileStoppedTuiTask({ store, taskId: 't', reason: 'manual_stop', hasEvidence: false });
    assert.equal(updated.status, 'waiting_for_repair');
    assert.equal(updated.metadata.tui_session_owner, undefined);
  });

  it('stopped TUI task with evidence becomes collecting', async () => {
    const state = { tasks: [{ id: 't', status: 'running', metadata: { tui_session_owner: 'manual' } }], activities: [] };
    const store = { async mutate(fn) { return fn(state); } };
    const updated = await reconcileStoppedTuiTask({ store, taskId: 't', reason: 'completed', hasEvidence: true });
    assert.equal(updated.status, 'collecting');
  });
  it('stopping a stale session never revives a terminal task or queue item', async () => {
    const state = {
      tasks: [{ id: 't', status: 'failed', metadata: { tui_session_owner: 'manual' } }],
      goal_queue: [{ task_id: 't', status: 'failed', blocked_reason: 'terminal evidence invalid' }],
      activities: [],
    };
    const store = { async mutate(fn) { return fn(state); } };
    const updated = await reconcileStoppedTuiTask({ store, taskId: 't', reason: 'manual_stop', hasEvidence: true });
    assert.equal(updated.status, 'failed');
    assert.equal(updated.metadata.tui_session_owner, undefined);
    assert.equal(state.goal_queue[0].status, 'failed');
    assert.equal(state.goal_queue[0].blocked_reason, 'terminal evidence invalid');
  });

  it('uses canonical transition events instead of direct status mutation', async () => {
    const state = { tasks: [{ id: 't', status: 'running', metadata: { tui_session_owner: 'manual' } }], activities: [] };
    const calls = [];
    const transitionService = {
      async transitionTask(command) {
        calls.push(command);
        const task = state.tasks[0];
        task.status = command.event === 'execution_session_stopped' ? 'collecting' : 'waiting_for_repair';
        return { task, applied: true, next_status: task.status };
      },
    };
    const store = { async mutate(fn) { return fn(state); } };
    await reconcileStoppedTuiTask({ store, taskId: 't', reason: 'manual_stop', hasEvidence: false, transitionService });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'runtime_lost');
    assert.equal(calls[0].source, 'codex_tui');
  });

});
