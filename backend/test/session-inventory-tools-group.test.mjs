import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionInventoryToolsGroup,
  listCodexSessionsMetadata,
  readCodexNativeSession,
  summarizeCodexNativeSession,
  listCodexNativeSessions,
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
    'codex_native_goal_pause',
    'codex_native_goal_clear',
    'codex_native_goal_stop',
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
        send: async (id, text) => { calls.push(['send', id, text]); return { id, text, sent: true }; },
        stop: async (id) => ({ id, status: 'detached' }),
      },
    });
    const write = { user_id: 'test', scopes: ['workspace:write', 'workspace:read'] };
    const attached = await tools.codex_native_session_attach.handler({ relative_path: name, cwd: '/repo' }, write);
    assert.equal(attached.control_session_id, 'native_123');
    assert.deepEqual(calls[0][1].resumeNativeSessionId, '12345678-1234-1234-1234-123456789abc');
    assert.equal((await tools.codex_native_session_status.handler({ control_session_id: 'native_123' }, write)).status, 'running');
    assert.equal((await tools.codex_native_session_send.handler({ control_session_id: 'native_123', text: 'continue' }, write)).sent, true);
    assert.equal((await tools.codex_native_goal_pause.handler({ control_session_id: 'native_123' }, write)).goal_action, 'pause_requested');
    assert.equal(calls.at(-1)[0], 'send');
    assert.equal(calls.at(-1)[2], '/goal pause\r');
    assert.equal((await tools.codex_native_goal_clear.handler({ control_session_id: 'native_123' }, write)).goal_action, 'clear_requested');
    assert.equal(calls.at(-1)[2], '/goal clear\r');
    assert.equal((await tools.codex_native_session_detach.handler({ control_session_id: 'native_123' }, write)).status, 'detached');
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('readCodexNativeSession leaves an incomplete trailing JSONL record for the next page', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-codex-native-page-'));
  try {
    const sessionsRoot = join(codexHome, 'sessions', '2026', '07', '19');
    await mkdir(sessionsRoot, { recursive: true });
    const filename = 'rollout-2026-07-19T00-00-00-019f7680-023a-7952-856c-cc24be4e4021.jsonl';
    const first = JSON.stringify({ timestamp: '2026-07-19T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n';
    const second = JSON.stringify({ timestamp: '2026-07-19T00:00:01.000Z', type: 'response_item', payload: { role: 'assistant', content: 'x'.repeat(5000) } }) + '\n';
    await writeFile(join(sessionsRoot, filename), first + second);

    const result = await readCodexNativeSession(
      { codexHome },
      { relative_path: `2026/07/19/${filename}`, cursor: 0, max_bytes: first.length + 100 },
      { user_id: 'test', scopes: ['workspace:read'] },
    );

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].raw_type, 'event_msg');
    assert.equal(result.next_cursor, first.length);
    assert.equal(result.eof, false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});


test('summarizeCodexNativeSession extracts resume-style metadata and terminal status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-native-summary-'));
  try {
    const relativePath = '2026/07/19/rollout-2026-07-19T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl';
    const absolutePath = join(root, relativePath);
    await mkdir(join(root, '2026', '07', '19'), { recursive: true });
    const lines = [
      { timestamp: '2026-07-19T00:00:00Z', type: 'session_meta', payload: { cwd: '/repo/project' } },
      { timestamp: '2026-07-19T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }] } },
      { timestamp: '2026-07-19T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '分析项目代码，执行完整链路测试' }] } },
      { timestamp: '2026-07-19T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '开始检查。' }] } },
      { timestamp: '2026-07-19T00:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '检查完成。' }] } },
      { timestamp: '2026-07-19T00:00:05Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    await writeFile(absolutePath, lines.map(JSON.stringify).join('\n') + '\n');
    const info = await (await import('node:fs/promises')).stat(absolutePath);
    const result = await summarizeCodexNativeSession({ absolutePath, relativePath, stat: info, activeNativeSessionIds: new Set() });
    assert.equal(result.session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(result.title, '分析项目代码，执行完整链路测试');
    assert.equal(result.cwd, '/repo/project');
    assert.equal(result.message_count, 4);
    assert.equal(result.last_assistant_message, '检查完成。');
    assert.equal(result.status, 'finished');
    assert.equal(result.attachable, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('listCodexNativeSessions filters tests, isolates malformed files, sorts, and limits', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-native-list-'));
  try {
    const dir = join(codexHome, 'sessions', '2026', '07', '19'); await mkdir(dir, { recursive: true });
    const business = join(dir, 'rollout-11111111-1111-1111-1111-111111111111.jsonl');
    const testFile = join(dir, 'rollout-22222222-2222-2222-2222-222222222222.jsonl');
    const malformed = join(dir, 'rollout-33333333-3333-3333-3333-333333333333.jsonl');
    await writeFile(business, JSON.stringify({ type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text',text:'真实业务任务'}] } })+'\n');
    await writeFile(testFile, JSON.stringify({ type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text',text:'__gptwork_test_invalid_arg__'}] } })+'\n');
    await writeFile(malformed, '{not-json}\n');
    const now = Date.now(); const { utimes } = await import('node:fs/promises');
    await utimes(business, now/1000-20, now/1000-20); await utimes(testFile, now/1000-10, now/1000-10); await utimes(malformed, now/1000, now/1000);
    const context = { user_id:'test', scopes:['workspace:read'] };
    const result = await listCodexNativeSessions({ codexHome }, { limit: 10 }, context);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].title, '真实业务任务');
    assert.equal(result.filtered_test_sessions, 1);
    assert.equal(result.errors.length, 1);
    const included = await listCodexNativeSessions({ codexHome }, { limit: 1, includeTestSessions: true }, context);
    assert.equal(included.sessions.length, 1);
    assert.equal(included.sessions[0].is_test_session, true);
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('codex_native_sessions_list exposes enriched schema, enforces scope, and maps test-session option', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-native-tool-'));
  try {
    const dir = join(codexHome, 'sessions'); await mkdir(dir, { recursive: true });
    const file = join(dir, 'rollout-44444444-4444-4444-4444-444444444444.jsonl');
    await writeFile(file, JSON.stringify({ type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text',text:'__gptwork_test_invalid_arg__'}] } })+'\n');
    const tools = createSessionInventoryToolsGroup({
      tool: fakeTool, schema: fakeSchema, config: { codexHome }, store: {},
      github: { syncTask: async () => {} }, createTask: async () => ({}),
    });
    assert.deepEqual(tools.codex_native_sessions_list.inputSchema.properties, { limit: 'integer', include_test_sessions: 'boolean' });
    await assert.rejects(() => tools.codex_native_sessions_list.handler({}, { user_id:'test', scopes:[] }), /workspace:read/);
    const result = await tools.codex_native_sessions_list.handler(
      { limit: 10, include_test_sessions: true },
      { user_id:'test', scopes:['workspace:read'] },
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].is_test_session, true);
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('summarizeCodexNativeSession prefers the original goal objective for Resume title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-native-objective-'));
  try {
    const relativePath = 'rollout-55555555-5555-5555-5555-555555555555.jsonl';
    const absolutePath = join(root, relativePath);
    const lines = [
      { type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text',text:'<codex_internal_context source="goal">\n<objective>\n分析项目代码，做实验测试项目执行能力，调用项目接口测试，链路测试\n</objective>\n</codex_internal_context>'}] } },
      { type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text',text:'你不用挨个做后端测试，可以先跳过'}] } },
    ];
    await writeFile(absolutePath, lines.map(JSON.stringify).join('\n')+'\n');
    const info = await (await import('node:fs/promises')).stat(absolutePath);
    const result = await summarizeCodexNativeSession({ absolutePath, relativePath, stat: info, activeNativeSessionIds:new Set() });
    assert.equal(result.title, '分析项目代码，做实验测试项目执行能力，调用项目接口测试，链路测试');
  } finally { await rm(root, { recursive:true, force:true }); }
});
