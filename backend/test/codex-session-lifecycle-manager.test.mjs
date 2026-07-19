import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCodexSessionManifestStore } from '../src/codex-session/codex-session-manifest-store.mjs';
import {
  deleteBoundCodexSession,
  clearAllBoundCodexSessions,
  reconcileCodexSessionBindings,
} from '../src/codex-session/codex-session-lifecycle-manager.mjs';

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-session-lifecycle-'));
  const projectRoot = join(root, 'project');
  const workspaceRoot = join(root, 'workspace');
  const nativeSessionsRoot = join(root, 'codex-home', 'sessions');
  await mkdir(join(projectRoot, '.gptwork', 'codex-sessions', 'manifests'), { recursive: true });
  await mkdir(join(workspaceRoot, '.gptwork', 'codex-tui-sessions'), { recursive: true });
  await mkdir(join(nativeSessionsRoot, '2026', '07', '20'), { recursive: true });
  return { root, projectRoot, workspaceRoot, nativeSessionsRoot };
}

test('deleteBoundCodexSession removes control record, log, manifest and native rollout by session_meta id', async () => {
  const { projectRoot, workspaceRoot, nativeSessionsRoot } = await fixture();
  const controlId = 'goal_1_task_1';
  const nativeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const recordPath = join(workspaceRoot, '.gptwork', 'codex-tui-sessions', `${controlId}.json`);
  const logPath = join(workspaceRoot, '.gptwork', 'codex-tui-sessions', `${controlId}.log`);
  const rolloutPath = join(nativeSessionsRoot, '2026', '07', '20', 'rollout-random-name.jsonl');
  await writeFile(recordPath, JSON.stringify({ id: controlId, native_session_id: nativeId, task_id: 'task_1' }));
  await writeFile(logPath, 'log');
  await writeFile(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  const manifests = createCodexSessionManifestStore({ projectRoot });
  await manifests.write({ control_session_id: controlId, native_session_id: nativeId, status: 'running' });

  const stopped = [];
  const result = await deleteBoundCodexSession({
    controlSessionId: controlId,
    workspaceRoot,
    projectRoot,
    nativeSessionsRoot,
    stopSessionFn: async (id) => stopped.push(id),
  });

  assert.deepEqual(stopped, [controlId]);
  assert.equal(await exists(recordPath), false);
  assert.equal(await exists(logPath), false);
  assert.equal(await exists(rolloutPath), false);
  assert.equal(await exists(join(projectRoot, '.gptwork', 'codex-sessions', 'manifests', `${controlId}.json`)), false);
  assert.equal(result.native_session_id, nativeId);
});

test('clearAllBoundCodexSessions clears all three stores and stops every live control session once', async () => {
  const { projectRoot, workspaceRoot, nativeSessionsRoot } = await fixture();
  const storeDir = join(workspaceRoot, '.gptwork', 'codex-tui-sessions');
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const stopped = [];
  for (const [controlId, nativeId] of [['control_a', 'native-a'], ['control_b', 'native-b']]) {
    await writeFile(join(storeDir, `${controlId}.json`), JSON.stringify({ id: controlId, native_session_id: nativeId }));
    await writeFile(join(storeDir, `${controlId}.log`), 'log');
    await manifests.write({ control_session_id: controlId, native_session_id: nativeId, status: 'running' });
    await writeFile(join(nativeSessionsRoot, '2026', '07', '20', `${controlId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  }

  const result = await clearAllBoundCodexSessions({
    workspaceRoot,
    projectRoot,
    nativeSessionsRoot,
    stopSessionFn: async (id) => stopped.push(id),
  });

  assert.deepEqual(stopped.sort(), ['control_a', 'control_b']);
  assert.equal(await exists(storeDir), false);
  assert.equal(await exists(join(projectRoot, '.gptwork', 'codex-sessions')), false);
  assert.equal(result.deleted_control_sessions.length, 2);
  assert.equal(result.deleted_native_sessions.length, 2);
});

test('reconcileCodexSessionBindings repairs a missing manifest from the control record and reports orphan native sessions', async () => {
  const { projectRoot, workspaceRoot, nativeSessionsRoot } = await fixture();
  const controlId = 'control_repair';
  const nativeId = 'native-repair';
  await writeFile(join(workspaceRoot, '.gptwork', 'codex-tui-sessions', `${controlId}.json`), JSON.stringify({
    id: controlId,
    task_id: 'task_repair',
    goal_id: 'goal_repair',
    native_session_id: nativeId,
    cwd: '/tmp/worktree',
    status: 'running',
  }));
  await writeFile(join(nativeSessionsRoot, '2026', '07', '20', 'bound.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  await writeFile(join(nativeSessionsRoot, '2026', '07', '20', 'orphan.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'native-orphan' } }) + '\n');

  const result = await reconcileCodexSessionBindings({ workspaceRoot, projectRoot, nativeSessionsRoot, repair: true });
  const manifest = JSON.parse(await readFile(join(projectRoot, '.gptwork', 'codex-sessions', 'manifests', `${controlId}.json`), 'utf8'));

  assert.equal(manifest.native_session_id, nativeId);
  assert.deepEqual(result.repaired_manifests, [controlId]);
  assert.deepEqual(result.orphan_native_session_ids, ['native-orphan']);
});

test('updateBoundCodexSessionStatus keeps manifest lifecycle synchronized', async () => {
  const { projectRoot } = await fixture();
  const manifests = createCodexSessionManifestStore({ projectRoot });
  await manifests.write({ control_session_id: 'control_sync', native_session_id: 'native-sync', status: 'running' });
  const { updateBoundCodexSessionStatus } = await import('../src/codex-session/codex-session-lifecycle-manager.mjs');
  await updateBoundCodexSessionStatus({ projectRoot, controlSessionId: 'control_sync', status: 'completed', terminalizedAt: '2026-07-20T00:00:00.000Z' });
  const value = await manifests.read('control_sync');
  assert.equal(value.status, 'completed');
  assert.equal(value.terminalized_at, '2026-07-20T00:00:00.000Z');
});

test('deleteBoundCodexSession removes session-owned runtime folder and prunes empty native date folders without deleting goal evidence', async () => {
  const { projectRoot, workspaceRoot, nativeSessionsRoot } = await fixture();
  const controlId = 'control_folders';
  const nativeId = 'native-folders';
  const worktreePath = join(workspaceRoot, 'worktree');
  const runtimeGoalDir = join(worktreePath, '.gptwork', 'runtime-goals', 'goal_folders');
  const canonicalGoalDir = join(projectRoot, '.gptwork', 'goals', 'goal_folders');
  await mkdir(runtimeGoalDir, { recursive: true });
  await mkdir(canonicalGoalDir, { recursive: true });
  await writeFile(join(canonicalGoalDir, 'result.json'), '{}');
  const recordPath = join(workspaceRoot, '.gptwork', 'codex-tui-sessions', `${controlId}.json`);
  await writeFile(recordPath, JSON.stringify({
    id: controlId,
    native_session_id: nativeId,
    goal_id: 'goal_folders',
    worktree_path: worktreePath,
    metadata: { runtime_goal_dir: runtimeGoalDir, canonical_goal_dir: canonicalGoalDir },
  }));
  const nativeDateDir = join(nativeSessionsRoot, '2026', '07', '20');
  const rolloutPath = join(nativeDateDir, 'rollout.jsonl');
  await writeFile(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  const manifests = createCodexSessionManifestStore({ projectRoot });
  await manifests.write({
    control_session_id: controlId,
    native_session_id: nativeId,
    runtime_goal_dir: runtimeGoalDir,
    canonical_goal_dir: canonicalGoalDir,
    status: 'running',
  });

  const result = await deleteBoundCodexSession({ controlSessionId: controlId, workspaceRoot, projectRoot, nativeSessionsRoot });

  assert.equal(await exists(runtimeGoalDir), false);
  assert.equal(await exists(join(worktreePath, '.gptwork', 'runtime-goals')), false);
  assert.equal(await exists(canonicalGoalDir), true);
  assert.equal(await exists(nativeDateDir), false);
  assert.ok(result.deleted_bound_folders.includes(runtimeGoalDir));
  assert.ok(!result.deleted_bound_folders.includes(canonicalGoalDir));
});

test('clearAllBoundCodexSessions removes session root folders instead of recreating empty shells', async () => {
  const { projectRoot, workspaceRoot, nativeSessionsRoot } = await fixture();
  const controlRoot = join(workspaceRoot, '.gptwork', 'codex-tui-sessions');
  const manifestRoot = join(projectRoot, '.gptwork', 'codex-sessions', 'manifests');
  await writeFile(join(controlRoot, 'orphan.log'), 'log');
  await writeFile(join(manifestRoot, 'orphan.tmp'), 'tmp');

  const result = await clearAllBoundCodexSessions({ workspaceRoot, projectRoot, nativeSessionsRoot });

  assert.equal(await exists(controlRoot), false);
  assert.equal(await exists(join(projectRoot, '.gptwork', 'codex-sessions')), false);
  assert.equal(await exists(nativeSessionsRoot), false);
  assert.ok(result.deleted_bound_folders.includes(controlRoot));
});
