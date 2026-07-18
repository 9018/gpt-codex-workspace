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
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCodexHomeMode, resolveCodexHome } from "./path-context/codex-home-resolver.mjs";
import { parseBooleanEnv } from "./tool-discovery/tool-discovery-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const BACKEND_ROOT = resolve(PROJECT_ROOT, "backend");

const RENDER_MODES = new Set(["text", "selective", "card"]);

export function normalizeRenderMode(value = "text") {
  const normalized = String(value || "text").trim().toLowerCase();
  if (!RENDER_MODES.has(normalized)) {
    throw new Error(`GPTWORK_RENDER_MODE must be one of: text, selective, card; got: ${value}`);
  }
  return normalized;
}

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

function _getBoolAliases(keys, defaultVal) {
  for (const key of keys) {
    if (process.env[key] !== undefined) return _getBool(key, defaultVal);
  }
  return defaultVal;
}

function parseRoleBackendMap(raw) {
  const text = String(raw || "").trim();
  if (!text) return {};
  const out = {};
  for (const entry of text.split(",")) {
    const part = entry.trim();
    if (!part) continue;
    const sep = part.includes("=") ? "=" : part.includes(":") ? ":" : null;
    if (!sep) continue;
    const idx = part.indexOf(sep);
    const role = part.slice(0, idx).trim().toLowerCase();
    const backend = part.slice(idx + 1).trim().toLowerCase();
    if (role && backend) out[role] = backend;
  }
  return out;
}

function parseRoleCommandMap(raw) {
  const text = String(raw || "").trim();
  if (!text) return {};
  const out = {};
  for (const entry of text.split("||")) {
    const part = entry.trim();
    if (!part) continue;
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const role = part.slice(0, idx).trim().toLowerCase();
    const command = part.slice(idx + 1).trim();
    if (role && command) out[role] = command;
  }
  return out;
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

  function _sourceAliases(envKeys) {
    for (const envKey of envKeys) {
      const source = _source(envKey);
      if (source !== "default") return source;
    }
    return "default";
  }

  const requireSuperpowersForTui = _getBoolAliases([
    "GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI",
    "GPTWORK_REQUIRE_SUPERPOWERS_PLUGIN_FOR_TUI_FALLBACK",
  ], true);
  const backendRoot = resolve(workspaceRoot || PROJECT_ROOT, "backend");
  const defaultRepoPath = _get("GPTWORK_DEFAULT_REPO_PATH", "");
  const codexHomeMode = normalizeCodexHomeMode(_get("GPTWORK_CODEX_HOME_MODE", "project"));
  const codexHome = resolveCodexHome({
    projectRoot: defaultRepoPath || workspaceRoot || PROJECT_ROOT,
    mode: codexHomeMode,
    explicitPath: _get("GPTWORK_CODEX_HOME", ""),
  });

  // ── Resolved values ──────────────────────────────────────────────

  const config = {
    // Server
    host: _get("GPTWORK_HOST", "127.0.0.1"),
    port: _getNum("GPTWORK_PORT", 8787),
    workspaceRoot: _get("GPTWORK_WORKSPACE_ROOT", workspaceRoot),
    statePath: _get("GPTWORK_STATE_PATH", workspaceRoot + "/.gptwork/state.json"),
    runtimeEnvFile: _get("GPTWORK_RUNTIME_ENV_FILE", ".gptwork/runtime.env"),
    toolMode: _get("GPTWORK_TOOL_MODE", "standard"),
    delayedToolDiscovery: parseBooleanEnv(_get("GPTWORK_DELAYED_TOOL_DISCOVERY", false)).value,
    renderMode: normalizeRenderMode(_get("GPTWORK_RENDER_MODE", "text")),

    // Codex
    codexExecTimeout: _getNum("GPTWORK_CODEX_EXEC_TIMEOUT", 3600),
    shellMode: _get("GPTWORK_SHELL_MODE", "full"),
    writeMode: _get("GPTWORK_WRITE_MODE", "workspace"),
    codexWorker: _getBool("GPTWORK_CODEX_WORKER", false),
    codexWorkerInterval: _getNum("GPTWORK_CODEX_WORKER_INTERVAL_MS", 5000),
    codexWorkerConcurrency: _getNum("GPTWORK_CODEX_WORKER_CONCURRENCY", 4),
    supervisorWorkerEnabled: _getBool("GPTWORK_SUPERVISOR_WORKER_ENABLED", true),
    supervisorWorkerIntervalMs: _getNum("GPTWORK_SUPERVISOR_WORKER_INTERVAL_MS", 10000),
    shellTranscript: _get("GPTWORK_SHELL_TRANSCRIPT", "compact"),
    codexFirstOutputTimeout: _getNum("GPTWORK_CODEX_FIRST_OUTPUT_TIMEOUT", 180),
    codexContentFirstOutputTimeout: _getNum("GPTWORK_CODEX_CONTENT_FIRST_OUTPUT_TIMEOUT", 0),
    codexNoProgressTimeout: _getNum("GPTWORK_CODEX_NO_PROGRESS_TIMEOUT", 0),
    codexExecArgs: _get("GPTWORK_CODEX_EXEC_ARGS", "--yolo --skip-git-repo-check"),
    codexConcurrency: _getNum("GPTWORK_CODEX_CONCURRENCY", 4),
    codexStallThreshold: _getNum("GPTWORK_CODEX_STALL_THRESHOLD_SECONDS", 600),
    agentBackend: _get("GPTWORK_AGENT_BACKEND", "codex_exec"),
    agentRoleBackends: parseRoleBackendMap(_get("GPTWORK_AGENT_ROLE_BACKENDS", "")),
    agentLocalCommand: _get("GPTWORK_AGENT_LOCAL_COMMAND", ""),
    agentRoleCommands: parseRoleCommandMap(_get("GPTWORK_AGENT_ROLE_COMMANDS", "")),
    agentCommandTimeout: _getNum("GPTWORK_AGENT_COMMAND_TIMEOUT", 60),
    agentCommandFirstOutputTimeout: _getNum("GPTWORK_AGENT_COMMAND_FIRST_OUTPUT_TIMEOUT", 0),
    agentCommandNoProgressTimeout: _getNum("GPTWORK_AGENT_COMMAND_NO_PROGRESS_TIMEOUT", 0),
    deliveryResultRecoveryCommands: parseCommandList(_get("GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS", "")),
    resultRecoveryCommandTimeout: _getNum("GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT", 600),

    // Git defaults
    defaultRepo: _get("GPTWORK_DEFAULT_REPO", ""),
    defaultBranch: _get("GPTWORK_DEFAULT_BRANCH", "main"),
    defaultRepoPath,
    defaultRemote: _get("GPTWORK_DEFAULT_REMOTE", "origin"),
    enableTaskWorktrees: _getBool("GPTWORK_ENABLE_TASK_WORKTREES", true),

    // TUI-first branch loop
    loopStrategy: _get("GPTWORK_LOOP_STRATEGY", ""),
    executeProvider: _get("GPTWORK_EXECUTE_PROVIDER", "claude_tui_goal"),
    acceptProvider: _get("GPTWORK_ACCEPT_PROVIDER", "codex_tui_goal"),
    advanceProvider: _get("GPTWORK_ADVANCE_PROVIDER", "claude_exec_goal"),
    repairProvider: _get("GPTWORK_REPAIR_PROVIDER", "claude_tui_goal"),
    goalWorktreeRoot: _get("GPTWORK_GOAL_WORKTREE_ROOT", ""),
    goalBranchPrefix: _get("GPTWORK_GOAL_BRANCH_PREFIX", "gptwork/goal"),
    mergeTargetBranch: _get("GPTWORK_MERGE_TARGET_BRANCH", "main"),
    claudeCommand: _get("GPTWORK_CLAUDE_COMMAND", "claude"),
    codexCommand: _get("GPTWORK_CODEX_COMMAND", "codex"),
    claudeTuiEnabled: _getBool("GPTWORK_CLAUDE_TUI_ENABLED", false),
    codexTuiEnabled: _getBool("GPTWORK_CODEX_TUI_ENABLED", false),
    codexTuiCommand: _get("GPTWORK_CODEX_TUI_COMMAND", _get("GPTWORK_CODEX_COMMAND", "codex")),
    codexTuiEvidenceWaitMs: _getNum("GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS", 30000),
    codexTuiSessionRoot: _get("GPTWORK_CODEX_TUI_SESSION_ROOT", ""),
    tuiAutopilotEnabled: _getBool("GPTWORK_TUI_AUTOPILOT_ENABLED", true),
    tuiAutopilotMaxActions: _getNum("GPTWORK_TUI_AUTOPILOT_MAX_ACTIONS", 100),
    tuiAutopilotMaxRepairs: _getNum("GPTWORK_TUI_AUTOPILOT_MAX_REPAIRS", 3),
    tuiFrameStableMs: _getNum("GPTWORK_TUI_FRAME_STABLE_MS", 500),
    tuiNoProgressSeconds: _getNum("GPTWORK_TUI_NO_PROGRESS_SECONDS", 120),
    tuiClassifierEnabled: _getBool("GPTWORK_TUI_CLASSIFIER_ENABLED", true),
    requireSuperpowersForTui,
    requireSuperpowersPluginForTuiFallback: requireSuperpowersForTui,
    claudeExecAdvanceEnabled: _getBool("GPTWORK_CLAUDE_EXEC_ADVANCE_ENABLED", false),
    claudeTuiArgs: [],
    codexTuiArgs: [],
    advanceTimeoutMs: _getNum("GPTWORK_ADVANCE_TIMEOUT_MS", 300000),

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

    // Ephemeral execution / Planner IR / Artifact handoff
    ephemeralBatchEnabled: _getBool("GPTWORK_EPHEMERAL_BATCH_ENABLED", false),
    ephemeralBatchConcurrency: _getNum("GPTWORK_EPHEMERAL_BATCH_CONCURRENCY", 8),
    ephemeralBatchMaxCalls: _getNum("GPTWORK_EPHEMERAL_BATCH_MAX_CALLS", 32),
    planIrEnabled: _getBool("GPTWORK_PLAN_IR_ENABLED", false),
    artifactHandoffV3Enabled: _getBool("GPTWORK_ARTIFACT_HANDOFF_V3_ENABLED", false),

    // Other
    codexHomeMode,
    codexHome,
    python: _get("GPTWORK_PYTHON", process.platform === "win32" ? "python" : "python3"),
    logPath: _get("GPTWORK_LOG_PATH", ""),
    requireAuth: _getBool("GPTWORK_REQUIRE_AUTH", true),
    tokens: _get("GPTWORK_TOKENS", "dev-token,test"),
    sshSocksProxy: _get("GPTWORK_SSH_SOCKS_PROXY", ""),
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
    restartCommand: _get("GPTWORK_RESTART_COMMAND", `npm --prefix "${backendRoot}" run start`),
    restartCwd: _get("GPTWORK_RESTART_CWD", backendRoot),
    restartMarkerKind: _get("GPTWORK_RESTART_MARKER_KIND", "npm"),

    // Derive allowed roots array

    // Retention / compaction
    retentionEnabled: _getBool("GPTWORK_RETENTION_ENABLED", true),
    retentionLimit: _getNum("GPTWORK_RETENTION_LIMIT", 50),
    retentionDryRunDefault: _getBool("GPTWORK_RETENTION_DRY_RUN_DEFAULT", true),
    retentionArchiveBeforeDelete: _getBool("GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE", true),

    integrationMode: _get("GPTWORK_INTEGRATION_MODE", "auto"),
    // Context index
    contextVectorStore: _get("GPTWORK_CONTEXT_VECTOR_STORE", "auto"),
    contextBundleMaxTokens: _getNum("GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS", 2048),
    contextBundleMaxChunks: _getNum("GPTWORK_CONTEXT_BUNDLE_MAX_CHUNKS", 8),
    contextCrossGoalTopK: _getNum("GPTWORK_CONTEXT_CROSS_GOAL_TOP_K", 4),
    contextPerGoalTopK: _getNum("GPTWORK_CONTEXT_PER_GOAL_TOP_K", 4),
    contextMaxGoalsScanned: _getNum("GPTWORK_CONTEXT_MAX_GOALS_SCANNED", 20),

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
    delayedToolDiscovery: "GPTWORK_DELAYED_TOOL_DISCOVERY",
    renderMode: "GPTWORK_RENDER_MODE",
    codexExecTimeout: "GPTWORK_CODEX_EXEC_TIMEOUT",
    codexFirstOutputTimeout: "GPTWORK_CODEX_FIRST_OUTPUT_TIMEOUT",
    codexContentFirstOutputTimeout: "GPTWORK_CODEX_CONTENT_FIRST_OUTPUT_TIMEOUT",
    codexNoProgressTimeout: "GPTWORK_CODEX_NO_PROGRESS_TIMEOUT",
    codexExecArgs: "GPTWORK_CODEX_EXEC_ARGS",
    shellMode: "GPTWORK_SHELL_MODE",
    codexWorker: "GPTWORK_CODEX_WORKER",
    codexWorkerInterval: "GPTWORK_CODEX_WORKER_INTERVAL_MS",
    codexWorkerConcurrency: "GPTWORK_CODEX_WORKER_CONCURRENCY",
    supervisorWorkerEnabled: "GPTWORK_SUPERVISOR_WORKER_ENABLED",
    supervisorWorkerIntervalMs: "GPTWORK_SUPERVISOR_WORKER_INTERVAL_MS",
    writeMode: "GPTWORK_WRITE_MODE",
    integrationMode: "GPTWORK_INTEGRATION_MODE",
    shellTranscript: "GPTWORK_SHELL_TRANSCRIPT",
    codexConcurrency: "GPTWORK_CODEX_CONCURRENCY",
    codexStallThreshold: "GPTWORK_CODEX_STALL_THRESHOLD_SECONDS",
    agentBackend: "GPTWORK_AGENT_BACKEND",
    agentRoleBackends: "GPTWORK_AGENT_ROLE_BACKENDS",
    agentLocalCommand: "GPTWORK_AGENT_LOCAL_COMMAND",
    agentRoleCommands: "GPTWORK_AGENT_ROLE_COMMANDS",
    agentCommandTimeout: "GPTWORK_AGENT_COMMAND_TIMEOUT",
    agentCommandFirstOutputTimeout: "GPTWORK_AGENT_COMMAND_FIRST_OUTPUT_TIMEOUT",
    agentCommandNoProgressTimeout: "GPTWORK_AGENT_COMMAND_NO_PROGRESS_TIMEOUT",
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
    codexHomeMode: "GPTWORK_CODEX_HOME_MODE",
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
    contextBundleMaxTokens: "GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS",
    contextBundleMaxChunks: "GPTWORK_CONTEXT_BUNDLE_MAX_CHUNKS",
    contextCrossGoalTopK: "GPTWORK_CONTEXT_CROSS_GOAL_TOP_K",
    contextPerGoalTopK: "GPTWORK_CONTEXT_PER_GOAL_TOP_K",
    contextMaxGoalsScanned: "GPTWORK_CONTEXT_MAX_GOALS_SCANNED",

    loopStrategy: "GPTWORK_LOOP_STRATEGY",
    executeProvider: "GPTWORK_EXECUTE_PROVIDER",
    acceptProvider: "GPTWORK_ACCEPT_PROVIDER",
    advanceProvider: "GPTWORK_ADVANCE_PROVIDER",
    repairProvider: "GPTWORK_REPAIR_PROVIDER",
    goalWorktreeRoot: "GPTWORK_GOAL_WORKTREE_ROOT",
    goalBranchPrefix: "GPTWORK_GOAL_BRANCH_PREFIX",
    mergeTargetBranch: "GPTWORK_MERGE_TARGET_BRANCH",
    claudeCommand: "GPTWORK_CLAUDE_COMMAND",
    codexCommand: "GPTWORK_CODEX_COMMAND",
    claudeTuiEnabled: "GPTWORK_CLAUDE_TUI_ENABLED",
    codexTuiEnabled: "GPTWORK_CODEX_TUI_ENABLED",
    codexTuiCommand: "GPTWORK_CODEX_TUI_COMMAND",
    codexTuiEvidenceWaitMs: "GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS",
    codexTuiSessionRoot: "GPTWORK_CODEX_TUI_SESSION_ROOT",
    tuiAutopilotEnabled: "GPTWORK_TUI_AUTOPILOT_ENABLED",
    tuiAutopilotMaxActions: "GPTWORK_TUI_AUTOPILOT_MAX_ACTIONS",
    tuiAutopilotMaxRepairs: "GPTWORK_TUI_AUTOPILOT_MAX_REPAIRS",
    tuiFrameStableMs: "GPTWORK_TUI_FRAME_STABLE_MS",
    tuiNoProgressSeconds: "GPTWORK_TUI_NO_PROGRESS_SECONDS",
    tuiClassifierEnabled: "GPTWORK_TUI_CLASSIFIER_ENABLED",
    requireSuperpowersForTui: "GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI",
    claudeExecAdvanceEnabled: "GPTWORK_CLAUDE_EXEC_ADVANCE_ENABLED",
    advanceTimeoutMs: "GPTWORK_ADVANCE_TIMEOUT_MS",

  };

  const sources = {};
  for (const [ck, ev] of Object.entries(KEY_MAP)) {
    sources[ck] = _source(ev);
  }
  sources.requireSuperpowersForTui = _sourceAliases([
    "GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI",
    "GPTWORK_REQUIRE_SUPERPOWERS_PLUGIN_FOR_TUI_FALLBACK",
  ]);
  sources.requireSuperpowersPluginForTuiFallback = sources.requireSuperpowersForTui;
  if (codexHomeMode !== "explicit") sources.codexHome = "default";

  return { config, sources, envLoadResult };
}

export { loadRuntimeEnv };

function parseCommandList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.split("||").map((item) => item.trim()).filter(Boolean);
}
