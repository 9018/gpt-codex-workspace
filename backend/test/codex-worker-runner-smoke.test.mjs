import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.mjs';
import { runAssignedCodexTasks } from '../src/codex-worker-runner.mjs';

function makeStore(tmpDir) {
  return new StateStore({
    statePath: join(tmpDir, 'state.json'),
    defaultWorkspaceRoot: tmpDir,
  });
}

function addTask(state, patch = {}) {
  const now = new Date().toISOString();
  const task = {
    id: patch.id || `task-${state.tasks.length + 1}`,
    assignee: 'codex',
    status: 'assigned',
    project_id: 'default',
    workspace_id: 'hosted-default',
    mode: 'builder',
    title: patch.title || 'Task',
    description: '',
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
  state.tasks.push(task);
  return task;
}

test('runAssignedCodexTasks isolates per-task processor failures', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-runner-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, { id: 'bad-task', title: 'Bad task' });
    addTask(store.state, { id: 'good-task', title: 'Good task' });
    await store.save();

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 2 }, undefined, {
      processGeneralTask: async (_store, _config, task) => {
        if (task.id === 'bad-task') throw new Error('boom');
        return { task_id: task.id, status: 'completed' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.inspected, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.progressed, 2);

    const failedTask = await store.findTaskById('bad-task');
    assert.equal(failedTask.status, 'failed');
    assert.match(failedTask.result.worker_error, /boom/);

    const goodResult = result.tasks.find((item) => item.task_id === 'good-task');
    assert.equal(goodResult.status, 'completed');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks parks unsupported modes for review instead of hot-loop skipping', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-runner-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, { id: 'odd-task', mode: 'mystery' });
    await store.save();

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.inspected, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.transitioned, 1);
    assert.equal(result.progressed, 1);

    const parked = await store.findTaskById('odd-task');
    assert.equal(parked.status, 'waiting_for_review');
    assert.match(parked.logs.at(-1).message, /unsupported worker mode/);

    const afterPark = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });
    assert.equal(afterPark.inspected, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
