import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.mjs';

function makeStore(tmpDir) {
  return new StateStore({
    statePath: join(tmpDir, 'state.json'),
    defaultWorkspaceRoot: tmpDir,
  });
}

function populateFixtures(state) {
  const now = new Date().toISOString();
  state.tasks.push(
    { id: 't1', assignee: 'codex', status: 'assigned', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't2', assignee: 'codex', status: 'queued', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't3', assignee: 'codex', status: 'running', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't4', assignee: 'codex', status: 'waiting_for_lock', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't5', assignee: 'codex', status: 'waiting_for_review', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't6', assignee: 'codex', status: 'completed', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't7', assignee: 'codex', status: 'failed', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
    { id: 't8', assignee: 'user_default', status: 'assigned', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: now, updated_at: now },
  );
  return state;
}

test('StateStore: indexes split active and terminal tasks', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    populateFixtures(store.state);
    store._buildIndexes();

    assert.equal(store._idxCodexActiveTasksByStatus.size, 5);
    assert.equal(store._idxCodexTerminalTasksByStatus.size, 2);
    assert.equal(store.getCodexTasksByStatus('assigned').length, 1);
    assert.equal(store.getCodexTasksByStatus('completed').length, 1);
    assert.equal(store.getCodexTasksByStatus('failed').length, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore: getCodexActiveQueueCandidates returns indexed tasks without scanning state.tasks', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    populateFixtures(store.state);
    store._buildIndexes();

    const candidates = store.getCodexActiveQueueCandidates(['assigned', 'queued', 'waiting_for_lock']);
    assert.equal(candidates.length, 3);
    const ids = candidates.map(t => t.id).sort();
    assert.deepEqual(ids, ['t1', 't2', 't4']);

    const limited = store.getCodexActiveQueueCandidates(['assigned', 'queued', 'waiting_for_lock'], 2);
    assert.equal(limited.length, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore: getCodexTaskQueue excludes terminal tasks from task list but includes counts', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    populateFixtures(store.state);
    store._buildIndexes();

    const q = store.getCodexTaskQueue();
    const taskIds = q.tasks.map(t => t.id);
    assert(!taskIds.includes('t6'));
    assert(!taskIds.includes('t7'));
    assert.equal(q.counts.assigned, 1);
    assert.equal(q.counts.completed, 1);
    assert.equal(q.counts.failed, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore: save() rebuilds indexes after write', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    populateFixtures(store.state);
    await store.save();

    assert(store._idxCodexActiveTasksByStatus !== null);
    assert(store._idxCodexTerminalTasksByStatus !== null);
    assert.equal(store.getCodexTasksByStatus('assigned').length, 1);
    assert.equal(store.getCodexTasksByStatus('completed').length, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore: direct state mutation + save() keeps indexes consistent', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    populateFixtures(store.state);
    store.state.tasks.push({
      id: 't9', assignee: 'codex', status: 'assigned', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await store.save();

    assert.equal(store.getCodexTasksByStatus('assigned').length, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateStore: adding task via mutate() keeps indexes consistent', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ss-smoke-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();

    await store.mutate((state) => {
      state.tasks.push({
        id: 'new-task', assignee: 'codex', status: 'assigned', project_id: 'default', workspace_id: 'hosted-default', mode: 'builder', logs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
    });

    const candidates = store.getCodexActiveQueueCandidates(['assigned']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'new-task');

    const q = store.getCodexTaskQueue();
    assert.equal(q.counts.assigned, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
