import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../src/state-store.mjs';
import { createTask } from '../src/goal-task-creation.mjs';
import { createGoal } from '../src/goal-task-goals.mjs';
import { buildGoalTask } from '../src/goal-task-task-factory.mjs';
import { defaultTokenContext } from '../src/auth-context.mjs';
import { loadWorkflowRun } from '../src/workflow-run-store.mjs';

test('createTask persists execution metadata fields for ordinary builder tasks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-task-create-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({ statePath: join(root, 'state.json'), defaultWorkspaceRoot: root });
  await store.load();

  const { task } = await createTask(store, { defaultWorkspaceRoot: root }, {
    title: 'Implement feature',
    description: 'Change code',
    assignee: 'codex',
    mode: 'builder',
  }, { ...defaultTokenContext('test'), user_id: 'user_1' });

  assert.equal(task.execution_mode, 'worktree');
  assert.deepEqual(task.worktree, {
    enabled: true,
    path: null,
    branch: null,
    base_ref: null,
    base_sha: null,
    head_sha: null,
    status: 'pending',
  });
  assert.equal(task.attempt, 0);
  assert.equal(task.max_attempts, 2);

  const workflowRun = loadWorkflowRun(root, task.id);
  assert.equal(workflowRun.task_id, task.id);
  assert.equal(workflowRun.goal_id, task.goal_id);
  assert.equal(workflowRun.status, 'queued');
  assert.equal(workflowRun.refs.source, 'create_task');
});

test('buildGoalTask includes execution metadata fields for queue-created builder tasks', () => {
  const now = new Date().toISOString();
  const task = buildGoalTask({
    id: 'goal_queue_task_contract',
    project_id: 'default',
    workspace_id: 'hosted-default',
    title: 'Queued work',
    mode: 'builder',
    user_request: 'Do work',
    goal_prompt: 'Do work',
    created_at: now,
  }, {
    id: 'conv_queue_task_contract',
  }, 'system');

  assert.equal(task.execution_mode, 'worktree');
  assert.equal(task.worktree.enabled, true);
  assert.equal(task.worktree.status, 'pending');
  assert.equal(task.attempt, 0);
  assert.equal(task.max_attempts, 2);
});

test('createGoal persists a workflow_run for assigned Codex goals', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-goal-create-workflow-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({ statePath: join(root, 'state.json'), defaultWorkspaceRoot: root });
  await store.load();

  const { goal, task } = await createGoal(store, { defaultWorkspaceRoot: root }, {
    user_request: 'Build the feature',
    goal_prompt: 'Implement and verify the feature.',
    assign_to_codex: true,
    mode: 'builder',
  }, { ...defaultTokenContext('test'), user_id: 'user_1' });

  const workflowRun = loadWorkflowRun(root, task.id);
  assert.equal(workflowRun.goal_id, goal.id);
  assert.equal(workflowRun.task_id, task.id);
  assert.equal(workflowRun.current_step, 'goal_created');
  assert.equal(workflowRun.refs.source, 'create_goal');
});
