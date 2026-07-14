import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcileStoppedTuiTask } from '../src/tool-groups/codex-tui-tools-group.mjs';

describe('full TUI tool transitions', () => {
  it('stopped TUI task without evidence becomes repairing and clears manual ownership', async () => {
    const state = { tasks: [{ id: 't', status: 'running', metadata: { tui_session_owner: 'manual', manual_tui_session_starting: false } }], activities: [] };
    const store = { async mutate(fn) { return fn(state); } };
    const updated = await reconcileStoppedTuiTask({ store, taskId: 't', reason: 'manual_stop', hasEvidence: false });
    assert.equal(updated.status, 'repairing');
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

});
