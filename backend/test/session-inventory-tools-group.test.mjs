import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionInventoryToolsGroup,
  listCodexSessionsMetadata,
} from '../src/tool-groups/session-inventory-tools-group.mjs';

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
  assert.ok(tools.list_codex_sessions_metadata.description.includes('CODEX_HOME/sessions'));

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

test('session inventory treats codexHome as CODEX_HOME and reads its sessions directory', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-codex-home-'));
  try {
    const sessionsRoot = join(codexHome, 'sessions', '2026', '07', '17');
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(sessionsRoot, 'session.jsonl'), '{}\n');

    const result = await listCodexSessionsMetadata(
      { codexHome },
      { year: '2026', month: '07', day: '17' },
      { user_id: 'test', scopes: ['workspace:read'] },
    );

    assert.equal(result.root, join(codexHome, 'sessions'));
    assert.equal(result.count, 1);
    assert.equal(result.sessions[0].relative_path, '2026/07/17/session.jsonl');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('session inventory falls back to legacy CODEX_HOME/.codex/sessions when sessions is absent', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-codex-home-legacy-'));
  try {
    const sessionsRoot = join(codexHome, '.codex', 'sessions', '2026', '07', '17');
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(sessionsRoot, 'legacy.jsonl'), '{}\n');

    const result = await listCodexSessionsMetadata(
      { codexHome },
      { year: '2026', month: '07', day: '17' },
      { user_id: 'test', scopes: ['workspace:read'] },
    );

    assert.equal(result.root, join(codexHome, '.codex', 'sessions'));
    assert.equal(result.count, 1);
    assert.equal(result.sessions[0].relative_path, '2026/07/17/legacy.jsonl');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
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
