import {
  scanPendingRestartMarkers,
  scheduleServiceRestart,
  validateWorkspaceRoot,
} from './safe-restart.mjs';
import { getRestartStrategy } from './restart-strategy.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';


function parseRuntimeEnvText(text = '') {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function candidateRuntimeEnvPaths(config = {}) {
  const candidates = [];
  const add = (value, base, allowCwdFallback = false) => {
    if (!value) return;
    const text = String(value);
    if (isAbsolute(text)) candidates.push(text);
    else if (base) candidates.push(resolve(base, text));
    else if (allowCwdFallback) candidates.push(resolve(process.cwd(), text));
  };
  add(process.env.GPTWORK_RUNTIME_ENV_FILE || config.runtimeEnvFile, config.defaultWorkspaceRoot || config.defaultRepoPath, true);
  add('.gptwork/runtime.env', config.defaultRepoPath);
  add('.gptwork/runtime.env', config.defaultWorkspaceRoot);
  return [...new Set(candidates)];
}

function loadFreshRestartRuntimeEnv(config = {}) {
  for (const filePath of candidateRuntimeEnvPaths(config)) {
    if (!existsSync(filePath)) continue;
    try {
      return { path: filePath, values: parseRuntimeEnvText(readFileSync(filePath, 'utf8')) };
    } catch {
      return { path: filePath, values: {} };
    }
  }
  return { path: null, values: {} };
}

function withFreshRestartConfig(config = {}) {
  const runtimeEnv = loadFreshRestartRuntimeEnv(config);
  const env = runtimeEnv.values || {};
  const fresh = {
    ...config,
    defaultWorkspaceRoot: env.GPTWORK_WORKSPACE_ROOT || config.defaultWorkspaceRoot,
    defaultRepoPath: env.GPTWORK_DEFAULT_REPO_PATH || config.defaultRepoPath,
    restartMode: env.GPTWORK_RESTART_MODE || config.restartMode,
    restartCommand: env.GPTWORK_RESTART_COMMAND || config.restartCommand,
    restartCwd: env.GPTWORK_RESTART_CWD || config.restartCwd,
    restartMarkerKind: env.GPTWORK_RESTART_MARKER_KIND || config.restartMarkerKind,
    runtimeEnvFile: runtimeEnv.path || config.runtimeEnvFile,
  };
  return { config: fresh, runtimeEnvPath: runtimeEnv.path };
}

export async function handleScheduleServiceRestart(
  { task_id, expected_commit = null, expected_remote_head = null } = {},
  { config, store, requestedBy = 'codex', serviceName } = {},
) {
  const { config: freshConfig, runtimeEnvPath } = withFreshRestartConfig(config || {});
  const workspaceRoot = freshConfig?.defaultWorkspaceRoot;
  const validation = validateWorkspaceRoot(workspaceRoot);
  if (!validation.valid && validation.reason === 'workspaceRoot is required') return { ok: false, error: validation.reason };

  // Determine restart strategy from freshly reparsed runtime.env config.
  const restartStrategy = freshConfig ? getRestartStrategy(freshConfig) : null;
  const restartMode = restartStrategy ? restartStrategy.mode : 'npm';

  return scheduleServiceRestart({
    workspaceRoot,
    taskId: task_id,
    requestedBy,
    serviceName: serviceName || `gptwork-mcp (${restartMode}-managed)`,
    expectedCommit: expected_commit,
    expectedRemoteHead: expected_remote_head,
    repoPath: freshConfig?.defaultRepoPath,
    store,
    restartConfig: restartStrategy,
    skipWorkspaceRootValidation: !validation.valid,
    workspaceRootValidationWarning: !validation.valid ? validation.reason : null,
    runtimeEnvPath,
  });
}

export async function handleListPendingRestarts(_args = {}, { config } = {}) {
  const markers = await scanPendingRestartMarkers(config?.defaultWorkspaceRoot);
  return { count: markers.length, markers };
}
