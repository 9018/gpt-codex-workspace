import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextHealthToolsGroup } from '../src/tool-groups/context-health-tools-group.mjs';
import { collectContextIndexStatus } from '../src/diagnostics-service.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

const fakeConfig = {
  defaultRepoPath: '/tmp/fake-repo',
  defaultRepo: 'owner/repo',
  contextVectorStore: 'local',
  contextBundleMaxTokens: 1536,
  contextBundleMaxChunks: 6,
  contextCrossGoalTopK: 3,
  contextPerGoalTopK: 5,
  contextMaxGoalsScanned: 9,
};

const fakeStore = {
  load: async () => ({ tasks: [] }),
};

const fakeRegistry = {
  workspaceRoot: '/tmp/gptwork',
  getDefaultRepo: () => null,
  findByPath: () => null,
  list: () => [],
  get: () => null,
  count: () => 0,
};

test('context health tool group exposes all four tool names', () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, [
    'context_prepare',
    'context_status',
    'detect_stale_clones',
    'project_context_status',
  ]);
});

test('context health tool group has correct input schemas', () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  // detect_stale_clones: no args
  assert.deepEqual(tools.detect_stale_clones.inputSchema.required, []);
  assert.deepEqual(tools.detect_stale_clones.inputSchema.properties, {});

  // project_context_status: optional task_id string
  assert.deepEqual(tools.project_context_status.inputSchema.required, []);
  assert.equal(tools.project_context_status.inputSchema.properties.task_id, 'string');

  // context_status: same as project_context_status
  assert.deepEqual(tools.context_status.inputSchema.required, []);
  assert.equal(tools.context_status.inputSchema.properties.task_id, 'string');

  // context_prepare: optional task_id string, mode string
  assert.deepEqual(tools.context_prepare.inputSchema.required, []);
  assert.equal(tools.context_prepare.inputSchema.properties.task_id, 'string');
  assert.equal(tools.context_prepare.inputSchema.properties.mode, 'string');
});

test('context health tool group has descriptions', () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  for (const name of ['detect_stale_clones', 'project_context_status', 'context_status', 'context_prepare']) {
    assert.equal(typeof tools[name].description, 'string', `${name} should have a description`);
    assert.ok(tools[name].description.length > 10, `${name} description should be meaningful`);
  }
});

test('context health tool group handlers are callable functions', () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  for (const name of ['detect_stale_clones', 'project_context_status', 'context_status', 'context_prepare']) {
    assert.equal(typeof tools[name].handler, 'function', `${name}.handler should be a function`);
  }
});

test('detect_stale_clones handler returns expected shape', async () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  const result = await tools.detect_stale_clones.handler();
  assert.equal(typeof result.count, 'number');
  assert.ok(Array.isArray(result.clones));
});

test('context_prepare handler validates mode', async () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  await assert.rejects(
    () => tools.context_prepare.handler({ mode: 'invalid' }, { scopes: ['task:read'] }),
    /Invalid mode/,
  );
});

test('context_prepare handler returns expected shape keys', async () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  const result = await tools.context_prepare.handler({ mode: 'check' }, { scopes: ['task:read'] });
  const expectedKeys = [
    'mode',
    'changed',
    'actions_planned',
    'actions_applied',
    'skipped_actions',
    'warnings',
    'project_context_status_before',
    'no_secrets_exposed',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in result, `context_prepare response should have key: ${key}`);
  }
  assert.equal(result.mode, 'check');
  assert.equal(result.changed, false);
  assert.ok(Array.isArray(result.actions_planned));
  assert.ok(Array.isArray(result.actions_applied));
  assert.ok(Array.isArray(result.skipped_actions));
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.no_secrets_exposed, true);
});

test('project_context_status exposes safe context_index diagnostics', async () => {
  const tools = createContextHealthToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    registry: fakeRegistry,
    store: fakeStore,
  });

  const result = await tools.project_context_status.handler({}, { scopes: ['task:read'] });

  assert.equal(result.context_index.configured_store, 'local');
  assert.equal(result.context_index.effective_store, 'local-json-store');
  assert.equal(result.context_index.zvec_optional_dependency, 'not_checked');
  assert.equal(result.context_index.bundle_max_tokens, 1536);
  assert.equal(result.context_index.bundle_max_chunks, 6);
  assert.equal(result.context_index.manifest_enabled, true);
  assert.equal(result.context_index.manifest_filename, 'context.manifest.json');
  assert.equal(result.context_index.default_context_package.join(' + '), 'codex.entry.md + context.bundle.md');
  assert.equal(result.context_index.cross_goal_top_k, 3);
  assert.equal(result.context_index.per_goal_top_k, 5);
  assert.equal(result.context_index.max_goals_scanned, 9);
  assert.ok(Array.isArray(result.context_index.warnings));
});

test('context_index diagnostics show auto fallback and zvec strict-mode warning when zvec is unavailable', async () => {
  const unavailable = async () => {
    throw new Error('simulated missing @zvec/zvec');
  };

  const auto = await collectContextIndexStatus({ contextVectorStore: 'auto' }, { importZvec: unavailable });
  assert.equal(auto.configured_store, 'auto');
  assert.equal(auto.effective_store, 'local-json-store');
  assert.equal(auto.zvec_optional_dependency, 'unavailable');
  assert.deepEqual(auto.warnings, []);

  const strict = await collectContextIndexStatus({ contextVectorStore: 'zvec' }, { importZvec: unavailable });
  assert.equal(strict.configured_store, 'zvec');
  assert.equal(strict.effective_store, 'unknown');
  assert.equal(strict.zvec_optional_dependency, 'unavailable');
  assert.match(strict.warnings.join('\n'), /GPTWORK_CONTEXT_VECTOR_STORE=zvec/);
});
