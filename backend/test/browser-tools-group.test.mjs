import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserToolsGroup } from '../src/tool-groups/browser-tools-group.mjs';

/**
 * Minimal browser registry fakes to test tool group shape and handler wiring.
 * Does NOT depend on browser-http.mjs internals — just the tool group contract.
 */
function fakeBrowserRegistry() {
  const sessions = new Map();

  return {
    newSession(opts = {}) {
      const session = { session_id: 'test-' + Math.random().toString(36).slice(2), ...opts };
      sessions.set(session.session_id, session);
      return session;
    },
    listSessions() {
      return { sessions: [...sessions.values()] };
    },
    async goto(session_id, url) {
      const session = sessions.get(session_id);
      if (!session) throw new Error(`browser session not found: ${session_id}`);
      session.url = url;
      session.html = '<html><head><title>Test</title></head><body>Hello</body></html>';
      session.text = 'Hello';
      return { session_id, url, title: 'Test' };
    },
    getText(session_id, max_chars = 20000) {
      return { session_id, text: 'Hello world', truncated: false };
    },
    getHtml(session_id, max_chars = 50000) {
      return { session_id, html: '<html><body>Hello world</body></html>', truncated: false };
    },
  };
}

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('createBrowserToolsGroup returns 5 expected tool registrations', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  assert.deepEqual(Object.keys(tools), [
    'browser_new_session',
    'browser_list_sessions',
    'browser_goto',
    'browser_get_text',
    'browser_get_html',
  ]);
});

test('browser_new_session handler creates a session', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_new_session.handler({});
  assert.ok(result.session_id);
  assert.equal(typeof result.session_id, 'string');
});

test('browser_list_sessions handler returns sessions list', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  // Create a session first
  await tools.browser_new_session.handler({});
  const result = await tools.browser_list_sessions.handler();
  assert.ok(Array.isArray(result.sessions));
  assert.equal(result.sessions.length, 1);
});

test('browser_goto handler navigates to a URL', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const created = await tools.browser_new_session.handler({});
  const result = await tools.browser_goto.handler({
    session_id: created.session_id,
    url: 'https://example.com',
  });
  assert.equal(result.session_id, created.session_id);
  assert.equal(result.url, 'https://example.com');
  assert.equal(result.title, 'Test');
});

test('browser_get_text handler extracts text', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const created = await tools.browser_new_session.handler({});
  // Navigate first
  await tools.browser_goto.handler({
    session_id: created.session_id,
    url: 'https://example.com',
  });
  const result = await tools.browser_get_text.handler({
    session_id: created.session_id,
  });
  assert.equal(result.session_id, created.session_id);
  assert.ok(typeof result.text, 'string');
});

test('browser_get_html handler extracts html', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const created = await tools.browser_new_session.handler({});
  // Navigate first
  await tools.browser_goto.handler({
    session_id: created.session_id,
    url: 'https://example.com',
  });
  const result = await tools.browser_get_html.handler({
    session_id: created.session_id,
  });
  assert.equal(result.session_id, created.session_id);
  assert.ok(typeof result.html, 'string');
});

test('createBrowserToolsGroup tool descriptions match original', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  assert.equal(tools.browser_new_session.description,
    'Create a lightweight HTTP browser session (no JS execution, no real rendering).');
  assert.equal(tools.browser_list_sessions.description,
    'List browser sessions.');
  assert.equal(tools.browser_goto.description,
    'Navigate a browser session to a URL. Performs a server-side HTTP GET; page JavaScript is not executed.');
  assert.equal(tools.browser_get_text.description,
    'Extract visible inner text.');
  assert.equal(tools.browser_get_html.description,
    'Extract HTML.');
});

test('createBrowserToolsGroup schemas include required fields', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  assert.deepEqual(tools.browser_new_session.inputSchema.required, []);
  assert.deepEqual(tools.browser_list_sessions.inputSchema.required, []);
  assert.deepEqual(tools.browser_goto.inputSchema.required, ['session_id', 'url']);
  assert.deepEqual(tools.browser_get_text.inputSchema.required, ['session_id']);
  assert.deepEqual(tools.browser_get_html.inputSchema.required, ['session_id']);
});
