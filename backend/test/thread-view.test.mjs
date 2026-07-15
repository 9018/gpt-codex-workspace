import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRootGoal, buildThreadView } from '../src/thread/thread-view.mjs';

test('thread-view: resolveRootGoal returns the goal itself for a root goal', () => {
  const state = {
    goals: [
      { id: 'goal_root', root_goal_id: 'goal_root', title: 'Root Goal' },
      { id: 'goal_child', root_goal_id: 'goal_root', title: 'Child Goal' },
    ],
  };
  const root = resolveRootGoal(state, state.goals[0]);
  assert.equal(root.id, 'goal_root');
});

test('thread-view: resolveRootGoal walks up to find root for child goal', () => {
  const state = {
    goals: [
      { id: 'goal_root', root_goal_id: 'goal_root', title: 'Root Goal' },
      { id: 'goal_child', root_goal_id: 'goal_root', title: 'Child Goal' },
    ],
  };
  const root = resolveRootGoal(state, state.goals[1]);
  assert.equal(root.id, 'goal_root');
});

test('thread-view: resolveRootGoal returns null for goal with missing root', () => {
  const state = { goals: [{ id: 'goal_orphan', root_goal_id: 'nonexistent', title: 'Orphan' }] };
  const root = resolveRootGoal(state, state.goals[0]);
  assert.equal(root, null);
});

test('thread-view: resolveRootGoal returns null for nil input', () => {
  assert.equal(resolveRootGoal({ goals: [] }, null), null);
  assert.equal(resolveRootGoal({ goals: [] }, undefined), null);
});

test('thread-view: resolveRootGoal handles missing state gracefully', () => {
  assert.equal(resolveRootGoal(null, { id: 'g1' }), null);
  assert.equal(resolveRootGoal({ goals: null }, { id: 'g1' }), null);
});

test('thread-view: buildThreadView for root goal shows root as thread identity', () => {
  const state = {
    goals: [
      { id: 'goal_root', root_goal_id: 'goal_root', title: 'My Root Goal', user_request: 'Do something', status: 'assigned', mode: 'full' },
    ],
  };
  const view = buildThreadView(state, state.goals[0]);
  assert.equal(view.thread_id, 'goal_root');
  assert.equal(view.root_goal_id, 'goal_root');
  assert.equal(view.thread_title, 'My Root Goal');
  assert.equal(view.internal_title, 'My Root Goal');
  assert.equal(view.is_internal_child, false);
  assert.ok(view.phase);
  assert.equal(view.iteration, 0);
});

test('thread-view: buildThreadView for child goal inherits thread from root', () => {
  const state = {
    goals: [
      { id: 'goal_root', root_goal_id: 'goal_root', title: 'Root Goal', user_request: 'Do something', status: 'assigned', mode: 'full' },
      { id: 'goal_child', root_goal_id: 'goal_root', title: 'Repair: Root Goal (attempt 1)', user_request: 'Repair something', status: 'assigned', mode: 'repair' },
    ],
  };
  const view = buildThreadView(state, state.goals[1]);
  assert.equal(view.thread_id, 'goal_root');
  assert.equal(view.root_goal_id, 'goal_root');
  assert.equal(view.thread_title, 'Root Goal');
  assert.equal(view.internal_title, 'Repair: Root Goal (attempt 1)');
  assert.equal(view.is_internal_child, true);
});

test('thread-view: buildThreadView child iteration increments', () => {
  const state = {
    goals: [
      { id: 'goal_root', root_goal_id: 'goal_root', title: 'Root', user_request: 'Do X', status: 'assigned', mode: 'full' },
      { id: 'goal_child', root_goal_id: 'goal_root', title: 'Repair: Root (attempt 2)', user_request: 'Repair', status: 'assigned', mode: 'repair', attempt: 2 },
    ],
  };
  const view = buildThreadView(state, state.goals[1]);
  assert.equal(view.iteration, 2);
});

test('thread-view: buildThreadView with legacy goal (no root_goal_id) defaults to self', () => {
  const state = {
    goals: [
      { id: 'goal_legacy', title: 'Legacy Goal', user_request: 'Old task', status: 'completed', mode: 'full' },
    ],
  };
  const view = buildThreadView(state, state.goals[0]);
  assert.equal(view.thread_id, 'goal_legacy');
  assert.equal(view.root_goal_id, 'goal_legacy');
  assert.equal(view.thread_title, 'Legacy Goal');
  assert.equal(view.is_internal_child, false);
});

test('thread-view: buildThreadView handles null/undefined goal', () => {
  assert.equal(buildThreadView({ goals: [] }, null), null);
  assert.equal(buildThreadView({ goals: [] }, undefined), null);
});
