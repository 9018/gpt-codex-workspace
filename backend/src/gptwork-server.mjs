import { join } from "node:path";
import { StateStore } from "./state-store.mjs";
import { createBrowserRegistry } from "./browser-http.mjs";
import { createGithubSync } from "./github-adapter.mjs";
import { RepoRegistry } from "./repo-registry.mjs";
import { createBarkNotifier } from "./bark-notifier.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { buildRuntimeConfig } from "./runtime-config.mjs";
import { toolList, initializeResult, jsonResult, jsonError } from "./mcp-tooling.mjs";
import { parseTokens, parseTokenContexts, normalizeTokenContexts, defaultTokenContext, assertAuthorized } from "./auth-context.mjs";
import { setTerminalNotifier } from "./task-lifecycle.mjs";
import { setCreatedTaskNotifier } from "./goal-task-lifecycle.mjs";
import { processGeneralTask } from "./task-general-processor.mjs";
import { determineBarkConfigSource } from "./diagnostics-service.mjs";
import { createWorkerState } from "./codex-worker-state.mjs";
import { applyOptionSourceOverrides, createServerContext } from "./server-context.mjs";
import { startCodexWorker as _startCodexWorker, runAssignedCodexTasks as _runAssignedCodexTasks } from "./codex-worker.mjs";
import { createReconciler } from "./runtime-reconciler.mjs";
import { summarizeToolResult } from "./tool-result-summary.mjs";
import { listenHttp } from "./server-http-listener.mjs";
import { createTools } from "./server-tools.mjs";
let notifyTerminalTaskIfNeeded = null;
let notifyCreatedTaskIfNeeded = null;

const PROCESS_STARTED_AT = new Date();

// Process-level Codex worker state tracking.
// Populated by startCodexWorker; read by worker_status,
// runtime_status, and gptwork_doctor tools.
const workerState = createWorkerState();

export async function createGptWorkServer(options = {}) {
  const tokenContexts = normalizeTokenContexts(
    options.tokenContexts || parseTokenContexts(process.env.GPTWORK_TOKEN_CONTEXTS || ""),
    options.tokens || parseTokens(process.env.GPTWORK_TOKENS || process.env.GPTWORK_API_TOKEN || "dev-token,test")
  );
  // Load workspace-local runtime env FIRST so runtime.env values
  // (GPTWORK_WORKSPACE_ROOT, GPTWORK_STATE_PATH, etc.) are available
  // for path computation.  Precedence: options > process.env > runtime.env > defaults.
  const _baseWorkspaceRoot = options.defaultWorkspaceRoot || process.env.GPTWORK_WORKSPACE_ROOT || "./data/workspaces/default";
  const earlyEnvResult = loadRuntimeEnv(_baseWorkspaceRoot, process.env.GPTWORK_RUNTIME_ENV_FILE);

  // After runtime.env is loaded, recompute workspace root and state path
  // so GPTWORK_WORKSPACE_ROOT / GPTWORK_STATE_PATH from the file take effect.
  const defaultWorkspaceRoot = options.defaultWorkspaceRoot || process.env.GPTWORK_WORKSPACE_ROOT || _baseWorkspaceRoot;
  const hasExplicitStatePath = options.statePath !== undefined || process.env.GPTWORK_STATE_PATH !== undefined;
  const oldDefaultStatePath = options.statePath !== undefined ? null : "./data/state.json";
  const statePath = hasExplicitStatePath
    ? (options.statePath || process.env.GPTWORK_STATE_PATH)
    : join(defaultWorkspaceRoot, ".gptwork/state.json");

  const rc = buildRuntimeConfig(
    defaultWorkspaceRoot,
    process.env.GPTWORK_RUNTIME_ENV_FILE,
    earlyEnvResult.keys  // pass preloaded keys so source tracking stays correct
  );
  const { config: rcc, sources, envLoadResult } = rc;
  const config = {
    statePath,
    defaultWorkspaceRoot,
    tokens: Object.keys(tokenContexts),
    tokenContexts,
    requireAuth: options.requireAuth ?? rcc.requireAuth,
    codexHome: options.codexHome || rcc.codexHome,
    codexExecArgs: options.codexExecArgs || rcc.codexExecArgs,
    codexExecTimeout: Number(options.codexExecTimeout || rcc.codexExecTimeout),
    codexFirstOutputTimeout: Number(options.codexFirstOutputTimeout || rcc.codexFirstOutputTimeout || 180),
    pythonCommand: options.pythonCommand || rcc.python,
    codexStallThreshold: Number(options.codexStallThreshold || rcc.codexStallThreshold),
    maxReadBytes: rcc.maxReadBytes,
    maxShellOutputBytes: rcc.maxShellOutputBytes,
    barkEnabled: options.barkEnabled ?? rcc.barkEnabled,
    barkUrl: options.barkUrl ?? rcc.barkUrl,
    barkKey: options.barkKey ?? rcc.barkKey,
    barkGroup: options.barkGroup ?? rcc.barkGroup,
    barkSound: options.barkSound ?? rcc.barkSound,
    barkLevel: options.barkLevel ?? rcc.barkLevel,
    shellTimeout: rcc.shellTimeout,
    // Git defaults from unified config
    defaultRepo: rcc.defaultRepo,
    defaultBranch: rcc.defaultBranch,
    defaultRepoPath: options.defaultRepoPath || rcc.defaultRepoPath,
    defaultRemote: rcc.defaultRemote,
    // GitHub config from unified config
    githubEnabled: rcc.githubEnabled,
    githubRepo: rcc.githubRepo,
    githubToken: rcc.githubToken,
    // Config sources for diagnostics
    _sources: sources,
  };
  // Augment source tracking: options overrides take highest precedence.
  // Keys explicitly passed via createGptWorkServer(options) are labeled "options".
  applyOptionSourceOverrides(sources, options);
  const store = new StateStore({ ...config, oldDefaultStatePath });
  await store.load();
  const browser = createBrowserRegistry();
  const github = createGithubSync(config);
  const barkConfigSource = determineBarkConfigSource(envLoadResult.keys);
  // Pass only explicitly-provided bark options (not resolved values from process.env)
  // so createBarkNotifier can correctly track whether values came from options or env.
  const barkOptions = {};
  if (options.barkEnabled !== undefined) barkOptions.barkEnabled = options.barkEnabled;
  if (options.barkUrl !== undefined) barkOptions.barkUrl = options.barkUrl;
  if (options.barkKey !== undefined) barkOptions.barkKey = options.barkKey;
  if (options.barkGroup !== undefined) barkOptions.barkGroup = options.barkGroup;
  if (options.barkSound !== undefined) barkOptions.barkSound = options.barkSound;
  if (options.barkLevel !== undefined) barkOptions.barkLevel = options.barkLevel;
  if (options.barkIconUrl !== undefined) barkOptions.barkIconUrl = options.barkIconUrl;
  if (options.barkClickUrl !== undefined) barkOptions.barkClickUrl = options.barkClickUrl;
  const bark = createBarkNotifier(barkOptions, barkConfigSource);
  ({ notifyTerminalTaskIfNeeded, notifyCreatedTaskIfNeeded } = createNotificationService(bark));
  const serverContext = createServerContext({ config, store, browser, github, bark, barkConfigSource, envLoadResult, earlyEnvResult });
setTerminalNotifier(notifyTerminalTaskIfNeeded);
  setCreatedTaskNotifier(notifyCreatedTaskIfNeeded);
  const reconciler = createReconciler({ store, config, github, notifyTerminalTaskIfNeeded });

  // Create the repo registry
  const registry = new RepoRegistry({
    registryPath: join(config.defaultWorkspaceRoot, ".gptwork/repos.json"),
    workspaceRoot: config.defaultWorkspaceRoot,
  });
  await registry.load().catch(function() {});
  const tools = createTools({ store, config, browser, github, bark, envLoadResult, sources, registry, workerState, processStartedAt: PROCESS_STARTED_AT, notifyCreatedTaskIfNeeded });

  return {
    async runAssignedCodexTasks(args = {}, context = defaultTokenContext("worker")) {
      return _runAssignedCodexTasks(store, config, github, args, context, { processGeneralTask });
    },

    async syncGithubIssuesForWorker({ limit = 20 } = {}) {
      if (!github?.enabled) return { ok: true, enabled: false, imported_tasks: 0, imported_responses: 0 };
      const imported = await github.importFromIssues(store, { limit, assignToCodex: true });
      const responses = await github.importResponsesFromComments(store);
      return {
        ok: true,
        enabled: true,
        limit,
        imported_tasks: imported.length,
        imported_task_ids: imported.map((task) => task.id),
        imported_responses: responses.length,
      };
    },

    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      return reconciler.reconcileStaleTasks(context);
    },    // P2.1: Generate a human-readable summary from structured tool results
    summarizeToolResult,


    async handleRpc(message, headers = {}, emitProgress = () => {}) {
      try {
        if (!message || message.jsonrpc !== "2.0") return jsonError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
        if (message.method === "initialize") return jsonResult(message.id, initializeResult());
        if (message.method === "notifications/initialized") return null;
        if (message.method === "tools/list") {
          assertAuthorized(headers, config);
          return jsonResult(message.id, { tools: toolList(tools) });
        }
        if (message.method === "tools/call") {
          const context = { ...assertAuthorized(headers, config), emitProgress };
          const name = message.params?.name;
          const args = message.params?.arguments || {};
          const handler = tools[name]?.handler;
          if (!handler) return jsonError(message.id, -32601, `Unknown tool: ${name}`);
          const structuredContent = await handler(args, context);
          const summary = this.summarizeToolResult(name, structuredContent);
          return jsonResult(message.id, {
            content: [{ type: "text", text: summary }],
            structuredContent,
            isError: false
          });
        }
        return jsonError(message.id, -32601, `Unknown method: ${message.method}`);
      } catch (error) {
        return jsonError(message?.id ?? null, error.code || -32000, error.message);
      }
    },

    async listen(options = {}) {
      return listenHttp(this, options);
    }
  };
}

export function startCodexWorker(server, opts = {}) {
  return _startCodexWorker(server, { ...opts, workerState });
}
