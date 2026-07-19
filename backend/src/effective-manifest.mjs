/**
 * effective-manifest.mjs
 *
 * Effective Runtime Manifest — formal aggregation of ALL runtime configuration
 * keys with source precedence tracking.
 *
 * Source precedence: process.env > runtime.env > code defaults
 *
 * Exports:
 *   getEffectiveManifest()  — returns canonical runtime manifest JSON
 */

import { buildRuntimeConfig } from './runtime-config.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { resolveEnvFilePath } from './runtime-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the canonical Effective Runtime Manifest.
 *
 * The manifest aggregates:
 * - All resolved config keys (host, port, toolMode, workspaceRoot, statePath, etc.)
 * - Source precedence tracking
 * - Agent backend configuration
 * - System diagnostics (node version, platform, cwd, hostname)
 * - Worker configuration
 * - Env source summary
 *
 * @returns {object} Canonical runtime manifest.
 */
export function getEffectiveManifest() {
  const workspaceRoot = _detectWorkspaceRoot();
  const envFilePath = resolveEnvFilePath(workspaceRoot);
  const { config, sources, envLoadResult } = buildRuntimeConfig(workspaceRoot, envFilePath);

  // Build source map: which config key came from where
  const sourceMap = {};
  const knownKeys = _getKnownConfigKeys();
  for (const key of knownKeys) {
    const camelKey = _configKeyToCamel(key);
    if (camelKey && sources && typeof sources === 'object' && sources[camelKey]) {
      sourceMap[key] = sources[camelKey];
    } else if (process.env[key] !== undefined) {
      sourceMap[key] = 'process.env';
    } else if (envLoadResult && _envHasKey(envLoadResult, key)) {
      sourceMap[key] = 'runtime.env';
    } else {
      sourceMap[key] = 'default';
    }
  }

  const agentBackends = {
    defaultBackend: config.executeProvider || 'codex_tui_goal',
    roleBackends: config.agentRoleBackends || {},
    localCommand: config.agentLocalCommand || null,
  };

  const system = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    cwd: process.cwd(),
    pid: process.pid,
    uptime: process.uptime(),
    memoryUsage: _getMemoryUsage(),
  };

  return {
    version: '1.0.0',
    toolMode: config.toolMode || 'standard',
    host: config.host || '127.0.0.1',
    port: config.port || 8787,
    workspaceRoot: config.workspaceRoot || workspaceRoot,
    statePath: config.statePath || '',
    envSource: {
      runtimeEnvPath: (envLoadResult && envLoadResult.loadedPath) || '(not loaded)',
      runtimeEnvKeys: (envLoadResult && envLoadResult.keys) || [],
      sourceMap,
    },
    agentBackends,
    worker: {
      enabled: !!config.codexWorker,
      concurrency: config.codexConcurrency || 1,
      execTimeout: config.codexExecTimeout || 3600,
    },
    storage: {
      statePath: config.statePath || '',
      retentionLimit: config.retentionLimit || 50,
    },
    system,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _detectWorkspaceRoot() {
  const fromEnv = process.env.GPTWORK_WORKSPACE_ROOT;
  if (fromEnv) return resolve(fromEnv);
  return resolve(PROJECT_ROOT, 'data/workspaces/default');
}

function _configKeyToCamel(key) {
  const map = {
    GPTWORK_HOST: 'host',
    GPTWORK_PORT: 'port',
    GPTWORK_TOOL_MODE: 'toolMode',
    GPTWORK_WORKSPACE_ROOT: 'workspaceRoot',
    GPTWORK_STATE_PATH: 'statePath',
    GPTWORK_CODEX_WORKER: 'codexWorker',
    GPTWORK_CODEX_EXEC_TIMEOUT: 'codexExecTimeout',
    GPTWORK_CODEX_CONCURRENCY: 'codexConcurrency',
    GPTWORK_AGENT_BACKEND: 'agentBackend',
    GPTWORK_AGENT_ROLE_BACKENDS: 'agentRoleBackends',
    GPTWORK_AGENT_LOCAL_COMMAND: 'agentLocalCommand',
    GPTWORK_RENDER_MODE: 'renderMode',
    GPTWORK_RETENTION_LIMIT: 'retentionLimit',
    GPTWORK_TOKENS: 'tokens',
    GPTWORK_LOG_PATH: 'logPath',
    GPTWORK_DEFAULT_REPO: 'defaultRepo',
    GPTWORK_GITHUB_ENABLED: 'githubEnabled',
    GPTWORK_GITHUB_REPO: 'githubRepo',
    GPTWORK_BARK_ENABLED: 'barkEnabled',
  };
  return map[key] || null;
}

function _getKnownConfigKeys() {
  return [
    'GPTWORK_HOST',
    'GPTWORK_PORT',
    'GPTWORK_TOOL_MODE',
    'GPTWORK_WORKSPACE_ROOT',
    'GPTWORK_STATE_PATH',
    'GPTWORK_CODEX_WORKER',
    'GPTWORK_CODEX_EXEC_TIMEOUT',
    'GPTWORK_CODEX_CONCURRENCY',
    'GPTWORK_AGENT_BACKEND',
    'GPTWORK_AGENT_ROLE_BACKENDS',
    'GPTWORK_AGENT_LOCAL_COMMAND',
    'GPTWORK_RENDER_MODE',
    'GPTWORK_RETENTION_LIMIT',
    'GPTWORK_TOKENS',
    'GPTWORK_LOG_PATH',
    'GPTWORK_DEFAULT_REPO',
    'GPTWORK_GITHUB_ENABLED',
    'GPTWORK_GITHUB_REPO',
    'GPTWORK_BARK_ENABLED',
  ];
}

function _envHasKey(envLoadResult, key) {
  if (!envLoadResult || !Array.isArray(envLoadResult.keys)) return false;
  return envLoadResult.keys.includes(key);
}

function _getMemoryUsage() {
  try {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
    };
  } catch {
    return {};
  }
}
