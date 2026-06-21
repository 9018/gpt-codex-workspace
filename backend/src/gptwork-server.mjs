import http from "node:http";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { StateStore } from "./state-store.mjs";
import { createBrowserRegistry } from "./browser-http.mjs";
import { createGithubSync } from "./github-adapter.mjs";
import { RepoRegistry } from "./repo-registry.mjs";
import { createBarkNotifier } from "./bark-notifier.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { buildRuntimeConfig } from "./runtime-config.mjs";
import { getRepoLockSummary, listRepoLocks } from "./repo-lock.mjs";
import {
  MCP_PROTOCOL_VERSION, schema, toolList, initializeResult, jsonResult, jsonError,
} from "./mcp-tooling.mjs";
import { handleHttp } from "./http-handler.mjs";
import { runtimeStatusCard, gptworkDoctorCard, getTaskCard, createEncodedGoalCard, contextStatusCard, githubStatusCard, previewCodexContextCard, shellExecCard, gitRemoteDiffCard, readTextFileCard, listDirCard, goalContextCard, formatToolCard, formatKeyValue } from "./card-utils.mjs";
import { tokenFromMcpPath, parseTokens, parseTokenContexts, normalizeTokenContexts, defaultTokenContext, defaultScopes, normalizeList, limits, assertAuthorized } from "./auth-context.mjs";
import { setTerminalNotifier } from "./task-lifecycle.mjs";
import { createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection } from "./workspace-lifecycle.mjs";
import { createTask, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage, ensureTaskGoal, normalizeAssignedTaskMode, setCreatedTaskNotifier } from "./goal-task-lifecycle.mjs";
import { processGeneralTask } from "./task-general-processor.mjs";

import { determineBarkConfigSource } from "./diagnostics-service.mjs";
import { createWorkerState } from "./codex-worker-state.mjs";
import { collectWorkerQueueCounts } from "./worker-queue-counts.mjs";
import { createRestartToolsGroup } from "./tool-groups/restart-tools-group.mjs";
import { createRepoLockToolsGroup } from "./tool-groups/repo-lock-tools-group.mjs";
import { createExecutionToolsGroup } from "./tool-groups/task-execution-tools-group.mjs";
import { createProjectWorkspaceToolsGroup } from "./tool-groups/project-workspace-tools-group.mjs";
import { createGoalToolsGroup } from "./tool-groups/goal-tools-group.mjs";
import { createBasicTaskToolsGroup } from "./tool-groups/basic-task-tools-group.mjs";
import { createSessionInventoryToolsGroup, completeCodexSessionInventoryTask } from "./tool-groups/session-inventory-tools-group.mjs";
import { createTaskCompletionToolsGroup } from "./tool-groups/task-completion-tools-group.mjs";
import { createChatGptRequestToolsGroup } from "./tool-groups/chatgpt-request-tools-group.mjs";
import { createBrowserToolsGroup } from "./tool-groups/browser-tools-group.mjs";
import { createBrowserInteractionToolsGroup } from "./tool-groups/browser-interaction-tools-group.mjs";
import { createRuntimeStatusToolsGroup } from "./tool-groups/runtime-status-tools-group.mjs";
import { createContextHealthToolsGroup } from "./tool-groups/context-health-tools-group.mjs";
import { createRepositoryToolsGroup } from "./tool-groups/repository-tools-group.mjs";
import { createWorkspaceReadToolsGroup } from "./tool-groups/workspace-read-tools-group.mjs";
import { createWorkspaceMutationToolsGroup } from "./tool-groups/workspace-mutation-tools-group.mjs";
import { createWorkspaceOperationsToolsGroup } from "./tool-groups/workspace-operations-tools-group.mjs";
import { createGitRemoteToolsGroup } from "./tool-groups/git-remote-tools-group.mjs";
import { createGithubSyncToolsGroup } from "./tool-groups/github-sync-tools-group.mjs";
import { createSystemDiagnosticsToolsGroup } from "./tool-groups/system-diagnostics-tools-group.mjs";
import { createGithubCommentsSyncToolsGroup } from "./tool-groups/github-comments-sync-tools-group.mjs";
import { applyOptionSourceOverrides, createServerContext } from "./server-context.mjs";
import { createTool } from "./tool-registry.mjs";
import { startCodexWorker as _startCodexWorker, runAssignedCodexTasks as _runAssignedCodexTasks, mapConcurrent as _mapConcurrent } from "./codex-worker.mjs";
import { createReconciler } from "./runtime-reconciler.mjs";
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
  const tools = createTools({ store, config, browser, github, bark, envLoadResult, sources, registry });

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
    summarizeToolResult(name, structuredContent) {
      if (!structuredContent || typeof structuredContent !== "object") return JSON.stringify(structuredContent);

      // Use compact card formatting for targeted tools
      switch (name) {
        case "runtime_status":
          return runtimeStatusCard(structuredContent);
        case "gptwork_doctor":
          return gptworkDoctorCard(structuredContent);
        case "get_task":
          return getTaskCard(structuredContent);
        case "create_encoded_goal":
          return createEncodedGoalCard(structuredContent);
        case "context_status":
        case "project_context_status":
          return contextStatusCard(structuredContent);
        case "github_status":
          return githubStatusCard(structuredContent);
        case "preview_codex_context":
          return previewCodexContextCard(structuredContent);
        case "shell_exec":
          return shellExecCard(structuredContent);
        case "git_remote_diff":
          return gitRemoteDiffCard(structuredContent);
        case "read_text_file":
          return readTextFileCard(structuredContent);
        case "list_dir":
          return listDirCard(structuredContent);
        case "get_goal_context":
          return goalContextCard(structuredContent);

      }

      // Fallback: built-in summary for tools without dedicated card formatters
      try {
        switch (name) {
          case "create_encoded_goal": {
            const g = structuredContent.goal;
            const lines = g ? [
              formatKeyValue('goal', g.id),
              formatKeyValue('title', (g.title || "").slice(0, 60)),
              formatKeyValue('status', g.status),
              formatKeyValue('assignee', g.assignee || '-'),
            ] : ['  Goal not found'];
            return formatToolCard('Goal', { lines });
          }
          case "runtime_status": {
            const s = structuredContent;
            const lines = [
              formatKeyValue('pid', s.pid),
              formatKeyValue('commit', s.running_commit ? s.running_commit.slice(0, 12) : '-'),
              formatKeyValue('worktree', s.worktree_dirty ? 'dirty' : 'clean'),
              '',
              formatKeyValue('worker', s.worker?.enabled ? 'enabled' : 'disabled'),
              formatKeyValue('queue', s.worker?.queue?.assigned ?? '?'),
            ];
            return formatToolCard('Runtime Status', { lines });
          }
          case "gptwork_doctor": {
            const d = structuredContent;
            const lines = [
              formatKeyValue('running commit', d.running_commit ? d.running_commit.slice(0, 12) : '-'),
              formatKeyValue('env', d.runtime_env_loaded ? 'loaded' : 'missing'),
              formatKeyValue('repo registry', d.repository_registry_count || 0),
              formatKeyValue('stale clones', d.stale_clone_count || 0),
              formatKeyValue('worktree', d.worktree_dirty ? 'dirty' : 'clean'),
            ];
            return formatToolCard('GPTWork Doctor', { lines });
          }
          case "search_files": {
            const sch = structuredContent;
            return "Search \"" + (sch.q || "") + "\" in \"" + (sch.path || ".") + "\": " + (sch.count || 0) + " result(s)" + (sch.backend ? " [" + sch.backend + "]" : "") + (sch.elapsed_ms != null ? " " + sch.elapsed_ms + "ms" : "");
          }
          case "list_tasks": {
            const tasks = structuredContent.tasks || [];
            return tasks.length + " task(s)";
          }
          case "list_goals": {
            const goals = structuredContent.goals || [];
            return goals.length + " goal(s)";
          }

          case "worker_status": {
            const w = structuredContent;
            const lines = [
              formatKeyValue('worker', w.enabled ? 'enabled' : 'disabled'),
              formatKeyValue('running', w.running ? 'yes' : 'no'),
              formatKeyValue('interval', w.interval_ms ? w.interval_ms + 'ms' : '?'),
              formatKeyValue('queue assigned', w.queue?.assigned ?? w.queues?.assigned ?? 0),
              formatKeyValue('queue running', w.queue?.running ?? w.queues?.running ?? 0),
            ];
            const warnings = [];
            if (w.last_error) warnings.push('Last error: ' + w.last_error.slice(0, 120));
            if (w.last_tick_finished_at) lines.push(formatKeyValue('last tick', w.last_tick_finished_at));
            return formatToolCard('Worker Status', { lines, warnings });
          }
          case "health_check": {
            const h = structuredContent;
            const lines = [
              formatKeyValue('service', h.service || 'gptwork-mcp'),
              formatKeyValue('time', h.time || new Date().toISOString()),
            ];
            return formatToolCard('Health', { lines });
          }
          case "sync_to_github": {
            const sy = structuredContent;
            return "GitHub sync: " + (sy.synced_tasks ?? "?") + " tasks, " + (sy.synced_requests ?? "?") + " requests";
          }
          default:
            return JSON.stringify(structuredContent);
        }
      } catch {
        return JSON.stringify(structuredContent);
      }
    },

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

    async listen({ host = "127.0.0.1", port = 8787 } = {}) {
      const httpServer = http.createServer((req, res) => handleHttp(req, res, this));
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(port, host, () => {
              httpServer.removeListener("error", reject);
              resolve();
            });
          });
          return httpServer;
        } catch (err) {
          if (err.code !== "EADDRINUSE") throw err;
          try { execSync("lsof -ti :" + port + " 2>/dev/null | xargs kill -9 2>/dev/null"); } catch {}
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      throw new Error("Could not listen on port " + port + " after 5 retries");
    }
  };
}

export function startCodexWorker(server, opts = {}) {
  return _startCodexWorker(server, { ...opts, workerState });
}
function createTools({ store, config, browser, github, bark, envLoadResult, sources, registry }) {
  const tool = createTool;

  const tools = {
    ...createSystemDiagnosticsToolsGroup({ tool, schema, store, bark, workerState, collectWorkerQueueCounts }),
    ...createProjectWorkspaceToolsGroup({ tool, schema, config, store, createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection }),
    ...createGoalToolsGroup({ tool, schema, config, store, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }),

    ...createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github }),
    ...createExecutionToolsGroup({ tool, schema, config, store, github, registry,
      normalizeAssignedTaskMode,
      ensureTaskGoal,
      notifyCreatedTaskIfNeeded,
      runAssignedCodexTasks: (store, config, github, args, context) => _runAssignedCodexTasks(store, config, github, args, context, { processGeneralTask }),
    }),
    ...createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask }),
    ...createTaskCompletionToolsGroup({ tool, schema, config, store, github }),
    ...createRestartToolsGroup({ tool, schema, config, store }),

    ...createChatGptRequestToolsGroup({ tool, schema, config, store, github }),

    ...createWorkspaceReadToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceMutationToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceOperationsToolsGroup({ tool, schema, store, config }),

    ...createGithubSyncToolsGroup({ tool, schema, store, github }),
    ...createRepositoryToolsGroup({ tool, schema, registry }),
    ...createContextHealthToolsGroup({ tool, schema, config, registry, store }),

    ...createGithubCommentsSyncToolsGroup({ tool, schema, store, github }),

    ...createBrowserToolsGroup({ tool, schema, browser }),
    ...createBrowserInteractionToolsGroup({ tool, schema, browser }),
    ...createGitRemoteToolsGroup({ tool, schema, registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote }),
    ...createRuntimeStatusToolsGroup({ tool, schema, config, sources, envLoadResult, bark, github, registry, store, workerState, PROCESS_STARTED_AT, collectWorkerQueueCounts }),
    ...createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary }),
  };
  return tools;
}
