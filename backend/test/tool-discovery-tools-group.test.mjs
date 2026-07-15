import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDiscoveryToolsGroup } from '../src/tool-groups/tool-discovery-tools-group.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return {
      description: descriptionOrDescriptor.description,
      inputSchema: descriptionOrDescriptor.inputSchema,
      handler: descriptionOrDescriptor.handler,
      metadata: descriptionOrDescriptor.metadata || {},
    };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler, metadata: {} };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('tool-discovery-tools-group: exposes tool_search and tool_describe', () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: {
      search: () => [{ name: 'test_tool', description: 'A test' }],
      get: (name) => ({ name, description: `The ${name}` }),
      list: () => [],
    },
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, ['tool_describe', 'tool_search']);
});

test('tool-discovery-tools-group: tool_search returns bounded ranked results', async () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: {
      search: (query, opts) => {
        assert.equal(query, 'health');
        assert.equal(opts.limit, 10);
        assert.equal(opts.audience, 'chatgpt');
        return [{ name: 'health_check', description: 'Health check', tags: ['system'] }];
      },
      get: () => undefined,
      list: () => [],
    },
  });

  const result = await tools.tool_search.handler({ query: 'health', limit: 10, audience: 'chatgpt' });
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools.length, 1);
  assert.equal(result.count, 1);
  assert.equal(result.tools[0].name, 'health_check');
  assert.equal(result.tools[0].handler, undefined, 'handler must not be exposed');
});

test('tool-discovery-tools-group: tool_describe returns descriptors for names', async () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: {
      search: () => [],
      get: (name) => {
        if (name === 'health_check') return { name: 'health_check', description: 'Health check' };
        if (name === 'runtime_status') return { name: 'runtime_status', description: 'Runtime status' };
        return undefined;
      },
      list: () => [],
    },
  });

  const result = await tools.tool_describe.handler({ names: ['health_check', 'runtime_status', 'nonexistent'] });
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools.length, 2);
  assert.equal(result.found, 2);
  assert.equal(result.not_found.length, 1);
  assert.equal(result.not_found[0], 'nonexistent');
});

test('tool-discovery-tools-group: tool_describe returns empty for no names', async () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: { search: () => [], get: () => undefined, list: () => [] },
  });

  const result = await tools.tool_describe.handler({ names: [] });
  assert.deepEqual(result.tools, []);
  assert.equal(result.found, 0);
  assert.deepEqual(result.not_found, []);
});

test('tool-discovery-tools-group: tool_search without query returns all tools', async () => {
  let calledWithEmpty = false;
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: {
      search: (query) => {
        if (query === '') calledWithEmpty = true;
        return [];
      },
      get: () => undefined,
      list: () => [{ name: 'tool_a' }, { name: 'tool_b' }],
    },
  });

  const result = await tools.tool_search.handler({ query: '', limit: 5 });
  assert.equal(calledWithEmpty, true);
});

test('tool-discovery-tools-group: tool_search with include_schema adds schema info', async () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: {
      search: () => [{ name: 'test_tool', description: 'Test', inputSchema: { type: 'object' } }],
      get: () => undefined,
      list: () => [],
    },
  });

  const noSchema = await tools.tool_search.handler({ query: 'test', include_schema: false });
  assert.equal(noSchema.tools[0].inputSchema, undefined);

  const withSchema = await tools.tool_search.handler({ query: 'test', include_schema: true });
  assert.deepEqual(withSchema.tools[0].inputSchema, { type: 'object' });
});

test('tool-discovery-tools-group: handlers are callable and never throw on empty catalog', async () => {
  const tools = createToolDiscoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    catalog: { search: () => [], get: () => undefined, list: () => [] },
  });

  const searchResult = await tools.tool_search.handler({ query: '' });
  assert.ok(Array.isArray(searchResult.tools));

  const describeResult = await tools.tool_describe.handler({ names: [] });
  assert.ok(Array.isArray(describeResult.tools));
});
