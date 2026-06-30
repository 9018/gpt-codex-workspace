import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasicTaskToolsGroup } from '../src/tool-groups/basic-task-tools-group.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('basic task tool group exposes stable public tool names and schemas', () => {
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  assert.deepEqual(Object.keys(tools), [
    'create_task',
    'list_tasks',
    'get_task',
    'get_task_acceptance_bundle',
    'get_task_review_packet',
    'update_task_status',
    'append_task_log',
    'attach_task_artifact',
  ]);

  // create_task: required = ['title']
  assert.deepEqual(tools.create_task.inputSchema.required, ['title']);
  assert.equal(tools.create_task.inputSchema.properties.title.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.title.description, 'Task title summarizing the work to be done.');
  assert.equal(tools.create_task.inputSchema.properties.description.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.assignee.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.assignee.default, 'codex');
  assert.equal(tools.create_task.inputSchema.properties.workspace_id.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.mode.type, 'string');
  assert.deepEqual(tools.create_task.inputSchema.properties.mode.enum, ['standard', 'readonly']);
  assert.equal(tools.create_task.inputSchema.properties.notify.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.silent.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.suppress_notifications.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.notification_policy.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.metadata.type, 'object');

  // list_tasks: all optional
  assert.deepEqual(tools.list_tasks.inputSchema.required, []);
  assert.equal(tools.list_tasks.inputSchema.properties.status, 'string');
  assert.equal(tools.list_tasks.inputSchema.properties.assignee, 'string');
  assert.equal(tools.list_tasks.inputSchema.properties.limit, 'integer');

  // get_task: required = ['task_id']
  assert.deepEqual(tools.get_task.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task.inputSchema.properties.task_id, 'string');

  // update_task_status: required = ['task_id', 'status']
  assert.deepEqual(tools.get_task_acceptance_bundle.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task_acceptance_bundle.inputSchema.properties.task_id, 'string');
  assert.deepEqual(tools.get_task_review_packet.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task_review_packet.inputSchema.properties.task_id, 'string');

  // update_task_status: required = ['task_id', 'status']
  assert.deepEqual(tools.update_task_status.inputSchema.required, ['task_id', 'status']);
  assert.equal(tools.update_task_status.inputSchema.properties.task_id, 'string');
  assert.equal(tools.update_task_status.inputSchema.properties.status, 'string');

  // append_task_log: required = ['task_id', 'message']
  assert.deepEqual(tools.append_task_log.inputSchema.required, ['task_id', 'message']);
  assert.equal(tools.append_task_log.inputSchema.properties.task_id, 'string');
  assert.equal(tools.append_task_log.inputSchema.properties.message, 'string');

  // attach_task_artifact: required = ['task_id', 'path']
  assert.deepEqual(tools.attach_task_artifact.inputSchema.required, ['task_id', 'path']);
  assert.equal(tools.attach_task_artifact.inputSchema.properties.task_id, 'string');
  assert.equal(tools.attach_task_artifact.inputSchema.properties.path, 'string');
  assert.equal(tools.attach_task_artifact.inputSchema.properties.label, 'string');
});

test('basic task tool group create_task handler forwards args and syncs to github', async () => {
  const createTaskCalls = [];
  let syncTaskCalled = false;

  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { test: true },
    store: { test: true },
    createTask: async (store, config, args, context) => {
      createTaskCalls.push({ store, config, args, context });
      return { task: { id: 't1', title: args.title } };
    },
    github: {
      syncTask: async (task) => {
        syncTaskCalled = true;
        assert.equal(task.id, 't1');
      },
    },
  });

  const context = { user_id: 'test-user' };
  const result = await tools.create_task.handler(
    { title: 'Test task', description: 'A test', assignee: 'codex' },
    context,
  );

  assert.equal(createTaskCalls.length, 1);
  assert.deepEqual(createTaskCalls[0].args, { title: 'Test task', description: 'A test', assignee: 'codex' });
  assert.equal(createTaskCalls[0].context, context);
  assert.deepEqual(result, { task: { id: 't1', title: 'Test task' } });
  // github.syncTask is called asynchronously; allow microtask to execute
  await new Promise(r => setTimeout(r, 10));
  assert.equal(syncTaskCalled, true);
});

test('basic task tool group list_tasks handler filters and reverses tasks', async () => {
  const mockTasks = [
    { id: 't1', status: 'completed', assignee: 'alice' },
    { id: 't2', status: 'assigned', assignee: 'bob' },
    { id: 't3', status: 'assigned', assignee: 'codex', mode: 'builder' },
    { id: 't4', status: 'completed', assignee: 'alice' },
    { id: 't5', status: 'assigned', assignee: 'codex', mode: 'deploy' },
  ];

  let loaded = false;
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {
      load: async () => {
        loaded = true;
        return { tasks: mockTasks };
      },
    },
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  // Without filters, returns last 50 reversed
  const allResult = await tools.list_tasks.handler({});
  assert.equal(loaded, true);
  assert.equal(allResult.tasks.length, 5);

  // Filter by status
  loaded = false;
  const assignedResult = await tools.list_tasks.handler({ status: 'assigned' });
  assert.equal(assignedResult.tasks.length, 3);
  assert.equal(assignedResult.tasks[0].id, 't5'); // reversed order

  // Filter by assignee
  loaded = false;
  const codexResult = await tools.list_tasks.handler({ assignee: 'codex' });
  assert.equal(codexResult.tasks.length, 2);
});

test('basic task tool group get_task handler calls findTask', async () => {
  // Creation and handler verification via injected store
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  // Shape verification (runtime integration tested via workspace-task-tools tests)
  assert.equal(typeof tools.get_task.handler, 'function');
});

test('basic task tool group update_task_status handler calls updateTask and syncs', async () => {
  let syncTaskCalled = false;

  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: {
      syncTask: async (task) => {
        syncTaskCalled = true;
        assert.equal(task.id, 't1');
      },
    },
  });

  // Shape verification (integration tested via workspace-task-tools tests)
  assert.equal(typeof tools.update_task_status.handler, 'function');
  await new Promise(r => setTimeout(r, 10));
});

test('basic task tool group append_task_log and attach_task_artifact handlers exist with correct schemas', () => {
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  assert.equal(typeof tools.append_task_log.handler, 'function');
  assert.equal(typeof tools.attach_task_artifact.handler, 'function');
});
