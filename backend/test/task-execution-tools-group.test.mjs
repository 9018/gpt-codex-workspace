import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionToolsGroup } from '../src/tool-groups/task-execution-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('execution tool group exposes stable public tool names and schemas', () => {
  const tools = createExecutionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork', defaultRepoPath: '/tmp/gptwork/repo' },
    store: {},
    github: { syncTask: async () => {} },
    registry: null,
    normalizeAssignedTaskMode: () => {},
    ensureTaskGoal: async () => {},
    notifyCreatedTaskIfNeeded: () => {},
    runAssignedCodexTasks: async () => {},
  });

  assert.deepEqual(Object.keys(tools), [
    'assign_task_to_codex',
    'run_assigned_codex_tasks',
    'preview_codex_context',
  ]);

  // assign_task_to_codex: required = ['task_id']
  assert.deepEqual(tools.assign_task_to_codex.inputSchema.required, ['task_id']);
  assert.equal(tools.assign_task_to_codex.inputSchema.properties.task_id, 'string');
  assert.equal(tools.assign_task_to_codex.inputSchema.properties.mode, 'string');
  assert.ok(tools.assign_task_to_codex.description.includes('Assign a task to Codex'));

  // run_assigned_codex_tasks: all optional
  assert.deepEqual(tools.run_assigned_codex_tasks.inputSchema.required, []);
  assert.equal(tools.run_assigned_codex_tasks.inputSchema.properties.limit, 'integer');
  assert.equal(tools.run_assigned_codex_tasks.inputSchema.properties.concurrency, 'integer');
  assert.ok(tools.run_assigned_codex_tasks.description.includes('Process assigned tasks'));

  // preview_codex_context: required = ['task_id']
  assert.deepEqual(tools.preview_codex_context.inputSchema.required, ['task_id']);
  assert.equal(tools.preview_codex_context.inputSchema.properties.task_id, 'string');
  assert.ok(tools.preview_codex_context.description.includes('Show what Codex will see'));
});

test('execution tool group assign_task_to_codex handler calls dependencies', async () => {
  // updateTask (from task-lifecycle.mjs) calls store.load(), modifies the task,
  // pushes to state.activities, and calls store.save().
  const store = {
    load: async () => ({
      tasks: [{ id: 'new-task', assignee: '', status: 'pending', mode: '' }],
      activities: [],
    }),
    save: async () => {},
  };

  const ensureTaskGoalCalls = [];
  let syncTaskCalled = false;

  const tools = createExecutionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork' },
    store,
    github: {
      syncTask: async (task) => {
        syncTaskCalled = true;
      },
    },
    registry: null,
    normalizeAssignedTaskMode: (task, mode) => mode || 'builder',
    ensureTaskGoal: async (store, config, taskId, context, opts) => {
      ensureTaskGoalCalls.push({ taskId, opts });
      return { goal: { id: 'goal-1' }, task: { id: taskId, assignee: 'codex', status: 'assigned', mode: 'builder' } };
    },
    notifyCreatedTaskIfNeeded: () => {},
    runAssignedCodexTasks: async () => {},
  });

  const context = { user_id: 'test-user' };
  const result = await tools.assign_task_to_codex.handler(
    { task_id: 'new-task', mode: 'deploy' },
    context,
  );

  assert.equal(ensureTaskGoalCalls.length, 1);
  assert.equal(ensureTaskGoalCalls[0].taskId, 'new-task');
  assert.deepEqual(ensureTaskGoalCalls[0].opts, { assign_to_codex: true, sync_execution_profile: true });
  assert.equal(result.goal.id, 'goal-1');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(syncTaskCalled, true);
});

test('execution tool group run_assigned_codex_tasks handler delegates correctly', async () => {
  let delegateCalled = false;

  const tools = createExecutionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { test: true },
    store: { test: true },
    github: { syncTask: async () => {} },
    registry: null,
    normalizeAssignedTaskMode: () => {},
    ensureTaskGoal: async () => {},
    notifyCreatedTaskIfNeeded: () => {},
    runAssignedCodexTasks: async (store, config, github, args, context) => {
      delegateCalled = true;
      assert.equal(args.limit, 5);
      assert.equal(args.concurrency, 2);
      return { processed: ['task-1'] };
    },
  });

  const result = await tools.run_assigned_codex_tasks.handler({ limit: 5, concurrency: 2 }, { user_id: 'worker' });
  assert.equal(delegateCalled, true);
  assert.deepEqual(result, { processed: ['task-1'] });
});

test('execution tool group preview_codex_context handler exists with correct shape', () => {
  const tools = createExecutionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: {},
    registry: null,
    normalizeAssignedTaskMode: () => {},
    ensureTaskGoal: async () => {},
    notifyCreatedTaskIfNeeded: () => {},
    runAssignedCodexTasks: async () => {},
  });

  assert.equal(typeof tools.preview_codex_context.handler, 'function');
});
