import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCatalog, normalizeToolDescriptor } from '../src/tool-discovery/tool-catalog.mjs';

test('tool-catalog: normalizeToolDescriptor extracts metadata without handler', () => {
  const tool = {
    description: 'A test tool',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    handler: () => {},
    metadata: {
      name: 'test_tool',
      audience: ['chatgpt'],
      modes: ['standard', 'full'],
      tags: ['test', 'utility'],
      annotations: { side_effect: 'none' },
    },
  };

  const desc = normalizeToolDescriptor('test_tool', tool);

  assert.equal(desc.name, 'test_tool');
  assert.equal(desc.description, 'A test tool');
  assert.deepEqual(desc.tags, ['test', 'utility']);
  assert.deepEqual(desc.audience, ['chatgpt']);
  assert.deepEqual(desc.modes, ['standard', 'full']);
  assert.deepEqual(desc.inputSchema, { type: 'object', properties: { x: { type: 'string' } } });
  assert.equal(desc.handler, undefined, 'handler must not be exposed');
  assert.equal(desc.metadata?.side_effect, 'none');
});

test('tool-catalog: normalizeToolDescriptor falls back to defaults for bare tool', () => {
  const tool = { description: 'Bare tool', inputSchema: {}, handler: () => {} };
  const desc = normalizeToolDescriptor('bare_tool', tool);

  assert.equal(desc.name, 'bare_tool');
  assert.equal(desc.description, 'Bare tool');
  assert.deepEqual(desc.tags, []);
  assert.deepEqual(desc.audience, []);
  assert.deepEqual(desc.modes, []);
  assert.equal(desc.handler, undefined);
});

test('tool-catalog: createToolCatalog produces list/get/search interface', () => {
  const tools = {
    health_check: {
      description: 'Health check endpoint',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'health_check', tags: ['system'], audience: ['chatgpt'], modes: ['full'] },
    },
    runtime_status: {
      description: 'Runtime status',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'runtime_status', tags: ['system'], audience: ['chatgpt'], modes: ['full'] },
    },
  };

  const catalog = createToolCatalog(tools);

  // list()
  const all = catalog.list();
  assert.equal(all.length, 2);
  assert.ok(all.every(d => d.handler === undefined));

  // get()
  const hc = catalog.get('health_check');
  assert.ok(hc);
  assert.equal(hc.name, 'health_check');
  assert.equal(catalog.get('nonexistent'), undefined);

  // search()
  const found = catalog.search('health');
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'health_check');
});

test('tool-catalog: search with filters (audience, mode, tags)', () => {
  const tools = {
    op_tool: {
      description: 'Operator only tool',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'op_tool', tags: ['admin'], audience: ['operator'], modes: ['operator'] },
    },
    chat_tool: {
      description: 'ChatGPT tool',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'chat_tool', tags: ['utility'], audience: ['chatgpt'], modes: ['standard'] },
    },
    both_tool: {
      description: 'Both tool',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'both_tool', tags: ['common'], audience: ['chatgpt', 'operator'], modes: ['standard', 'full'] },
    },
  };

  const catalog = createToolCatalog(tools);

  // Filter by audience
  const opOnly = catalog.search('', { audience: 'operator' });
  assert.equal(opOnly.length, 2);
  assert.ok(opOnly.every(d => d.audience.includes('operator')));

  // Filter by mode
  const stdOnly = catalog.search('', { mode: 'standard' });
  assert.equal(stdOnly.length, 2);

  // Filter by tag
  const tagged = catalog.search('', { tags: ['admin'] });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].name, 'op_tool');

  // Combined
  const combined = catalog.search('', { audience: 'chatgpt', tags: ['common'] });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].name, 'both_tool');
});

test('tool-catalog: search respects limit and is bounded', () => {
  const tools = {};
  for (let i = 0; i < 50; i++) {
    const name = `tool_${i}`;
    tools[name] = {
      description: `Tool number ${i}`,
      inputSchema: {},
      handler: () => {},
      metadata: { name, tags: ['test'], audience: ['chatgpt'], modes: ['full'] },
    };
  }
  const catalog = createToolCatalog(tools);

  const limited = catalog.search('tool', { limit: 5 });
  assert.equal(limited.length, 5);

  const unlimited = catalog.search('tool');
  assert.equal(unlimited.length, 50);
});

test('tool-catalog: search with combined query filters is deterministic', () => {
  const tools = {
    read_data: {
      description: 'Read data from store',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'read_data', tags: ['read', 'data'], audience: ['chatgpt'], modes: ['standard'] },
    },
    write_data: {
      description: 'Write data to store',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'write_data', tags: ['write', 'data'], audience: ['operator'], modes: ['operator'] },
    },
    delete_data: {
      description: 'Delete data from store',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'delete_data', tags: ['delete', 'data'], audience: ['operator'], modes: ['operator'] },
    },
  };

  const catalog = createToolCatalog(tools);

  // Same query returns same order every time
  const r1 = catalog.search('data', { audience: 'operator' });
  const r2 = catalog.search('data', { audience: 'operator' });
  assert.equal(r1.length, r2.length);
  assert.deepEqual(r1.map(d => d.name), r2.map(d => d.name));
});

test('tool-catalog: search re-ranks based on query relevance', () => {
  const tools = {
    exact_name: {
      description: 'Some tool',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'exact_name', tags: ['example'], audience: ['chatgpt'], modes: ['full'] },
    },
    best_tag_match: {
      description: 'A tool for something',
      inputSchema: {},
      handler: () => {},
      metadata: { name: 'best_tag_match', tags: ['example', 'exact'], audience: ['chatgpt'], modes: ['full'] },
    },
  };

  const catalog = createToolCatalog(tools);
  const results = catalog.search('exact');

  // Both match, first should have higher rank (exact name match vs tag match)
  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'exact_name');
});

test('tool-catalog: search is read-only and never exposes handler', () => {
  const tools = {
    secret_tool: {
      description: 'Secret tool',
      inputSchema: {},
      handler: () => 'secret',
      metadata: { name: 'secret_tool', tags: ['secret'], audience: ['chatgpt'], modes: ['full'] },
    },
  };

  const catalog = createToolCatalog(tools);
  const results = catalog.search('secret');
  assert.equal(results.length, 1);
  assert.equal(results[0].handler, undefined);
  assert.equal(catalog.get('secret_tool').handler, undefined);
});
