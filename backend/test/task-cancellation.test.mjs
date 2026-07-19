import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelTaskExecution } from '../src/task-cancellation.mjs';

async function absent(path) {
  try { await access(path); return false; } catch { return true; }
}

test('cancelTaskExecution stops TUI then deletes TUI/native session, lock, and worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-cancel-'));
  const codexHome = join(root, 'codex-home');
  const taskId = 'task_cancel_1';
  const sessionId = `goal_1_${taskId}`;
  const nativeId = '019f7ac1-cbde-7f91-8211-f61c043235a7';
  const sessionsDir = join(root, '.gptwork', 'codex-tui-sessions');
  const lockDir = join(root, '.gptwork', 'locks', 'repos');
  const worktree = join(root, '.gptwork', 'worktrees', 'repo', taskId);
  const nativeDir = join(codexHome, 'sessions', '2026', '07', '19');
  await Promise.all([mkdir(sessionsDir, { recursive: true }), mkdir(lockDir, { recursive: true }), mkdir(worktree, { recursive: true }), mkdir(nativeDir, { recursive: true })]);
  const recordPath = join(sessionsDir, `${sessionId}.json`);
  const logPath = join(sessionsDir, `${sessionId}.log`);
  const nativePath = join(nativeDir, `rollout-${nativeId}.jsonl`);
  const lockPath = join(lockDir, `repo-${taskId}.json`);
  await writeFile(recordPath, JSON.stringify({ id: sessionId, task_id: taskId, native_session_id: nativeId, worktree_path: worktree }));
  await writeFile(logPath, 'log');
  await writeFile(nativePath, '{}\n');
  await writeFile(lockPath, JSON.stringify({ task_id: taskId }));

  const calls = [];
  const result = await cancelTaskExecution({
    task: { id: taskId, worktree: { path: worktree } },
    config: { defaultWorkspaceRoot: root, codexHome },
    stopSessionFn: async (id) => { calls.push(id); return { id, status: 'stopped' }; },
  });

  assert.deepEqual(calls, [sessionId]);
  assert.equal(await absent(recordPath), true);
  assert.equal(await absent(logPath), true);
  assert.equal(await absent(nativePath), true);
  assert.equal(await absent(lockPath), true);
  assert.equal(await absent(worktree), true);
  assert.deepEqual(result.stopped_sessions, [sessionId]);
  assert.deepEqual(result.deleted_sessions, [sessionId]);
});
