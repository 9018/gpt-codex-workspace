import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepoLockToolsGroup } from '../src/tool-groups/repo-lock-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  if (typeof description === 'object' && description !== null) return description;
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('repo lock tool group exposes stable public aliases and response shape', async () => {
  const calls = [];
  const tools = createRepoLockToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork' },
    listRepoLocks: async (root) => {
      calls.push(['list', root]);
      return [{ repo: 'demo', task_id: 'task_1' }];
    },
    getRepoLockSummary: async (root) => {
      calls.push(['summary', root]);
      return { active_repo_locks: 1, stale_repo_locks: 0 };
    },
  });

  assert.deepEqual(Object.keys(tools), ['list_repo_locks', 'repo_lock_status', 'clear_repo_lock']);
  assert.deepEqual(tools.list_repo_locks.inputSchema.required, []);
  assert.deepEqual(tools.repo_lock_status.inputSchema.required, []);

  const listed = await tools.list_repo_locks.handler();
  const alias = await tools.repo_lock_status.handler();

  assert.deepEqual(listed, { active_repo_locks: 1, stale_repo_locks: 0, history_lock_count: 0, scope: 'current', page: 1, page_size: 50, locks: [{ repo: 'demo', task_id: 'task_1' }] });
  assert.deepEqual(alias, listed);
  assert.deepEqual(calls, [
    ['summary', '/tmp/gptwork'],
    ['list', '/tmp/gptwork'],
    ['summary', '/tmp/gptwork'],
    ['list', '/tmp/gptwork'],
  ]);
});

test('clear_repo_lock clears human-review task status using taxonomy normalization', async () => {
  const lock = {
    safe_repo_id: 'repo_1',
    task_id: 'task_review',
    status: 'active',
    last_heartbeat_at: new Date().toISOString(),
  };
  const tools = createRepoLockToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork' },
    listRepoLocks: async () => [lock],
    getRepoLockSummary: async () => ({ active_repo_locks: 1, stale_repo_locks: 0 }),
    store: {
      load: async () => ({
        tasks: [{ id: 'task_review', status: '  WAITING_FOR_REVIEW  ' }],
      }),
    },
  });

  const result = await tools.clear_repo_lock.handler({ task_id: 'task_review' });

  assert.equal(result.ok, true);
  assert.equal(result.locks_cleared, 1);
  assert.equal(result.locks_skipped, 0);
  assert.equal(result.details[0].cleared, true);
});
