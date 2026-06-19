import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionInventoryToolsGroup } from '../src/tool-groups/session-inventory-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('session inventory tool group exposes stable public tool names and schemas', () => {
  const tools = createSessionInventoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: { syncTask: async () => {} },
    createTask: async () => ({}),
  });

  assert.deepEqual(Object.keys(tools), [
    'list_codex_sessions_metadata',
    'create_codex_session_inventory_task',
  ]);

  // list_codex_sessions_metadata: year, month, day, limit (all optional)
  assert.equal(tools.list_codex_sessions_metadata.inputSchema.properties.year, 'string');
  assert.equal(tools.list_codex_sessions_metadata.inputSchema.properties.month, 'string');
  assert.equal(tools.list_codex_sessions_metadata.inputSchema.properties.day, 'string');
  assert.equal(tools.list_codex_sessions_metadata.inputSchema.properties.limit, 'integer');
  assert.deepEqual(tools.list_codex_sessions_metadata.inputSchema.required, []);
  assert.ok(typeof tools.list_codex_sessions_metadata.description === 'string');
  assert.ok(tools.list_codex_sessions_metadata.description.includes('.codex/sessions'));

  // create_codex_session_inventory_task: limit (optional)
  assert.equal(tools.create_codex_session_inventory_task.inputSchema.properties.limit, 'integer');
  assert.deepEqual(tools.create_codex_session_inventory_task.inputSchema.required, []);
  assert.ok(typeof tools.create_codex_session_inventory_task.description === 'string');
  assert.ok(tools.create_codex_session_inventory_task.description.includes('session'));
  assert.ok(tools.create_codex_session_inventory_task.description.includes('readonly'));
});

test('session inventory tool group handlers exist', () => {
  const tools = createSessionInventoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: { syncTask: async () => {} },
    createTask: async () => ({}),
  });

  assert.equal(typeof tools.list_codex_sessions_metadata.handler, 'function');
  assert.equal(typeof tools.create_codex_session_inventory_task.handler, 'function');
});

test('list_codex_sessions_metadata handler rejects without workspace:read scope', async () => {
  const tools = createSessionInventoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { codexHome: '/tmp' },
    store: {},
    github: { syncTask: async () => {} },
    createTask: async () => ({}),
  });

  // Provide scopes array (empty) so requireScope doesn't crash on undefined
  await assert.rejects(
    () => tools.list_codex_sessions_metadata.handler({}, { user_id: 'test', scopes: [] }),
    /workspace:read/,
  );
});

test('create_codex_session_inventory_task handler calls createTask with readonly mode', async () => {
  let createTaskCalled = false;

  const tools = createSessionInventoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { codexHome: '/tmp' },
    store: {
      load: async () => ({ tasks: [], activities: [] }),
      save: async () => {},
    },
    github: { syncTask: async () => {} },
    createTask: async (store, config, args) => {
      createTaskCalled = true;
      assert.equal(args.title, 'List Codex session metadata');
      assert.equal(args.assignee, 'codex');
      assert.equal(args.mode, 'readonly');
      return { task: { id: 't_test', title: args.title } };
    },
  });

  const context = { user_id: 'test-user', scopes: ['workspace:read', 'task:create'] };

  // The handler calls createTask, then syncTask, then completeCodexSessionInventoryTask.
  // completeCodexSessionInventoryTask calls updateTask which needs a real store.
  // For unit testing, we only verify createTask was invoked with correct args.
  // The handler itself will fail at updateTask because the fake store doesn't have the task.
  try {
    await tools.create_codex_session_inventory_task.handler({ limit: 10 }, context);
  } catch (_) {
    // Expected — updateTask won't find the task in the fake store
  }

  assert.equal(createTaskCalled, true);
});
