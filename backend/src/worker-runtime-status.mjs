import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workerStatusSnapshot } from './codex-worker-state.mjs';

export function getWorkerStatusPath(workspaceRoot = process.env.GPTWORK_WORKSPACE_ROOT) {
  const explicit = process.env.GPTWORK_WORKER_STATUS_PATH;
  if (explicit) return explicit;
  if (!workspaceRoot) return null;
  return join(workspaceRoot, '.gptwork', 'runtime', 'worker-status.json');
}

export function persistWorkerRuntimeStatus(workerState, { workspaceRoot, pid = process.pid } = {}) {
  const path = getWorkerStatusPath(workspaceRoot);
  if (!path) return { ok: false, reason: 'workspace_root_missing' };
  mkdirSync(dirname(path), { recursive: true });
  const payload = { schema_version: 1, pid, observed_at: new Date().toISOString(), ...workerStatusSnapshot(workerState) };
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, path);
  return { ok: true, path, payload };
}

export function readWorkerRuntimeStatus(workspaceRoot) {
  const path = getWorkerStatusPath(workspaceRoot);
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function resolveEffectiveWorkerState(localState = {}, workspaceRoot) {
  const durable = readWorkerRuntimeStatus(workspaceRoot);
  if (!durable) return localState;
  const localTs = Date.parse(localState.last_tick_finished_at || localState.last_tick_started_at || localState.started_at || 0) || 0;
  const durableTs = Date.parse(durable.last_tick_finished_at || durable.last_tick_started_at || durable.started_at || durable.observed_at || 0) || 0;
  return durableTs > localTs ? { ...localState, ...durable, source: 'durable_runtime' } : localState;
}
