import { readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { snapshotNativeSessions } from './codex-session-inventory.mjs';
import { createCodexSessionManifestStore } from './codex-session-manifest-store.mjs';


async function pruneEmptyParents(startDir, stopDir, deleted = []) {
  if (!startDir || !stopDir) return deleted;
  const boundary = resolve(stopDir);
  let current = resolve(startDir);
  while (current !== boundary && current.startsWith(boundary + '/')) {
    try {
      await rmdir(current);
      deleted.push(current);
      current = dirname(current);
    } catch (error) {
      if (error?.code === 'ENOENT') { current = dirname(current); continue; }
      if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) break;
      throw error;
    }
  }
  return deleted;
}

function runtimeGoalDirFrom(record, manifest) {
  return record?.metadata?.runtime_goal_dir
    || manifest?.runtime_goal_dir
    || (record?.worktree_path && record?.goal_id
      ? join(record.worktree_path, '.gptwork', 'runtime-goals', record.goal_id)
      : null);
}

async function deleteSessionOwnedFolders({ record, manifest, nativeSessionsRoot, deletedNativeSessions }) {
  const deleted = [];
  const runtimeGoalDir = runtimeGoalDirFrom(record, manifest);
  if (runtimeGoalDir) {
    const worktree = record?.worktree_path || record?.cwd || manifest?.worktree_path || manifest?.cwd || null;
    const expectedRoot = worktree ? join(resolve(worktree), '.gptwork', 'runtime-goals') : null;
    const resolvedRuntime = resolve(runtimeGoalDir);
    if (expectedRoot && (resolvedRuntime === expectedRoot || resolvedRuntime.startsWith(expectedRoot + '/'))) {
      await rm(resolvedRuntime, { recursive: true, force: true });
      deleted.push(resolvedRuntime);
      await pruneEmptyParents(dirname(resolvedRuntime), join(resolve(worktree), '.gptwork'), deleted);
    }
  }
  for (const nativePath of deletedNativeSessions || []) {
    await pruneEmptyParents(dirname(nativePath), nativeSessionsRoot, deleted);
  }
  return deleted;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listControlRecords(workspaceRoot) {
  const dir = join(workspaceRoot, '.gptwork', 'codex-tui-sessions');
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const record = await readJson(path);
    const controlSessionId = record?.id || entry.name.slice(0, -5);
    records.push({ controlSessionId, record, path, logPath: join(dir, `${controlSessionId}.log`) });
  }
  return records;
}

function nativeIdFromRecord(record) {
  return record?.native_session_id
    || record?.metadata?.native_session_id
    || record?.resume_native_session_id
    || record?.metadata?.resume_native_session_id
    || null;
}

async function deleteNativeSessionById(nativeSessionsRoot, nativeSessionId) {
  if (!nativeSessionsRoot || !nativeSessionId) return [];
  const matches = (await snapshotNativeSessions(nativeSessionsRoot))
    .filter((entry) => entry.id === nativeSessionId);
  const deleted = [];
  for (const entry of matches) {
    await rm(entry.path, { force: true });
    deleted.push(entry.path);
  }
  return deleted;
}

export async function pruneBoundNativeSession({
  controlSessionId,
  workspaceRoot,
  projectRoot,
  nativeSessionsRoot,
} = {}) {
  if (!controlSessionId) throw new TypeError('controlSessionId is required');
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');
  if (!nativeSessionsRoot) return { control_session_id: controlSessionId, native_session_id: null, deleted_native_sessions: [] };

  const controlRecords = await listControlRecords(workspaceRoot);
  const control = controlRecords.find((entry) => entry.controlSessionId === controlSessionId) || null;
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const manifest = await manifests.read(controlSessionId).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const nativeSessionId = nativeIdFromRecord(control?.record) || manifest?.native_session_id || null;
  const deletedNativeSessions = await deleteNativeSessionById(nativeSessionsRoot, nativeSessionId);
  await deleteSessionOwnedFolders({
    record: null,
    manifest: null,
    nativeSessionsRoot,
    deletedNativeSessions,
  });
  return {
    control_session_id: controlSessionId,
    native_session_id: nativeSessionId,
    deleted_native_sessions: deletedNativeSessions,
  };
}


function sessionTimeMs(entry) {
  const parsed = Date.parse(entry?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : Number(entry?.mtimeMs || 0);
}

function isWithinWindow(entry, startedAt, endedAt) {
  const value = sessionTimeMs(entry);
  const start = Date.parse(startedAt || '');
  const end = Date.parse(endedAt || '');
  if (Number.isFinite(start) && value < start) return false;
  if (Number.isFinite(end) && value > end + 5_000) return false;
  return true;
}

/**
 * Remove every native Codex session attributable to one GPTWork task.
 * Existing bindings are authoritative. Unbound native sessions created during
 * the task execution window are treated as descendants, except when another
 * task manifest already owns them. This keeps the control layer thin while
 * covering real Codex sessions spawned indirectly by tests or child commands.
 */
export async function cleanupTaskOwnedCodexSessions({
  taskId,
  workspaceRoot,
  projectRoot,
  nativeSessionsRoot,
  startedAt = null,
  endedAt = new Date().toISOString(),
  stopSessionFn = null,
} = {}) {
  if (!taskId) throw new TypeError('taskId is required');
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');

  const records = await listControlRecords(workspaceRoot);
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const manifestEntries = await manifests.list();
  const manifestByControl = new Map(manifestEntries.map((entry) => [entry.control_session_id, entry]));
  const ownedControlIds = new Set();
  const protectedNativeIds = new Set();

  for (const { controlSessionId, record } of records) {
    const manifest = manifestByControl.get(controlSessionId);
    const ownerTaskId = record?.task_id || manifest?.task_id || null;
    const nativeId = nativeIdFromRecord(record) || manifest?.native_session_id || null;
    if (ownerTaskId === taskId) ownedControlIds.add(controlSessionId);
    else if (nativeId) protectedNativeIds.add(nativeId);
  }
  for (const manifest of manifestEntries) {
    if (manifest?.task_id === taskId) ownedControlIds.add(manifest.control_session_id);
    else if (manifest?.native_session_id) protectedNativeIds.add(manifest.native_session_id);
  }

  const deletedControlSessions = [];
  const deletedNativeSessions = [];
  for (const controlSessionId of ownedControlIds) {
    const result = await deleteBoundCodexSession({
      controlSessionId, workspaceRoot, projectRoot, nativeSessionsRoot, stopSessionFn,
    });
    if (result.deleted_control_session) deletedControlSessions.push(controlSessionId);
    deletedNativeSessions.push(...result.deleted_native_sessions);
  }

  const alreadyDeleted = new Set(deletedNativeSessions);
  if (nativeSessionsRoot) {
    for (const native of await snapshotNativeSessions(nativeSessionsRoot)) {
      if (alreadyDeleted.has(native.path)) continue;
      if (native.id && protectedNativeIds.has(native.id)) continue;
      if (!isWithinWindow(native, startedAt, endedAt)) continue;
      await rm(native.path, { force: true });
      deletedNativeSessions.push(native.path);
      await pruneEmptyParents(dirname(native.path), nativeSessionsRoot, []);
    }
  }

  return {
    task_id: taskId,
    deleted_control_sessions: [...new Set(deletedControlSessions)].sort(),
    deleted_native_sessions: [...new Set(deletedNativeSessions)].sort(),
  };
}

export async function deleteBoundCodexSession({
  controlSessionId,
  workspaceRoot,
  projectRoot,
  nativeSessionsRoot,
  stopSessionFn = null,
} = {}) {
  if (!controlSessionId) throw new TypeError('controlSessionId is required');
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');

  const controlRecords = await listControlRecords(workspaceRoot);
  const control = controlRecords.find((entry) => entry.controlSessionId === controlSessionId) || null;
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const manifest = await manifests.read(controlSessionId).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const nativeSessionId = nativeIdFromRecord(control?.record) || manifest?.native_session_id || null;

  if (typeof stopSessionFn === 'function' && control) {
    await stopSessionFn(controlSessionId, {
      reason: 'session_deleted',
      workspaceRoot,
      candidateWorkspaceRoots: [workspaceRoot, control.record?.cwd, control.record?.worktree_path].filter(Boolean),
      gracefulStopTimeoutMs: 2_000,
    }).catch((error) => {
      if (!/unknown|ENOENT/i.test(String(error?.message || error))) throw error;
    });
  }

  if (control) {
    await rm(control.path, { force: true });
    await rm(control.logPath, { force: true });
  }
  await manifests.delete(controlSessionId);
  const deletedNativeSessions = await deleteNativeSessionById(nativeSessionsRoot, nativeSessionId);
  const deletedBoundFolders = await deleteSessionOwnedFolders({
    record: control?.record || null, manifest, nativeSessionsRoot, deletedNativeSessions,
  });

  return {
    control_session_id: controlSessionId,
    native_session_id: nativeSessionId,
    deleted_control_session: Boolean(control),
    deleted_native_sessions: deletedNativeSessions,
    deleted_bound_folders: deletedBoundFolders,
  };
}

export async function clearAllBoundCodexSessions({
  workspaceRoot,
  projectRoot,
  nativeSessionsRoot,
  stopSessionFn = null,
} = {}) {
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const records = await listControlRecords(workspaceRoot);
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const manifestEntries = await manifests.list();
  const ids = new Set([
    ...records.map((entry) => entry.controlSessionId),
    ...manifestEntries.map((entry) => entry.control_session_id),
  ]);
  const deletedControlSessions = [];
  const deletedNativeSessions = [];
  const deletedBoundFolders = [];
  for (const controlSessionId of ids) {
    const result = await deleteBoundCodexSession({
      controlSessionId,
      workspaceRoot,
      projectRoot,
      nativeSessionsRoot,
      stopSessionFn,
    });
    if (result.deleted_control_session) deletedControlSessions.push(controlSessionId);
    deletedNativeSessions.push(...result.deleted_native_sessions);
    deletedBoundFolders.push(...result.deleted_bound_folders);
  }

  // Full-clear semantics include native sessions that were never bound or whose binding was lost.
  for (const native of await snapshotNativeSessions(nativeSessionsRoot)) {
    await rm(native.path, { force: true });
    deletedNativeSessions.push(native.path);
  }

  const controlDir = join(workspaceRoot, '.gptwork', 'codex-tui-sessions');
  const controlManifestRoot = join(projectRoot, '.gptwork', 'codex-sessions');
  for (const folder of [controlDir, controlManifestRoot, nativeSessionsRoot].filter(Boolean)) {
    await rm(folder, { recursive: true, force: true });
    deletedBoundFolders.push(folder);
  }

  return {
    deleted_control_sessions: [...new Set(deletedControlSessions)].sort(),
    deleted_native_sessions: [...new Set(deletedNativeSessions)].sort(),
    deleted_bound_folders: [...new Set(deletedBoundFolders)].sort(),
  };
}

export async function reconcileCodexSessionBindings({
  workspaceRoot,
  projectRoot,
  nativeSessionsRoot,
  repair = false,
} = {}) {
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const records = await listControlRecords(workspaceRoot);
  const manifests = createCodexSessionManifestStore({ projectRoot });
  const manifestEntries = await manifests.list();
  const manifestByControl = new Map(manifestEntries.map((entry) => [entry.control_session_id, entry]));
  const repairedManifests = [];
  const missingNativeBindings = [];

  for (const { controlSessionId, record } of records) {
    const nativeSessionId = nativeIdFromRecord(record);
    if (!nativeSessionId) missingNativeBindings.push(controlSessionId);
    if (!manifestByControl.has(controlSessionId) && repair) {
      await manifests.write({
        control_session_id: controlSessionId,
        native_session_id: nativeSessionId,
        task_id: record?.task_id || null,
        goal_id: record?.goal_id || null,
        execution_id: record?.execution_id || null,
        cwd: record?.cwd || null,
        provider: 'codex_tui_goal',
        status: record?.status || 'unknown',
        binding_repaired: true,
      });
      repairedManifests.push(controlSessionId);
    }
  }

  const boundNativeIds = new Set([
    ...records.map((entry) => nativeIdFromRecord(entry.record)),
    ...manifestEntries.map((entry) => entry.native_session_id),
  ].filter(Boolean));
  const native = await snapshotNativeSessions(nativeSessionsRoot);
  const orphanNativeSessionIds = native.map((entry) => entry.id).filter((id) => id && !boundNativeIds.has(id));
  const orphanManifests = manifestEntries
    .filter((entry) => !records.some((record) => record.controlSessionId === entry.control_session_id))
    .map((entry) => entry.control_session_id);

  return {
    repaired_manifests: repairedManifests.sort(),
    missing_native_bindings: missingNativeBindings.sort(),
    orphan_native_session_ids: [...new Set(orphanNativeSessionIds)].sort(),
    orphan_manifest_control_session_ids: orphanManifests.sort(),
  };
}

export async function updateBoundCodexSessionStatus({
  projectRoot,
  controlSessionId,
  status,
  terminalizedAt = null,
  patch = {},
} = {}) {
  if (!projectRoot || !controlSessionId) return null;
  const manifests = createCodexSessionManifestStore({ projectRoot });
  try {
    return await manifests.update(controlSessionId, {
      ...patch,
      status,
      ...(terminalizedAt ? { terminalized_at: terminalizedAt } : {}),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
