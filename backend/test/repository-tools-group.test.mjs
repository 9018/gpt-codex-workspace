import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryToolsGroup } from '../src/tool-groups/repository-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

/** Build a minimal fake RepoRegistry for testing handlers. */
function createFakeRegistry(overrides = {}) {
  const repos = overrides.repos || [];
  return {
    workspaceRoot: '/tmp/gptwork',
    list: () => repos,
    get: (id) => repos.find(r => r.repo_id === id) || null,
    findByName: (owner, repoName) => repos.find(r => r.owner === owner && r.repo_name === repoName) || null,
    getDefaultRepo: () => repos.length === 1 ? repos[0] : null,
    count: () => repos.length,
    register: async (info) => {
      const record = { repo_id: 'repo_' + Date.now(), ...info };
      repos.push(record);
      return record;
    },
    ...overrides,
  };
}

const emptyRegistry = createFakeRegistry();

const sampleRepo = {
  repo_id: 'test_001',
  owner: 'acme',
  repo_name: 'demo',
  canonical_path: '/tmp/gptwork/acme_demo',
  remote_url: 'https://github.com/acme/demo.git',
  default_branch: 'main',
};

const singleRepoRegistry = createFakeRegistry({ repos: [sampleRepo] });

test('repository tool group exposes all four tool names', () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, [
    'get_repository_status',
    'list_repositories',
    'register_repository',
    'resolve_canonical_repository',
  ]);
});

test('repository tool group has correct input schemas', () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  // register_repository: required remote_url
  assert.deepEqual(tools.register_repository.inputSchema.required, ['remote_url']);
  assert.equal(tools.register_repository.inputSchema.properties.remote_url, 'string');
  assert.equal(tools.register_repository.inputSchema.properties.canonical_path, 'string');
  assert.equal(tools.register_repository.inputSchema.properties.default_branch, 'string');

  // list_repositories: no args
  assert.deepEqual(tools.list_repositories.inputSchema.required, []);
  assert.deepEqual(tools.list_repositories.inputSchema.properties, {});

  // get_repository_status: optional args
  assert.deepEqual(tools.get_repository_status.inputSchema.required, []);
  assert.equal(tools.get_repository_status.inputSchema.properties.repo_id, 'string');
  assert.equal(tools.get_repository_status.inputSchema.properties.owner, 'string');
  assert.equal(tools.get_repository_status.inputSchema.properties.repo_name, 'string');

  // resolve_canonical_repository: optional args
  assert.deepEqual(tools.resolve_canonical_repository.inputSchema.required, []);
  assert.equal(tools.resolve_canonical_repository.inputSchema.properties.repo_id, 'string');
  assert.equal(tools.resolve_canonical_repository.inputSchema.properties.owner, 'string');
  assert.equal(tools.resolve_canonical_repository.inputSchema.properties.repo_name, 'string');
});

test('repository tool group has descriptions', () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  for (const name of ['register_repository', 'list_repositories', 'get_repository_status', 'resolve_canonical_repository']) {
    assert.equal(typeof tools[name].description, 'string', `${name} should have a description`);
    assert.ok(tools[name].description.length > 10, `${name} description should be meaningful`);
  }
});

test('repository tool group handlers are callable functions', () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  for (const name of ['register_repository', 'list_repositories', 'get_repository_status', 'resolve_canonical_repository']) {
    assert.equal(typeof tools[name].handler, 'function', `${name}.handler should be a function`);
  }
});

test('list_repositories returns empty list when no repos registered', async () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  const result = await tools.list_repositories.handler();
  assert.equal(result.count, 0);
  assert.deepEqual(result.repositories, []);
});

test('list_repositories returns registered repos', async () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: singleRepoRegistry,
  });

  const result = await tools.list_repositories.handler();
  assert.equal(result.count, 1);
  assert.equal(result.repositories[0].repo_id, 'test_001');
  assert.equal(result.repositories[0].remote_url, 'https://github.com/acme/demo.git');
});

test('register_repository creates a record', async () => {
  const registry = createFakeRegistry();
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry,
  });

  const result = await tools.register_repository.handler({
    remote_url: 'https://github.com/example/proj.git',
    canonical_path: '/tmp/gptwork/example_proj',
    default_branch: 'main',
  });
  assert.ok(result.ok, 'register should succeed');
  assert.equal(result.record.remote_url, 'https://github.com/example/proj.git');
  assert.equal(result.record.canonical_path, '/tmp/gptwork/example_proj');
  assert.equal(result.record.default_branch, 'main');

  // verify it's now listed
  const list = await tools.list_repositories.handler();
  assert.equal(list.count, 1);
});

test('register_repository parses comma-separated roles and tags', async () => {
  const registry = createFakeRegistry();
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry,
  });

  const result = await tools.register_repository.handler({
    remote_url: 'https://github.com/example/proj.git',
    roles: 'builder,reviewer',
    tags: 'stable,tested',
  });
  assert.ok(result.ok);
  assert.deepEqual(result.record.roles, ['builder', 'reviewer']);
  assert.deepEqual(result.record.tags, ['stable', 'tested']);
});

test('resolve_canonical_repository errors when no repos registered', async () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  const result = await tools.resolve_canonical_repository.handler({});
  assert.equal(result.error, 'No repositories registered. Use register_repository first.');
  assert.ok(Array.isArray(result.repositories));
});

test('resolve_canonical_repository resolves single default repo', async () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: singleRepoRegistry,
  });

  const result = await tools.resolve_canonical_repository.handler({});
  assert.ok(result.ok);
  assert.equal(result.repo_id, 'test_001');
  assert.equal(result.remote_url, 'https://github.com/acme/demo.git');
});

test('get_repository_status errors when no repos registered', async () => {
  const tools = createRepositoryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: emptyRegistry,
  });

  const result = await tools.get_repository_status.handler({});
  assert.equal(result.error, 'No repositories registered. Use register_repository first.');
});
