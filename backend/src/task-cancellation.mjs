import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopCodexTuiSession } from './codex-tui-session-manager.mjs';

const execFileAsync = promisify(execFile);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function listMatchingSessionRecords(root, taskId) {
  const dir = join(root, '.gptwork', 'codex-tui-sessions');
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const record = await readJson(path);
    if (record?.task_id === taskId || entry.name.includes(taskId)) records.push({ record, path, dir });
  }
  return records;
}

async function deleteNativeSessionFiles(codexHome, nativeSessionIds) {
  const deleted = [];
  if (!codexHome || nativeSessionIds.size === 0) return deleted;
  const root = join(codexHome, 'sessions');
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && [...nativeSessionIds].some((id) => entry.name.includes(id))) {
        await rm(path, { force: true });
        deleted.push(path);
      }
    }
  }
  await walk(root);
  return deleted;
}

async function deleteTaskWorktrees(workspaceRoot, taskId, explicitPath = null, canonicalRepoPath = null) {
  const deleted = [];
  if (explicitPath) {
    if (canonicalRepoPath) {
      try { await execFileAsync('git', ['worktree', 'remove', '--force', explicitPath], { cwd: canonicalRepoPath }); } catch { /* fallback to filesystem cleanup */ }
    }
    await rm(explicitPath, { recursive: true, force: true });
    deleted.push(explicitPath);
  }
  const root = join(workspaceRoot, '.gptwork', 'worktrees');
  let repos = [];
  try { repos = await readdir(root, { withFileTypes: true }); } catch (err) {
    if (err?.code === 'ENOENT') return deleted;
    throw err;
  }
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const path = join(root, repo.name, taskId);
    if (path === explicitPath) continue;
    await rm(path, { recursive: true, force: true });
    deleted.push(path);
  }
  if (canonicalRepoPath) {
    try { await execFileAsync('git', ['worktree', 'prune'], { cwd: canonicalRepoPath }); } catch { /* best effort after exact removal */ }
  }
  return deleted;
}

async function deleteTaskLockFiles(workspaceRoot, taskId) {
  const root = join(workspaceRoot, '.gptwork', 'locks', 'repos');
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const deleted = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(root, entry.name);
    const record = await readJson(path);
    if (record?.task_id !== taskId && !entry.name.includes(taskId)) continue;
    await rm(path, { force: true });
    deleted.push(path);
  }
  return deleted;
}

export async function cancelTaskExecution({ task, config, stopSessionFn = stopCodexTuiSession } = {}) {
  if (!task?.id) throw new Error('task is required');
  const workspaceRoot = config?.defaultWorkspaceRoot;
  if (!workspaceRoot) throw new Error('defaultWorkspaceRoot is required for cancellation cleanup');

  const records = await listMatchingSessionRecords(workspaceRoot, task.id);
  const stoppedSessions = [];
  const deletedSessions = [];
  const nativeIds = new Set();
  for (const { record, path, dir } of records) {
    const sessionId = record?.id || path.slice(dir.length + 1, -5);
    await stopSessionFn(sessionId, {
      reason: 'task_cancelled',
      workspaceRoot,
      candidateWorkspaceRoots: [workspaceRoot, record?.cwd, record?.worktree_path].filter(Boolean),
      gracefulStopTimeoutMs: 2_000,
    });
    stoppedSessions.push(sessionId);
    const nativeId = record?.native_session_id || record?.metadata?.native_session_id || record?.metadata?.resume_native_session_id;
    if (nativeId) nativeIds.add(String(nativeId));
    await rm(path, { force: true });
    await rm(path.replace(/\.json$/, '.log'), { force: true });
    deletedSessions.push(sessionId);
  }

  const deletedNativeSessions = await deleteNativeSessionFiles(config.codexHome, nativeIds);
  const deletedLocks = await deleteTaskLockFiles(workspaceRoot, task.id);
  const deletedWorktrees = await deleteTaskWorktrees(workspaceRoot, task.id, task.worktree?.path || null, config.defaultRepoPath || null);
  return {
    stopped_sessions: stoppedSessions,
    deleted_sessions: deletedSessions,
    deleted_native_sessions: deletedNativeSessions,
    deleted_locks: deletedLocks,
    deleted_worktrees: deletedWorktrees,
  };
}
