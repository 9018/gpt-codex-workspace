import test from 'node:test';
import assert from 'node:assert/strict';

import { finalizeCodexTaskRun } from '../src/task-final-writeback.mjs';

function baseArgs(overrides = {}) {
  const calls = [];
  const resultTask = { id: 'task_1', status: 'completed' };
  return {
    calls,
    args: {
      store: {},
      config: { defaultWorkspaceRoot: '/tmp/ws', codexExecTimeout: 120, codexFirstOutputTimeout: 44 },
      task: { id: 'task_1' },
      taskStatus: 'completed',
      taskResult: { kind: 'codex_executed' },
      doneAt: '2026-01-01T00:00:00.000Z',
      cr: { returncode: 0, stdout_bytes: 3, stderr_bytes: 0 },
      workspace: { root: '/tmp/repo' },
      goal: { id: 'goal_1', workspace_id: 'ws_1' },
      workspaceFiles: { result_md: '.gptwork/goals/goal_1/result.md' },
      summary: 'summary text',
      context: { user_id: 'system' },
      runFilePath: '/tmp/run.json',
      repoLockPath: '/tmp/repo',
      github: { syncTask: (task) => { calls.push(['github', task]); return Promise.resolve(); } },
      fireHeartbeatFn: (...items) => calls.push(['heartbeat', ...items]),
      updateTaskFn: async (store, id, updater) => {
        const item = { logs: [] };
        updater(item);
        calls.push(['updateTask', id, item]);
        return { task: resultTask };
      },
      loadRestartMarkerFn: async () => null,
      releaseRepoLockFn: async (...items) => calls.push(['releaseLock', ...items]),
      updateGoalStatusFn: async (...items) => calls.push(['goalStatus', ...items]),
      writeWorkspaceTextInternalFn: async (...items) => calls.push(['writeResult', ...items]),
      appendGoalMessageFn: async (...items) => calls.push(['goalMessage', ...items]),
      ...overrides,
    }
  };
}

test('finalizeCodexTaskRun writes final state, releases lock, updates goal, and syncs github', async () => {
  const { calls, args } = baseArgs();

  const result = await finalizeCodexTaskRun(args);

  assert.deepEqual(result, { task_id: 'task_1', status: 'completed', kind: 'codex_executed' });
  assert.ok(calls.some(c => c[0] === 'heartbeat' && c[2] === 'completed'));
  const updateCall = calls.find(c => c[0] === 'updateTask');
  assert.equal(updateCall[2].status, 'completed');
  assert.equal(updateCall[2].result.completed_at, args.doneAt);
  assert.ok(updateCall[2].logs[0].message.includes('completed'));
  assert.ok(calls.some(c => c[0] === 'releaseLock' && c[3] === 'task_1'));
  assert.ok(calls.some(c => c[0] === 'goalStatus' && c[2] === 'goal_1' && c[3] === 'completed'));
  assert.ok(calls.some(c => c[0] === 'writeResult' && c[4] === '.gptwork/goals/goal_1/result.md'));
  assert.ok(calls.some(c => c[0] === 'goalMessage' && c[3].content.includes('summary text')));
  assert.ok(calls.some(c => c[0] === 'github'));
});

test('finalizeCodexTaskRun marks repo lock restart state when active marker exists', async () => {
  const { calls, args } = baseArgs({
    loadRestartMarkerFn: async () => ({ status: 'scheduled' }),
  });

  await finalizeCodexTaskRun(args);

  const releaseCall = calls.find(c => c[0] === 'releaseLock');
  assert.deepEqual(releaseCall[4], { restartState: 'scheduled' });
});

test('finalizeCodexTaskRun batches task and goal state when store.mutate is available', async () => {
  const { calls, args } = baseArgs();
  const state = {
    tasks: [{ id: 'task_1', logs: [], status: 'running' }],
    goals: [{ id: 'goal_1', title: 'Goal', status: 'assigned' }],
    activities: []
  };
  let mutateCount = 0;
  args.store = {
    mutate: async (updater) => {
      mutateCount += 1;
      return updater(state);
    }
  };

  const result = await finalizeCodexTaskRun(args);

  assert.equal(mutateCount, 1);
  assert.equal(result.status, 'completed');
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.goals[0].status, 'completed');
  assert.equal(state.activities.length, 2);
  assert.equal(calls.some(c => c[0] === 'updateTask'), false);
  assert.equal(calls.some(c => c[0] === 'goalStatus'), false);
});
