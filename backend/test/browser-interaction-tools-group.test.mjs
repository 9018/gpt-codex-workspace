import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserInteractionToolsGroup } from '../src/tool-groups/browser-interaction-tools-group.mjs';

/**
 * Minimal browser registry fakes to test tool group shape and handler wiring.
 * Does NOT depend on browser-http.mjs internals - just the tool group contract.
 */
function fakeBrowserRegistry() {
  const sessions = new Map();

  return {
    closeSession(session_id) {
      sessions.delete(session_id);
      return { session_id, ok: true };
    },
    currentState(session_id) {
      const s = sessions.get(session_id) || { session_id, url: 'https://example.com', title: 'Test' };
      return { session_id: s.session_id, url: s.url, title: s.title };
    },
    extractLinks(session_id, limit) {
      return { session_id, links: [{ href: 'https://example.com', text: 'Example' }], total: 1, limit };
    },
    click(session_id, selector) {
      return { session_id, selector, ok: true };
    },
    fill(session_id, selector, text) {
      return { session_id, selector, text, ok: true };
    },
    press(session_id, selector, key) {
      return { session_id, selector, key, ok: true };
    },
    waitForSelector(session_id, selector) {
      return { session_id, selector, ok: true };
    },
    scroll(session_id, x, y) {
      return { session_id, x, y, ok: true };
    },
    evaluate(session_id, script) {
      return { session_id, script, result: null };
    },
  };
}

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('createBrowserInteractionToolsGroup returns 8 expected tool registrations (experimental hidden by default)', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  // Default: 12 tools - 4 experimental (screenshot, set_input_files, click_and_download, evaluate) = 8
  assert.deepEqual(Object.keys(tools), [
    'browser_close_session',
    'browser_current_state',
    'browser_extract_links',
    'browser_click',
    'browser_fill',
    'browser_press',
    'browser_wait_for_selector',
    'browser_scroll',
  ]);
});

test('createBrowserInteractionToolsGroup exposes experimental tools when GPTWORK_EXPERIMENTAL_BROWSER_TOOLS=true', () => {
  process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS = 'true';
  try {
    const browser = fakeBrowserRegistry();
    const tools = createBrowserInteractionToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      browser,
    });

    // All 12 tools visible
    assert.equal(Object.keys(tools).length, 12);
    assert.ok(tools.browser_screenshot);
    assert.ok(tools.browser_set_input_files);
    assert.ok(tools.browser_click_and_download);
    assert.ok(tools.browser_evaluate);
  } finally {
    delete process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS;
  }
});

test('createBrowserInteractionToolsGroup exposes experimental tools when GPTWORK_EXPOSE_PLACEHOLDER_TOOLS=true', () => {
  process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = 'true';
  try {
    const browser = fakeBrowserRegistry();
    const tools = createBrowserInteractionToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      browser,
    });

    assert.equal(Object.keys(tools).length, 12);
    assert.ok(tools.browser_screenshot);
    assert.ok(tools.browser_set_input_files);
    assert.ok(tools.browser_click_and_download);
    assert.ok(tools.browser_evaluate);
  } finally {
    delete process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
  }
});

test('browser_close_session handler returns ok', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_close_session.handler({ session_id: 'test-1' });
  assert.equal(result.session_id, 'test-1');
  assert.equal(result.ok, true);
});

test('browser_current_state handler returns state', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_current_state.handler({ session_id: 'test-1' });
  assert.equal(result.session_id, 'test-1');
  assert.ok(typeof result.title === 'string');
});

test('browser_extract_links handler returns links', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_extract_links.handler({ session_id: 'test-1', limit: 5 });
  assert.equal(result.session_id, 'test-1');
  assert.ok(Array.isArray(result.links));
  assert.equal(result.limit, 5);
});

test('browser_click handler records click', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_click.handler({ session_id: 'test-1', selector: '#btn' });
  assert.equal(result.session_id, 'test-1');
  assert.equal(result.selector, '#btn');
});

test('browser_fill handler records fill', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_fill.handler({ session_id: 'test-1', selector: '#input', text: 'hello' });
  assert.equal(result.session_id, 'test-1');
  assert.equal(result.text, 'hello');
});

test('browser_press handler records press', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_press.handler({ session_id: 'test-1', selector: '#btn', key: 'Enter' });
  assert.equal(result.key, 'Enter');
});

test('browser_wait_for_selector handler waits', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_wait_for_selector.handler({ session_id: 'test-1', selector: '#loaded' });
  assert.equal(result.session_id, 'test-1');
  assert.equal(result.ok, true);
});

test('browser_scroll handler records scroll', async () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  const result = await tools.browser_scroll.handler({ session_id: 'test-1', x: 0, y: 100 });
  assert.equal(result.x, 0);
  assert.equal(result.y, 100);
});

test('experimental browser_screenshot returns error with expected shape', async () => {
  // Test with experimental tools exposed
  process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS = 'true';
  try {
    const browser = fakeBrowserRegistry();
    const tools = createBrowserInteractionToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      browser,
    });

    assert.ok(tools.browser_screenshot);
    assert.ok(tools.browser_screenshot.description.startsWith('[EXPERIMENTAL]'));
    // Call handler
    const result = await tools.browser_screenshot.handler({ session_id: 'test-1' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('screenshots require'));
  } finally {
    delete process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS;
  }
});

test('descriptions match original tool names', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  assert.equal(tools.browser_close_session.description, 'Close a browser session.');
  assert.equal(tools.browser_current_state.description, 'Return current page URL and title.');
  assert.equal(tools.browser_extract_links.description, 'Extract links.');
  assert.ok(tools.browser_click.description.startsWith('Record a click target'));
  assert.ok(tools.browser_fill.description.startsWith('Record input fill target'));
  assert.ok(tools.browser_press.description.startsWith('Record key press'));
  assert.ok(tools.browser_wait_for_selector.description.startsWith('Wait for selector'));
  assert.ok(tools.browser_scroll.description.startsWith('Record scroll target'));
});

test('schemas include required fields for each tool', () => {
  const browser = fakeBrowserRegistry();
  const tools = createBrowserInteractionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    browser,
  });

  assert.deepEqual(tools.browser_close_session.inputSchema.required, ['session_id']);
  assert.deepEqual(tools.browser_current_state.inputSchema.required, ['session_id']);
  assert.deepEqual(tools.browser_extract_links.inputSchema.required, ['session_id']);
  assert.deepEqual(tools.browser_click.inputSchema.required, ['session_id', 'selector']);
  assert.deepEqual(tools.browser_fill.inputSchema.required, ['session_id', 'selector', 'text']);
  assert.deepEqual(tools.browser_press.inputSchema.required, ['session_id', 'selector', 'key']);
  assert.deepEqual(tools.browser_wait_for_selector.inputSchema.required, ['session_id', 'selector']);
  assert.deepEqual(tools.browser_scroll.inputSchema.required, ['session_id']);
});
