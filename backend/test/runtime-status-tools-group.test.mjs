import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRuntimeStatusToolsGroup } from '../src/tool-groups/runtime-status-tools-group.mjs';
import { createCodexTuiSessionStore } from '../src/codex-tui-session-store.mjs';
import { track, afterEachHook } from './helpers/temp-cleanup.mjs';

afterEachHook(test);

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
  statePath: '/tmp/gptwork/state.json',
  defaultWorkspaceRoot: '/tmp/gptwork',
  codexExecTimeout: 900,
  codexFirstOutputTimeout: 120,
  shellTimeout: 30,
  maxReadBytes: 65536,
  maxShellOutputBytes: 65536,
  defaultRepo: 'owner/repo',
  defaultBranch: 'main',
  defaultRepoPath: '/tmp/gptwork/repo',
  defaultRemote: 'origin',
  githubRepo: 'owner/repo',
  githubToken: 'test-token',
  githubEnabled: 'process.env',
  barkEnabled: 'process.env',
  barkUrl: 'process.env',
  barkKey: 'process.env',
  workspaceRoot: 'process.env',
  maxReadBytesSrc: 'process.env',
  maxShellOutputBytesSrc: 'process.env',
};

const fakeSources = {
  codexExecTimeout: 'default',
  codexFirstOutputTimeout: 'default',
  shellTimeout: 'default',
  statePath: 'default',
  defaultRepo: 'default',
  defaultBranch: 'default',
  defaultRepoPath: 'default',
  defaultRemote: 'default',
  barkEnabled: 'process.env',
  barkUrl: 'process.env',
  barkKey: 'process.env',
  githubEnabled: 'process.env',
  githubRepo: 'process.env',
  githubToken: 'process.env',
  workspaceRoot: 'default',
  maxReadBytes: 'default',
  maxShellOutputBytes: 'default',
};

const fakeEnvLoadResult = {
  loadedPath: null,
  keys: [],
  data: {},
};

const fakeBark = null;

const fakeGithub = {
  enabled: false,
  status: () => ({ api_repo: '' }),
  getKnownIssues: () => [],
};

const fakeRegistry = {
  list: () => [],
  get: () => null,
  findByName: () => null,
  getDefaultRepo: () => null,
  findByPath: () => null,
  count: () => 0,
  workspaceRoot: '/tmp/gptwork',
};

const fakeStore = {
  state: { tasks: [] },
  load: async () => ({ tasks: [] }),
};

const fakeWorkerState = {
  enabled: false,
  running: false,
  last_tick_finished_at: null,
  interval_ms: 5000,
  last_error: null,
};

const fakeProcessStartedAt = new Date('2025-01-01T00:00:00Z');

const fakeCollectWorkerQueueCounts = async (store) => ({
  assigned: 0, queued: 0, running: 0,
  waiting_for_lock: 0, waiting_for_review: 0, waiting_for_repair: 0,
  completed: 0, failed: 0,
});

async function makeGitWorkspace(prefix = 'gptwork-runtime-tui-') {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
  return workspaceRoot;
}

test('runtime status tool group exposes all four status tool names', () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, ['github_status', 'gptwork_doctor', 'notification_status', 'runtime_status']);
});

test('runtime status tool group has correct input schemas', () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  // All tools take no required args
  for (const name of ['github_status', 'runtime_status', 'notification_status']) {
    assert.equal(typeof tools[name].handler, 'function', `${name}.handler should be a function`);
    assert.deepEqual(tools[name].inputSchema.required, [], `${name} should have no required args`);
    assert.deepEqual(tools[name].inputSchema.properties, {}, `${name} should have no properties`);
  }
  // gptwork_doctor has optional deep flag
  assert.equal(typeof tools.gptwork_doctor.handler, 'function', 'gptwork_doctor.handler should be a function');
  assert.deepEqual(tools.gptwork_doctor.inputSchema.required, [], 'gptwork_doctor should have no required args');
  assert.deepEqual(tools.gptwork_doctor.inputSchema.properties, { deep: 'boolean' }, 'gptwork_doctor should have deep property');
});

test('github_status handler returns expected shape', async () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const result = await tools.github_status.handler();
  assert.equal(typeof result.enabled, 'boolean');
  assert.equal(typeof result.repo, 'string');
  assert.equal(typeof result.known_issues, 'number');
  assert.equal(typeof result.config_source, 'string');
  assert.equal(typeof result.repo_configured, 'boolean');
  assert.equal(typeof result.token_configured, 'boolean');
});

test('runtime_status handler returns expected shape keys', async () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const result = await tools.runtime_status.handler();
  const expectedKeys = [
    'pid', 'started_at', 'repo_head', 'remote_head', 'running_commit',
    'defaultWorkspaceRoot', 'codex_exec_timeout', 'shell_timeout',
    'default_repo', 'default_branch',
    'runtime_env_file_path', 'runtime_env_file_exists',
    'runtime_env_loaded', 'runtime_env_configured', 'runtime_env_keys_loaded',
    'state_path', 'state_path_inside_repo',
    'worktree_dirty', 'dirty_paths', 'restart_markers',
    'config_sources', 'bark', 'github', 'repo_locks', 'worker',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in result, `runtime_status response should have key: ${key}`);
  }
  assert.equal(typeof result.config_sources, 'object');
  assert.equal(typeof result.worker, 'object');
  assert.equal(typeof result.bark, 'object');
  assert.equal(typeof result.github, 'object');
  if (result.codex_tui_goal !== undefined) {
    assert.equal(result.codex_tui_goal.provider, 'codex_tui_goal');
    assert.equal(result.codex_tui_goal.optional, false);
    assert.equal(result.codex_tui_goal.activation, 'default_autonomous');
    assert.equal(result.codex_tui_goal.highest_severity, 'ok');
  }
});

test('runtime_status includes autonomous default codex_tui_goal diagnostics when TUI state is relevant', async () => {
  const workspaceRoot = await makeGitWorkspace();
  const sessionStore = createCodexTuiSessionStore({ workspaceRoot });
  await sessionStore.createSession({
    sessionId: 'session_1',
    taskId: 'task_1',
    goalId: 'goal_1',
    cwd: workspaceRoot,
  });

  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { ...fakeConfig, defaultWorkspaceRoot: workspaceRoot, codexTuiEnabled: true },
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: {
      state: { tasks: [{ id: 'task_1', metadata: { codex_execution_provider: 'codex_tui_goal' } }] },
      load: async () => ({ tasks: [{ id: 'task_1', metadata: { codex_execution_provider: 'codex_tui_goal' } }] }),
    },
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const result = await tools.runtime_status.handler();

  assert.equal(result.codex_tui_goal.provider, 'codex_tui_goal');
  assert.equal(result.codex_tui_goal.optional, false);
  assert.equal(result.codex_tui_goal.activation, 'default_autonomous');
  assert.equal(result.codex_tui_goal.default_provider, 'codex_tui_goal');
  assert.equal(result.codex_tui_goal.session_store.session_count, 1);
  assert.equal(result.codex_tui_goal.completion.no_result_count, 1);
});

test('notification_status handler returns expected shape', async () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const result = await tools.notification_status.handler();
  assert.equal(result.enabled, false);
  assert.equal(result.configured, false);
  assert.equal(result.source, 'unknown');
});

test('gptwork_doctor handler returns expected shape keys', async () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: fakeWorkerState,
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: fakeCollectWorkerQueueCounts,
  });

  const result = await tools.gptwork_doctor.handler({});
  const expectedKeys = [
    'pid', 'started_at', 'running_commit',
    'runtime_env_loaded', 'runtime_env_configured', 'runtime_env_file_path',
    'workspace_root', 'default_repo', 'default_branch', 'default_repo_path',
    'repository_registry_count', 'repository_registry_has_canonical_repo',
    'stale_clone_count', 'worktree_dirty', 'dirty_paths',
    'codex_exec_timeout', 'github_api_sync_enabled',
    'direct_git_reader_available', 'bark_configured', 'bark_enabled',
    'placeholder_tools_exposed', 'suggested_next_actions',
    'worker', 'repo_locks',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in result, `gptwork_doctor response should have key: ${key}`);
  }
  assert.ok(Array.isArray(result.suggested_next_actions));
  assert.equal(typeof result.worker, 'object');
  assert.equal(typeof result.repo_locks, 'object');
});

test('gptwork_doctor suggested actions use actionable review queue blockers', async () => {
  const tools = createRuntimeStatusToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    sources: fakeSources,
    envLoadResult: fakeEnvLoadResult,
    bark: fakeBark,
    github: fakeGithub,
    registry: fakeRegistry,
    store: fakeStore,
    workerState: { ...fakeWorkerState, enabled: true, last_tick_finished_at: new Date().toISOString() },
    PROCESS_STARTED_AT: fakeProcessStartedAt,
    collectWorkerQueueCounts: async () => ({
      assigned: 0,
      queued: 0,
      running: 0,
      waiting_for_lock: 0,
      waiting_for_review: 4,
      waiting_for_repair: 2,
      actionable_review: 1,
      completed: 0,
      failed: 0,
    }),
  });

  const result = await tools.gptwork_doctor.handler({});
  assert.ok(result.suggested_next_actions.some((action) => action.includes('1 Codex task(s) needing actionable review')));
  assert.ok(result.suggested_next_actions.some((action) => action.includes('2 Codex task(s) waiting for repair')));
  assert.equal(result.suggested_next_actions.some((action) => action.includes('4 Codex task(s) waiting for review')), false);
});
