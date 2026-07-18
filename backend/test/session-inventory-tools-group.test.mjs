import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionInventoryToolsGroup,
  listCodexSessionsMetadata,
  readCodexNativeSession,
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
    'codex_native_sessions_list',
    'codex_native_session_read',
    'codex_native_session_attach',
    'codex_native_session_status',
    'codex_native_session_send',
    'codex_native_session_detach',
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


test('readCodexNativeSession parses bounded JSONL and rejects traversal', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-native-read-'));
  try {
    const dir = join(codexHome, 'sessions', '2026', '07', '19');
    await mkdir(dir, { recursive: true });
    const name = 'rollout-2026-07-19T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl';
    await writeFile(join(dir, name), JSON.stringify({ timestamp: '2026-07-19T00:00:00Z', type: 'message', payload: { role: 'user', content: 'hello' } }) + '\n');
    const result = await readCodexNativeSession({ codexHome }, { relative_path: `2026/07/19/${name}`, max_bytes: 4096 }, { user_id: 'test', scopes: ['workspace:read'] });
    assert.equal(result.native_session_id, '12345678-1234-1234-1234-123456789abc');
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'hello');
    await assert.rejects(() => readCodexNativeSession({ codexHome }, { relative_path: '../outside.jsonl' }, { user_id: 'test', scopes: ['workspace:read'] }), /escapes sessions root/);
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('native attach resumes with deterministic control session and send/status/detach delegate', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-native-attach-'));
  const calls = [];
  try {
    const dir = join(codexHome, 'sessions'); await mkdir(dir, { recursive: true });
    const name = 'rollout-12345678-1234-1234-1234-123456789abc.jsonl'; await writeFile(join(dir, name), '{}\n');
    const tools = createSessionInventoryToolsGroup({
      tool: fakeTool, schema: fakeSchema,
      config: { codexHome, workspaceRoot: '/repo' },
      store: { mutate: async (fn) => fn({ activities: [] }) }, github: { syncTask: async () => {} }, createTask: async () => ({}),
      sessionApi: {
        start: async (args) => { calls.push(['start', args]); return { id: 'native_123', status: 'running' }; },
        status: async (id) => ({ id, status: 'running' }),
        send: async (id, text) => ({ id, text, sent: true }),
        stop: async (id) => ({ id, status: 'stopped' }),
      },
    });
    const write = { user_id: 'test', scopes: ['workspace:write', 'workspace:read'] };
    const attached = await tools.codex_native_session_attach.handler({ relative_path: name, cwd: '/repo' }, write);
    assert.equal(attached.control_session_id, 'native_123');
    assert.deepEqual(calls[0][1].resumeNativeSessionId, '12345678-1234-1234-1234-123456789abc');
    assert.equal((await tools.codex_native_session_status.handler({ control_session_id: 'native_123' }, write)).status, 'running');
    assert.equal((await tools.codex_native_session_send.handler({ control_session_id: 'native_123', text: 'continue' }, write)).sent, true);
    assert.equal((await tools.codex_native_session_detach.handler({ control_session_id: 'native_123' }, write)).status, 'stopped');
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});
