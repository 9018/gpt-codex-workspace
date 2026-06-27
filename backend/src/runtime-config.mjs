/**
 * Unified runtime configuration for GPTWork/workmcp.
 *
 * Loads runtime.env (dotenv-style KEY=VALUE with comments),
 * resolves all GPTWORK_* config keys with proper precedence:
 *   process.env > runtime.env > code defaults
 *
 * Exports:
 *   loadRuntimeEnv    - (re-exported from runtime-env.mjs) low-level env file loader
 *   buildRuntimeConfig - build full resolved config with per-key source tracking
 *
 * The returned sources map identifies where each config value came from:
 *   "process.env"    - set in the system/process environment
 *   "runtime.env"    - loaded from the runtime.env file
 *   "default"        - code-defined default (no explicit value anywhere)
 */

import { loadRuntimeEnv, resolveEnvFilePath } from "./runtime-env.mjs";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _get(key, defaultVal) {
  const v = process.env[key];
  return v !== undefined ? v : defaultVal;
}

function _getNum(key, defaultVal) {
  const v = process.env[key];
  if (v === undefined) return defaultVal;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
}

function _getBool(key, defaultVal) {
  const v = process.env[key];
  if (v === undefined) return defaultVal;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full resolved runtime configuration object with per-key source tracking.
 *
 * @param {string}  workspaceRoot  - absolute path to the workspace root directory
 * @param {string}  [overridePath] - explicit path to runtime.env file (override)
 * @returns {{ config: object, sources: object<string,string>, envLoadResult: object }}
 *
 * `config` contains the final resolved values for all operational keys.
 * `sources` maps each config key to its source label.
 * `envLoadResult` is the raw result from loadRuntimeEnv ({ loadedPath, keys }).
 */
export function buildRuntimeConfig(workspaceRoot, overridePath, preloadedKeys = []) {
  const envLoadResult = loadRuntimeEnv(workspaceRoot, overridePath);
  envLoadResult.keys = [...new Set([...envLoadResult.keys, ...preloadedKeys])];
  // Also collect all keys from the file directly (handles preloading by cli.mjs)
  try {
    const filePath = resolveEnvFilePath(workspaceRoot, overridePath);
    if (filePath && existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      const fileKeys = [];
      const rawLines = text.split(String.fromCharCode(10));
      for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const k = line.slice(0, eqIdx).trim();
        if (!k) continue;
        if (process.env[k] !== undefined) continue;
        fileKeys.push(k);
      }
      envLoadResult.keys = [...new Set([...envLoadResult.keys, ...fileKeys])];
    }
  } catch { /* non-fatal */ }
  const loadedKeys = envLoadResult.keys;

  // Source resolver: runtime.env set this key? process.env had it already? default.
  function _source(envKey) {
    if (loadedKeys.includes(envKey)) return "runtime.env";
    if (process.env[envKey] !== undefined) return "process.env";
    return "default";
  }

  // ── Resolved values ──────────────────────────────────────────────

  const config = {
    // Server
    host: _get("GPTWORK_HOST", "127.0.0.1"),
    port: _getNum("GPTWORK_PORT", 8787),
    workspaceRoot: _get("GPTWORK_WORKSPACE_ROOT", workspaceRoot),
    statePath: _get("GPTWORK_STATE_PATH", workspaceRoot + "/.gptwork/state.json"),
    runtimeEnvFile: _get("GPTWORK_RUNTIME_ENV_FILE", ".gptwork/runtime.env"),
    toolMode: _get("GPTWORK_TOOL_MODE", "standard"),

    // Codex
    codexExecTimeout: _getNum("GPTWORK_CODEX_EXEC_TIMEOUT", 3600),
    shellMode: _get("GPTWORK_SHELL_MODE", "full"),
    writeMode: _get("GPTWORK_WRITE_MODE", "workspace"),
    shellTranscript: _get("GPTWORK_SHELL_TRANSCRIPT", "compact"),
    codexFirstOutputTimeout: _getNum("GPTWORK_CODEX_FIRST_OUTPUT_TIMEOUT", 180),
    codexExecArgs: _get("GPTWORK_CODEX_EXEC_ARGS", "--yolo --skip-git-repo-check"),
    codexConcurrency: _getNum("GPTWORK_CODEX_CONCURRENCY", 4),
    codexStallThreshold: _getNum("GPTWORK_CODEX_STALL_THRESHOLD_SECONDS", 600),
    deliveryResultRecoveryCommands: parseCommandList(_get("GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS", "")),
    resultRecoveryCommandTimeout: _getNum("GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT", 600),

    // Git defaults
    defaultRepo: _get("GPTWORK_DEFAULT_REPO", ""),
    defaultBranch: _get("GPTWORK_DEFAULT_BRANCH", "main"),
    defaultRepoPath: _get("GPTWORK_DEFAULT_REPO_PATH", ""),
    defaultRemote: _get("GPTWORK_DEFAULT_REMOTE", "origin"),
    enableTaskWorktrees: _getBool("GPTWORK_ENABLE_TASK_WORKTREES", true),

    // Bark
    barkEnabled: _get("GPTWORK_BARK_ENABLED", ""),
    barkUrl: _get("GPTWORK_BARK_URL", ""),
    barkKey: _get("GPTWORK_BARK_KEY", ""),
    barkGroup: _get("GPTWORK_BARK_GROUP", "gptwork"),
    barkSound: _get("GPTWORK_BARK_SOUND", ""),
    barkLevel: _get("GPTWORK_BARK_LEVEL", ""),
    barkIconUrl: _get("GPTWORK_BARK_ICON_URL", ""),
    barkClickUrl: _get("GPTWORK_BARK_CLICK_URL", ""),
    barkBadge: _get("GPTWORK_BARK_BADGE", ""),

    // GitHub
    githubEnabled: _getBool("GPTWORK_GITHUB_ENABLED", false),
    githubRepo: _get("GPTWORK_GITHUB_REPO", ""),
    githubToken: _get("GPTWORK_GITHUB_TOKEN", ""),

    // Shell/exec
    shellTimeout: _getNum("GPTWORK_SHELL_TIMEOUT", 60),
    maxOutputBytes: _getNum("GPTWORK_MAX_OUTPUT_BYTES", 200000),
    maxReadBytes: _getNum("GPTWORK_MAX_READ_BYTES", 200000),
    maxShellOutputBytes: _getNum("GPTWORK_MAX_SHELL_OUTPUT_BYTES", 200000),

    // Other
    codexHome: _get("GPTWORK_CODEX_HOME", "/home/a9017"),
    python: _get("GPTWORK_PYTHON", process.platform === "win32" ? "python" : "python3"),
    logPath: _get("GPTWORK_LOG_PATH", ""),
    requireAuth: _getBool("GPTWORK_REQUIRE_AUTH", true),
    tokens: _get("GPTWORK_TOKENS", "dev-token,test"),
    sshSocksProxy: _get("GPTWORK_SSH_SOCKS_PROXY", "10.0.1.105:20177"),
    tokenContexts: _get("GPTWORK_TOKEN_CONTEXTS", ""),
    // Recovery / break-glass plane
    recoveryPlaneEnabled: _getBool("GPTWORK_RECOVERY_PLANE_ENABLED", false),
    breakGlassEnabled: _getBool("GPTWORK_BREAK_GLASS_ENABLED", false),
    recoveryAllowedRoots: _get("GPTWORK_RECOVERY_ALLOWED_ROOTS", ""),
    recoveryDryRunDefault: _getBool("GPTWORK_RECOVERY_DRY_RUN_DEFAULT", true),
    recoveryAuditLog: _get("GPTWORK_RECOVERY_AUDIT_LOG", ".gptwork/admin-audit.jsonl"),
    recoveryUnrestrictedLocalCommandEnabled: _getBool("GPTWORK_RECOVERY_UNRESTRICTED_LOCAL_COMMAND_ENABLED", false),

    // Restart strategy
    restartMode: _get("GPTWORK_RESTART_MODE", "npm"),
    restartCommand: _get("GPTWORK_RESTART_COMMAND", "npm --prefix /home/a9017/mcp/workspace/gpt-codex-workspace/backend run start"),
    restartCwd: _get("GPTWORK_RESTART_CWD", "/home/a9017/mcp/workspace/gpt-codex-workspace/backend"),
    restartMarkerKind: _get("GPTWORK_RESTART_MARKER_KIND", "npm"),

    // Derive allowed roots array

    // Retention / compaction
    retentionEnabled: _getBool("GPTWORK_RETENTION_ENABLED", true),
    retentionLimit: _getNum("GPTWORK_RETENTION_LIMIT", 50),
    retentionDryRunDefault: _getBool("GPTWORK_RETENTION_DRY_RUN_DEFAULT", true),
    retentionArchiveBeforeDelete: _getBool("GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE", true),

    // Context index
    contextVectorStore: _get("GPTWORK_CONTEXT_VECTOR_STORE", "auto"),

    _recoveryAllowedRootsArr: (() => {
      const raw = _get("GPTWORK_RECOVERY_ALLOWED_ROOTS", "");
      if (!raw) return [];
      return raw.split(",").map(s => s.trim()).filter(Boolean);
    })(),

  };

  // ── Per-key source tracking ──────────────────────────────────────

  /** Maps config camelCase key -> env var name */
  const KEY_MAP = {
    host: "GPTWORK_HOST",
    port: "GPTWORK_PORT",
    workspaceRoot: "GPTWORK_WORKSPACE_ROOT",
    statePath: "GPTWORK_STATE_PATH",
    runtimeEnvFile: "GPTWORK_RUNTIME_ENV_FILE",
    toolMode: "GPTWORK_TOOL_MODE",
    codexExecTimeout: "GPTWORK_CODEX_EXEC_TIMEOUT",
    codexFirstOutputTimeout: "GPTWORK_CODEX_FIRST_OUTPUT_TIMEOUT",
    codexExecArgs: "GPTWORK_CODEX_EXEC_ARGS",
    shellMode: "GPTWORK_SHELL_MODE",
    writeMode: "GPTWORK_WRITE_MODE",
    shellTranscript: "GPTWORK_SHELL_TRANSCRIPT",
    codexConcurrency: "GPTWORK_CODEX_CONCURRENCY",
    codexStallThreshold: "GPTWORK_CODEX_STALL_THRESHOLD_SECONDS",
    deliveryResultRecoveryCommands: "GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS",
    resultRecoveryCommandTimeout: "GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT",
    defaultRepo: "GPTWORK_DEFAULT_REPO",
    defaultBranch: "GPTWORK_DEFAULT_BRANCH",
    defaultRepoPath: "GPTWORK_DEFAULT_REPO_PATH",
    defaultRemote: "GPTWORK_DEFAULT_REMOTE",
    enableTaskWorktrees: "GPTWORK_ENABLE_TASK_WORKTREES",
    barkEnabled: "GPTWORK_BARK_ENABLED",
    barkUrl: "GPTWORK_BARK_URL",
    barkKey: "GPTWORK_BARK_KEY",
    barkGroup: "GPTWORK_BARK_GROUP",
    barkSound: "GPTWORK_BARK_SOUND",
    barkLevel: "GPTWORK_BARK_LEVEL",
    barkIconUrl: "GPTWORK_BARK_ICON_URL",
    barkClickUrl: "GPTWORK_BARK_CLICK_URL",
    barkBadge: "GPTWORK_BARK_BADGE",
    githubEnabled: "GPTWORK_GITHUB_ENABLED",
    githubRepo: "GPTWORK_GITHUB_REPO",
    githubToken: "GPTWORK_GITHUB_TOKEN",
    shellTimeout: "GPTWORK_SHELL_TIMEOUT",
    maxOutputBytes: "GPTWORK_MAX_OUTPUT_BYTES",
    maxReadBytes: "GPTWORK_MAX_READ_BYTES",
    maxShellOutputBytes: "GPTWORK_MAX_SHELL_OUTPUT_BYTES",
    codexHome: "GPTWORK_CODEX_HOME",
    python: "GPTWORK_PYTHON",
    logPath: "GPTWORK_LOG_PATH",
    requireAuth: "GPTWORK_REQUIRE_AUTH",
    tokens: "GPTWORK_TOKENS",
    sshSocksProxy: "GPTWORK_SSH_SOCKS_PROXY",
    tokenContexts: "GPTWORK_TOKEN_CONTEXTS",
    restartMode: "GPTWORK_RESTART_MODE",
    restartCommand: "GPTWORK_RESTART_COMMAND",
    restartCwd: "GPTWORK_RESTART_CWD",
    restartMarkerKind: "GPTWORK_RESTART_MARKER_KIND",
    contextVectorStore: "GPTWORK_CONTEXT_VECTOR_STORE",

  };

  const sources = {};
  for (const [ck, ev] of Object.entries(KEY_MAP)) {
    sources[ck] = _source(ev);
  }

  return { config, sources, envLoadResult };
}

export { loadRuntimeEnv };

function parseCommandList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.split("||").map((item) => item.trim()).filter(Boolean);
}
