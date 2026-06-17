import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { exec, execSync, spawn } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { StateStore } from "./state-store.mjs";
import { ensureParent, resolveWorkspacePath } from "./path-utils.mjs";
import { createBrowserRegistry } from "./browser-http.mjs";
import { buildSshExecCommand, runSshExec, sshListDir, sshReadTextFile, sshDownloadBase64, sshWriteTextFile, sshUploadBase64, sshMkdir, sshDelete, sshMove, sshCopy, sshSha256, sshStat, sshSearchFiles } from "./ssh-adapter.mjs";
import { createGithubSync } from "./github-adapter.mjs";
import { RepoRegistry, getRepoStatus, parseGitHubUrl, isTempClone, detectStaleTempClones } from "./repo-registry.mjs";
import { createBarkNotifier, classifyNotification, classifyCreatedNotification, formatNotification, formatCreatedNotification, formatManualTestNotification } from "./bark-notifier.mjs";
import { parseCodexResult, buildTaskResult, parseCodexResultWithFallback, parseResultJson } from "./codex-result-parser.mjs";
import { buildCodexContext, formatSize, loadProjectEnv, loadProjectMd } from "./codex-context-builder.mjs";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { buildRuntimeConfig } from "./runtime-config.mjs";
import { handleResolveRepo, handleFetch, handleStatus, handleListFiles, handleReadFile, handleChangedFiles, handleDiff, handleShowCommit, handleCompareLocal } from "./git-remote-tools.mjs";
import { initRun, fireHeartbeat, writeRunLogs, updateRunHeartbeat, getLatestRun } from "./codex-run-metadata.mjs";
import { writePendingRestartMarker, loadRestartMarker, scanPendingRestartMarkers, scanPendingRestartMarkersSync, updateRestartMarkerStatus, verifyRestartMarker, scheduleServiceRestart, getPendingRestartsDir } from "./safe-restart.mjs";
import { acquireRepoLock, releaseRepoLock, reconcileRepoLocks, releaseLockForTask, getRepoLockSummary, listRepoLocks, safeRepoId, getLockFilePath } from "./repo-lock.mjs";

let barkNotifier = null;


const PROCESS_STARTED_AT = new Date();

/** Determine whether runtime env loaded Bark config vars. */
function determineBarkConfigSource(envLoadResultKeys) {
  const barkVars = ["GPTWORK_BARK_ENABLED", "GPTWORK_BARK_URL", "GPTWORK_BARK_KEY", "GPTWORK_BARK_GROUP", "GPTWORK_BARK_SOUND", "GPTWORK_BARK_LEVEL"];
  const fromEnv = barkVars.filter(v => envLoadResultKeys.includes(v));
  if (fromEnv.length > 0) return "workspace-runtime-env";
  const anySet = barkVars.some(v => process.env[v] !== undefined);
  return anySet ? "process.env" : "disabled";
}
const MCP_PROTOCOL_VERSION = "2025-03-26";

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
  {
    const OPTIONS_SOURCE_MAP = [
      ['statePath', 'statePath'],
      ['defaultWorkspaceRoot', 'workspaceRoot'],
      ['requireAuth', 'requireAuth'],
      ['codexHome', 'codexHome'],
      ['codexExecArgs', 'codexExecArgs'],
      ['codexExecTimeout', 'codexExecTimeout'],
      ['codexStallThreshold', 'codexStallThreshold'],
      ['maxReadBytes', 'maxReadBytes'],
      ['maxShellOutputBytes', 'maxShellOutputBytes'],
      ['barkEnabled', 'barkEnabled'],
      ['barkUrl', 'barkUrl'],
      ['barkKey', 'barkKey'],
      ['barkGroup', 'barkGroup'],
      ['barkSound', 'barkSound'],
      ['barkLevel', 'barkLevel'],
      ['barkIconUrl', 'barkIconUrl'],
      ['barkClickUrl', 'barkClickUrl'],
      ['defaultRepo', 'defaultRepo'],
      ['defaultBranch', 'defaultBranch'],
      ['defaultRepoPath', 'defaultRepoPath'],
      ['defaultRemote', 'defaultRemote'],
    ];
    for (const [optKey, sourceKey] of OPTIONS_SOURCE_MAP) {
      if (options[optKey] !== undefined) {
        sources[sourceKey] = 'options';
      }
    }
  }
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
  const bark = createBarkNotifier(barkOptions, barkConfigSource); barkNotifier = bark;
  // Create the repo registry
  const registry = new RepoRegistry({
    registryPath: join(config.defaultWorkspaceRoot, ".gptwork/repos.json"),
    workspaceRoot: config.defaultWorkspaceRoot,
  });
  await registry.load().catch(function() {});
  const tools = createTools({ store, config, browser, github, bark, envLoadResult, sources, registry });

  return {
    async runAssignedCodexTasks(args = {}, context = defaultTokenContext("worker")) {
      return runAssignedCodexTasks(store, config, github, args, context);
    },

    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      try {
        const state = await store.load();
        const now = Date.now();
        const _lp = process.env.GPTWORK_LOG_PATH;
        const stallThreshold = (config.codexStallThreshold || 600) * 1000; // ms

        // Phase A: Simple startup reconciliation
        const reconciled = [];
        for (const task of (state.tasks || [])) {
          if (task.status !== "running") continue;
          try {
            const marker = await loadRestartMarker(config.defaultWorkspaceRoot, task.id);
            if (marker && (marker.status === "pending" || marker.status === "scheduled" || marker.status === "restarted")) continue;
          } catch {}
          let shouldMark = false;
          let message = "";
          const run = await getLatestRun(config.defaultWorkspaceRoot, task.id);
          if (!run) {
            shouldMark = true;
            message = "Startup reconciliation: task was in running state with no run metadata or restart marker. Marked as waiting_for_review/codex_stalled.";
          } else {
            const ageMs = now - new Date(run.last_heartbeat_at).getTime();
            let processAlive = false;
            if (run.codex_child_pid && typeof run.codex_child_pid === "number" && run.codex_child_pid > 0) {
              try { process.kill(run.codex_child_pid, 0); processAlive = true; } catch {}
            }
            if (!processAlive && ageMs > stallThreshold) {
              shouldMark = true;
              message = "Startup reconciliation: Codex process not found and heartbeat is stale. Marked as waiting_for_review/codex_stalled.";
            }
          }
          if (shouldMark) {
            const prevStatus = task.status;
            task.status = "waiting_for_review";
            task.result = task.result || {};
            task.result.kind = "codex_stalled";
            task.result.reconciliation_message = message;
            task.result.reconciled_at = new Date().toISOString();
            task.logs = task.logs || [];
            task.logs.push({ time: new Date().toISOString(), message });
            reconciled.push({ task_id: task.id, previous_status: prevStatus, new_status: "waiting_for_review", message });
            if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} -> waiting_for_review (${message})
`);
          }
        }
        if (reconciled.length > 0) {
          await store.save();
          if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${reconciled.length} stale tasks marked waiting_for_review
`);
        }

        // Phase B: Reconcile stale repo locks
        try {
          const _lockRec = await reconcileRepoLocks(config.defaultWorkspaceRoot);
          if (_lockRec.reconciled > 0) {
            if (_lp) appendFileSync(_lp, `[gptwork-worker] repo lock reconciliation: ${_lockRec.reconciled} stale lock(s) marked stale
`);
            for (const _d of _lockRec.details) {
              if (_lp) appendFileSync(_lp, `[gptwork-worker]   lock ${_d.safe_repo_id} (task ${_d.task_id}): ${_d.reason}
`);
            }
          }
        } catch (_lockRecErr) {
          if (_lp) appendFileSync(_lp, `[gptwork-worker] repo lock reconciliation error: ${_lockRecErr.message}
`);
        }

        // Phase C: Scan pending restart markers and verify after service startup
        const restartVerifications = [];
        try {
          const markers = await scanPendingRestartMarkers(config.defaultWorkspaceRoot);
          for (const marker of markers) {
            if (marker.status === "scheduled" || marker.status === "restarted") {
              const { verified, diagnostics } = await verifyRestartMarker(marker, {
                defaultRepoPath: config.defaultRepoPath,
                defaultRemote: config.defaultRemote,
                defaultBranch: config.defaultBranch,
              });
              if (verified) {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "verified", {
                  verified_at: new Date().toISOString(),
                  running_commit: diagnostics.running_commit,
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  const goalId = taskObj.goal_id;
                  let resultJsonPath = null;
                  if (goalId) resultJsonPath = join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "result.json");
                  let resultData = null;
                  if (resultJsonPath) { try { resultData = await parseResultJson(resultJsonPath); } catch {} }
                  if (resultData && resultData.status === "completed") {
                    taskObj.status = "completed";
                    taskObj.result = taskObj.result || {};
                    taskObj.result.kind = "codex_executed";
                    taskObj.result.summary = resultData.summary || "Restart verified: deployment successful";
                    taskObj.result.restart_state = "verified";
                    taskObj.result.restart_verified_at = new Date().toISOString();
                    taskObj.result.commit = resultData.commit;
                    taskObj.result.remote_head = resultData.remote_head;
                    taskObj.logs = taskObj.logs || [];
                    taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Restart verified and task finalized via Phase C startup verification. Running commit: ${diagnostics.running_commit || "unknown"}` });
                    await notifyTerminalTaskIfNeeded(taskObj);
                    taskObj.updated_at = new Date().toISOString();
                    restartVerifications.push({ task_id: marker.task_id, status: "completed", verified: true });
                    // Release repo lock after restart verification
                    await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} completed after restart verification
`);
                  } else {
                    taskObj.result = taskObj.result || {};
                    taskObj.result.restart_state = "verified";
                    taskObj.result.restart_comment = "Restart marker verified but no result.json found";
                    taskObj.logs = taskObj.logs || [];
                    taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Restart marker verified via Phase C startup verification (no result.json)" });
                    taskObj.updated_at = new Date().toISOString();
                    restartVerifications.push({ task_id: marker.task_id, status: "marker_verified", verified: true });
                    // Release repo lock after restart verification
                    await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: marker ${marker.task_id} verified
`);
                  }
                }
              } else {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "failed", {
                  failed_at: new Date().toISOString(),
                  failure_reason: (diagnostics.failures || []).join("; ") || diagnostics.error || "unknown",
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.status = "waiting_for_review";
                  taskObj.result = taskObj.result || {};
                  taskObj.result.kind = "restart_failed";
                  taskObj.result.restart_state = "failed";
                  taskObj.result.restart_failure = diagnostics.failures || diagnostics.error || "verification failed";
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Restart verification failed: " + (((diagnostics.failures || []).join("; ")) || diagnostics.error || "unknown") });
                  await notifyTerminalTaskIfNeeded(taskObj);
                  taskObj.updated_at = new Date().toISOString();
                    // Release repo lock after restart verification (even on failure)
                    await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                  restartVerifications.push({ task_id: marker.task_id, status: "failed", verified: false });
                  if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} restart verification failed
`);
                }
              }
            }
          }
          if (markers.length > 0 || restartVerifications.length > 0) await store.save();
        } catch (phaseErr) {
          if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C error: ${phaseErr.message}
`);
        }
        await store.save();
        return { ok: true, reconciled: reconciled.length, details: reconciled, restart_verifications: restartVerifications };
      } catch (error) {
        const _lp = process.env.GPTWORK_LOG_PATH;
        if (_lp) appendFileSync(_lp, `[gptwork-worker] reconciliation error: ${error.message}
`);
        return { ok: false, error: error.message };
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
          return jsonResult(message.id, {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
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

export function startCodexWorker(server, {
  intervalMs = Number(process.env.GPTWORK_CODEX_WORKER_INTERVAL_MS || 5000),
  limit = Number(process.env.GPTWORK_CODEX_WORKER_LIMIT || 10),
  concurrency = Number(process.env.GPTWORK_CODEX_WORKER_CONCURRENCY || 4)
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const wr = await server.runAssignedCodexTasks({ limit, concurrency });
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) {
        const done = wr.tasks.filter(t => t.status === "completed").length;
        const skip = wr.tasks.filter(t => t.skipped).length;
        appendFileSync(_lp, `[gptwork-worker] tick inspected=${wr.inspected} completed=${done} skipped=${skip}\n`);
      }}
    } catch (error) {
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] ${error.message}\n`); }
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  // Run startup reconciliation once before the first tick
  (async () => {
    try {
      const result = await server.reconcileStaleTasks();
      if (result.ok && result.reconciled > 0) {
        const _lp = process.env.GPTWORK_LOG_PATH;
        if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciled ${result.reconciled} stale tasks
`);
      }
    } catch (e) {
      // Non-fatal: reconciliation errors should not prevent normal operation
    }
    // Start regular tick cycle
    if (!stopped) tick();
  })();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

function createTools({ store, config, browser, github, bark, envLoadResult, sources, registry }) {
  const tool = (description, inputSchema, handler) => ({ description, inputSchema, handler });

  /** Try to find the repo root directory by walking up from cwd looking for .git. */
  function resolveRepoDir() {
    const start = process.cwd();
    let dir = start;
    for (let i = 0; i < 6; i++) {
      try {
        if (statSync(join(dir, ".git")).isDirectory()) return dir;
      } catch (e) {}
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
 }

  /** Shared context status query used by contextStatusHandler and contextPrepareHandler. */
  async function queryContextStatus(task_id, context) {
    requireScope(context, "task:read");

    // 1. Resolve canonical repo info
    const workspaceRoot = config.defaultWorkspaceRoot;
    let canonicalRepoPath = config.defaultRepoPath || null;
    let repoRecord = null;
    let repoRegistered = false;

    if (registry) {
      const defaultRepo = registry.getDefaultRepo() || null;
      if (defaultRepo && typeof defaultRepo === "object") {
        repoRecord = defaultRepo;
      }
      if (!repoRecord && config.defaultRepoPath) {
        repoRecord = registry.findByPath(config.defaultRepoPath) || null;
      }
      if (repoRecord) repoRegistered = true;
      if (repoRecord && repoRecord.canonical_path) {
        canonicalRepoPath = repoRecord.canonical_path;
      }
    }

    // 2. Project context files (safe, no secret values)
    const projectEnv = await loadProjectEnv(canonicalRepoPath);
    const projectMd = await loadProjectMd(canonicalRepoPath);

    // Count secret-like key names (pattern match only, no values exposed)
    const secretPatterns = ["SECRET", "KEY", "TOKEN", "PASSWORD", "PASS", "PRIVATE", "CREDENTIAL", "API_KEY"];
    const secretLikeKeys = projectEnv.keys.filter(function(k) {
      const upper = k.toUpperCase();
      return secretPatterns.some(function(p) { return upper.includes(p); });
    });

    // 3. Context source precedence summary
    const contextSourcePrecedence = [
      { rank: 1, source: "task.description / task fields", description: "Direct task metadata from the task object" },
      { rank: 2, source: "linked goal prompt/context files", description: "goal.md and context.json from the linked goal workspace files" },
      { rank: 3, source: "project.md / project.env", description: "Project-level context files under canonical repo .gptwork/" },
      { rank: 4, source: "durable goal transcript/memories", description: "Transcript and memory items from goal conversation history" },
      { rank: 5, source: "runtime defaults / repo registry", description: "Workspace root, state path, exec timeout, registered repo metadata" },
    ];

    // 4. Base warnings
    const warnings = [];
    if (!canonicalRepoPath) {
      warnings.push({ severity: "warning", code: "missing_canonical_repo", message: "No canonical repo path configured. Context will lack repo-specific project files." });
    }
    if (!projectMd.ok) {
      warnings.push({ severity: "warning", code: "missing_project_md", message: "No project.md found under canonical repo. Project-level Markdown context will not be loaded." });
    }
    if (projectEnv.ok && projectEnv.keys.length === 0) {
      warnings.push({ severity: "warning", code: "empty_project_env", message: "project.env exists but appears empty (no KEY=VALUE pairs found)." });
    }

    // Dirty worktree check
    if (canonicalRepoPath) {
      try {
        if (existsSync(join(canonicalRepoPath, ".git"))) {
          const dirtyOut = execSync("git status --short 2>/dev/null", { cwd: canonicalRepoPath, timeout: 5000, encoding: "utf8" }).trim();
          if (dirtyOut.length > 0) {
            warnings.push({ severity: "warning", code: "dirty_worktree", message: "Canonical repo has uncommitted changes. Context will reflect dirty state." });
          }
        }
      } catch (e) {}
    }

    // Stale clone check
    try {
      if (workspaceRoot) {
        const dirEntries = readdirSync(workspaceRoot, { withFileTypes: true });
        const staleClones = dirEntries.filter(function(e) { return e.isDirectory() && e.name.startsWith(".tmp-"); });
        if (staleClones.length > 0) {
          warnings.push({ severity: "info", code: "stale_clones", message: staleClones.length + " stale temporary clone(s) detected." });
        }
      }
    } catch (e) {}

    // 5. Task-specific diagnostics (optional)
    let taskInfo = null;
    if (task_id) {
      try {
        const task = await findTask(store, task_id);
        const state = await store.load();
        const goal = task.goal_id ? state.goals.find(function(g) { return g.id === task.goal_id; }) : null;

        let previewAvailable = false;
        let approximateContextBytes = 0;
        let transcriptCount = null;
        let memoryCount = 0;

        if (goal) {
          const workspace = state.workspaces.find(function(w) { return w.id === task.workspace_id; });
          if (workspace) {
            const transcriptPath = join(workspace.root, ".gptwork/goals/" + goal.id + "/transcript.md");
            try {
              const s = statSync(transcriptPath);
              if (s.isFile()) {
                previewAvailable = true;
                approximateContextBytes += s.size;
                transcriptCount = 0;
              }
            } catch (e) {}

            // Count memories from context.json
            try {
              const cjPath = join(workspace.root, ".gptwork/goals/" + goal.id + "/context.json");
              const cjRaw = readFileSync(cjPath, "utf8");
              const cj = JSON.parse(cjRaw);
              memoryCount = Array.isArray(cj.memories) ? cj.memories.length : 0;
            } catch (e) {}

            // Estimate context size from task + goal + project files
            approximateContextBytes += (task.description || "").length;
            approximateContextBytes += (goal.goal_prompt || "").length;
            if (projectMd.ok) approximateContextBytes += projectMd.size;
          }

          if (!task.goal_id) {
            warnings.push({ severity: "warning", code: "task_no_linked_goal", message: "Task has no linked goal. Codex will not have a goal.md to follow." });
          }
        }

        if (approximateContextBytes > 100 * 1024) {
          warnings.push({ severity: "warning", code: "huge_context", message: "Approximate context size is " + formatSize(approximateContextBytes) + ". Large contexts may degrade Codex performance." });
        }

        taskInfo = {
          task_id: task.id,
          task_status: task.status,
          linked_goal_id: task.goal_id || null,
          preview_available: previewAvailable,
          transcript_count: transcriptCount,
          memory_count: memoryCount,
          approximate_context_bytes: approximateContextBytes,
        };
      } catch (e) {
        // task not found or error resolving — still return base diagnostics
      }
    }

    const result = {
      canonical_repo_path: canonicalRepoPath,
      repo_registered: repoRegistered,
      workspace_root: workspaceRoot,
      project_context: {
        project_md_exists: projectMd.ok,
        project_md_path: projectMd.path,
        project_md_size_bytes: projectMd.size,
        project_env_exists: projectEnv.ok,
        project_env_path: projectEnv.path,
        project_env_key_count: projectEnv.keys.length,
        project_env_secret_like_key_count: secretLikeKeys.length,
        redacted_key_names: secretLikeKeys.length > 0 ? secretLikeKeys : [],
      },
      context_source_precedence: contextSourcePrecedence,
      warnings: warnings,
    };
    if (taskInfo) result.task = taskInfo;
    return result;
  };

  /** Wrapper for project_context_status and context_status alias handlers. */
  const contextStatusHandler = async ({ task_id }, context) => queryContextStatus(task_id, context);

  /**
   * Context prepare handler: safe auto-fix for context hygiene.
   * Supports check (dry-run) and fix_safe modes.
   */
  const contextPrepareHandler = async ({ task_id, mode = "check" }, context) => {
    requireScope(context, "task:read");

    // Validate mode
    if (!["check", "fix_safe"].includes(mode)) {
      throw new Error(`Invalid mode "${mode}". Supported modes: check, fix_safe`);
    }

    // Resolve canonical repo path
    let canonicalRepoPath = config.defaultRepoPath || null;
    let repoRecord = null;
    if (registry) {
      const defaultRepo = registry.getDefaultRepo() || null;
      if (defaultRepo && typeof defaultRepo === "object") repoRecord = defaultRepo;
      if (!repoRecord && config.defaultRepoPath) {
        repoRecord = registry.findByPath(config.defaultRepoPath) || null;
      }
      if (repoRecord && repoRecord.canonical_path) {
        canonicalRepoPath = repoRecord.canonical_path;
      }
    }

    // Get context status BEFORE any changes
    const before = await queryContextStatus(task_id, context);

    // Check for dirty repo - refuse to run fix_safe if dirty
    const isFix = mode === "fix_safe";
    if (isFix && canonicalRepoPath) {
      try {
        if (existsSync(join(canonicalRepoPath, ".git"))) {
          const dirtyOut = execSync("git status --short 2>/dev/null", { cwd: canonicalRepoPath, timeout: 5000, encoding: "utf8" }).trim();
          if (dirtyOut.length > 0) {
            return {
              mode,
              changed: false,
              error: "refusing_to_fix_dirty_worktree",
              error_detail: "Canonical repo has uncommitted changes. Commit or stash before running fix_safe to avoid racing with another Codex run.",
              actions_planned: [],
              actions_applied: [],
              skipped_actions: [{ action: "all_fixes", reason: "dirty worktree - refusing to race" }],
              warnings: [...before.warnings, { severity: "error", code: "dirty_worktree_refused", message: "Cannot run fix_safe on dirty worktree." }],
              project_context_status_before: before,
              no_secrets_exposed: true,
            };
          }
        }
      } catch (e) {}
    }

    // Check if repo paths exist
    const gptworkDir = canonicalRepoPath ? join(canonicalRepoPath, ".gptwork") : null;
    const projectMdPath = gptworkDir ? join(gptworkDir, "project.md") : null;
    const projectEnvPath = gptworkDir ? join(gptworkDir, "project.env") : null;

    const gptworkDirExists = gptworkDir ? existsSync(gptworkDir) : false;
    const projectMdExists = projectMdPath ? existsSync(projectMdPath) : false;
    const projectEnvExists = projectEnvPath ? existsSync(projectEnvPath) : false;
    let projectEnvEmpty = false;
    if (projectEnvExists) {
      try {
        const content = readFileSync(projectEnvPath, "utf8").trim();
        projectEnvEmpty = content.length === 0;
      } catch (e) { projectEnvEmpty = true; }
    }

    const actionsPlanned = [];
    const actionsApplied = [];
    const skippedActions = [];
    const filesCreated = [];
    const filesModified = [];
    const prepareWarnings = [];
    let changed = false;

    // Fix 1: Create .gptwork/ directory if missing
    if (!gptworkDirExists && canonicalRepoPath) {
      actionsPlanned.push({
        action: "create_gptwork_dir",
        target: gptworkDir,
        description: "Create .gptwork/ directory under canonical repo.",
        safe: true,
      });
      if (isFix) {
        await mkdir(gptworkDir, { recursive: true });
        actionsApplied.push({ action: "create_gptwork_dir", target: gptworkDir, description: "Created .gptwork/ directory." });
        filesCreated.push(gptworkDir);
        changed = true;
      }
    } else if (!canonicalRepoPath) {
      skippedActions.push({ action: "create_gptwork_dir", reason: "No canonical repo path configured." });
      prepareWarnings.push({ severity: "warning", code: "no_canonical_repo", message: "Cannot prepare context files without a canonical repo path." });
    }

    // Fix 2: Create project.md template if missing
    const projectMdTemplate = [
      "# " + (canonicalRepoPath ? basename(canonicalRepoPath) : "Project Name"),
      "",
      "## Purpose",
      "<!-- TODO: Describe the project purpose, domain, and scope -->",
      "",
      "## Development",
      "<!-- TODO: Document test commands, build steps, linting -->",
      "Test commands:",
      "",
      "## Deployment",
      "<!-- TODO: Document deploy procedures, hosts, env requirements -->",
      "",
      "## Notes",
      "> **Do not store secrets here.**",
      "> Project-level context files are loaded by Codex but must not contain sensitive credentials.",
      "> Use .gptwork/project.env for non-secret environment variables only.",
      "",
    ].join("\n");

    if (!projectMdExists && projectMdPath) {
      actionsPlanned.push({
        action: "create_project_md",
        target: projectMdPath,
        description: "Create .gptwork/project.md from minimal template.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectMdPath, projectMdTemplate, "utf8");
        actionsApplied.push({ action: "create_project_md", target: projectMdPath, description: "Created .gptwork/project.md from minimal template." });
        filesCreated.push(projectMdPath);
        changed = true;
      }
    } else if (projectMdExists) {
      skippedActions.push({ action: "create_project_md", reason: "project.md already exists. fix_safe never overwrites existing content." });
    }

    // Fix 3: Create project.env template if missing
    const projectEnvTemplate = [
      "# Project environment variables (non-secret)",
      "# This file is loaded by Codex context builder on each execution.",
      "# Key=Value format. Lines starting with # are comments.",
      "",
      "# Database",
      "# DB_HOST=localhost",
      "# DB_PORT=5432",
      "",
      "# Application",
      "# APP_ENV=development",
      "# LOG_LEVEL=debug",
      "",
      "# Notes:",
      "# - Do NOT store real secrets here. Use runtime.env for secrets (requires restart).",
      "# - project.env is hot-loaded on every Codex context build, not runtime.env.",
      "# - project.env does NOT mutate process.env - it is only used for Codex context.",
      "",
    ].join("\n");

    if (!projectEnvExists && projectEnvPath) {
      actionsPlanned.push({
        action: "create_project_env",
        target: projectEnvPath,
        description: "Create .gptwork/project.env from minimal non-secret template.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectEnvPath, projectEnvTemplate, "utf8");
        actionsApplied.push({ action: "create_project_env", target: projectEnvPath, description: "Created .gptwork/project.env from minimal non-secret template." });
        filesCreated.push(projectEnvPath);
        changed = true;
      }
    } else if (projectEnvExists && !projectEnvEmpty) {
      skippedActions.push({ action: "create_project_env", reason: "project.env already exists with content. fix_safe never overwrites existing content." });
    }

    // Fix 4: Empty project.env gets template comments
    if (projectEnvExists && projectEnvEmpty && projectEnvPath) {
      actionsPlanned.push({
        action: "populate_empty_project_env",
        target: projectEnvPath,
        description: "project.env is empty. Add non-secret template comments.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectEnvPath, projectEnvTemplate, "utf8");
        actionsApplied.push({ action: "populate_empty_project_env", target: projectEnvPath, description: "Added non-secret template comments to empty project.env." });
        filesModified.push(projectEnvPath);
        changed = true;
      }
    }

    // Fix 5: Task without linked goal - warning only, no write
    if (task_id) {
      const taskHasGoal = before.task && before.task.linked_goal_id;
      if (!taskHasGoal) {
        actionsPlanned.push({
          action: "suggest_create_goal_for_task",
          target: task_id,
          description: "Task has no linked goal. Suggested flow: create_goal / create_task to link a goal.",
          safe: true,
        });
        prepareWarnings.push({
          severity: "info",
          code: "task_no_linked_goal",
          message: "Task has no linked goal. Use create_goal or assign a goal via create_task.",
          suggested_flow: ["create_goal(user_request, goal_prompt, assign_to_codex=true)", "create_task(..., description) with encoded goal"],
        });
      }
    }

    // Build output
    const output = {
      mode,
      changed,
      actions_planned: actionsPlanned,
      actions_applied: actionsApplied,
      skipped_actions: skippedActions,
      warnings: prepareWarnings,
      project_context_status_before: before,
      files_created: filesCreated,
      files_modified: filesModified,
      no_secrets_exposed: true,
    };

    // Add "after" snapshot when changes were made
    if (isFix) {
      const after = await queryContextStatus(task_id, context);
      output.project_context_status_after = after;
    }

    return output;
  };

  const tools = {
    health_check: tool("Check whether the GPTWork MCP server is running.", schema({}), async () => ({ ok: true, service: "gptwork-mcp", time: new Date().toISOString() })),
    get_current_user: tool("Return the current token-bound user context.", schema({}), async (_args, context) => ({
      user: { id: context.user_id, name: context.user_name },
      team_id: context.team_id,
      project_ids: context.project_ids,
      workspace_ids: context.workspace_ids,
      scopes: context.scopes
    })),
    list_projects: tool("List your available projects. Each project has workspaces (hosted or SSH) and tasks. Start here to find which project to work on.", schema({}), async (_args, context) => {
      const state = await store.load();
      return { projects: state.projects.filter((project) => canAccessProject(context, project.id)) };
    }),
    get_project: tool("Return project detail.", schema({ project_id: "string" }, ["project_id"]), async ({ project_id = "default" }, context) => {
      const state = await store.load();
      requireProjectAccess(context, project_id);
      return { project: findProject(state, project_id) };
    }),
    list_workspaces: tool("List project workspaces.", schema({ project_id: "string" }), async ({ project_id = "default" }, context) => {
      const state = await store.load();
      requireProjectAccess(context, project_id);
      return {
        project_id,
        workspaces: state.workspaces.filter((workspace) => workspace.project_id === project_id && canAccessWorkspace(context, workspace.id))
      };
    }),
    get_workspace_info: tool("Return workspace configuration and capacity summary.", schema({ workspace_id: "string" }), async (args, context) => {
      const workspace = await selectWorkspace(store, args.workspace_id, context);
      if (workspace.type === "hosted") await mkdir(workspace.root, { recursive: true });
      return { workspace, limits: limits(config) };
    }),
    set_active_workspace: tool("Return the selected workspace for caller-side state.", schema({ workspace_id: "string" }, ["workspace_id"]), async ({ workspace_id }, context) => ({ active_workspace: await selectWorkspace(store, workspace_id, context) })),
    create_workspace: tool("Create a hosted or SSH workspace for a project. SSH workspaces use key authentication first; pass identity_file to pin a key. Hosts outside 10.0.0.0/8 use the default SOCKS proxy 10.0.1.105:20177 unless socks_proxy is provided.", schema({ project_id: "string", id: "string", name: "string", type: "string", root: "string", host: "string", user: "string", port: "integer", identity_file: "string", socks_proxy: "string", default: "boolean" }, ["project_id", "name", "type", "root"]), async (args, context) => createWorkspace(store, config, args, context)),
    update_workspace: tool("Update workspace metadata or SSH connection settings, including identity_file and socks_proxy.", schema({ workspace_id: "string", name: "string", root: "string", host: "string", user: "string", port: "integer", identity_file: "string", socks_proxy: "string", default: "boolean" }, ["workspace_id"]), async (args, context) => updateWorkspace(store, args, context)),
    delete_workspace: tool("移除工作区注册信息。不影响远程文件。", schema({ workspace_id: "string" }, ["workspace_id"]), async (args, context) => deleteWorkspace(store, args, context)),
    test_workspace_connection: tool("Test hosted or SSH workspace connectivity.", schema({ workspace_id: "string", dry_run: "boolean" }, ["workspace_id"]), async (args, context) => testWorkspaceConnection(store, config, args, context)),
    list_recent_activity: tool("List recent project activity.", schema({ limit: "integer" }), async ({ limit = 50 }) => {
      const state = await store.load();
      return { activities: state.activities.slice(-limit).reverse() };
    }),

    create_goal: tool("Create a shared goal from a ChatGPT-written goal prompt. Use this when ChatGPT turns the user's request into a Codex-executable goal. Stores the raw request, goal prompt, conversation messages, durable memories, workspace-visible context files, and optionally creates an assigned Codex task linked to the same context.", schema({ user_request: "string", goal_prompt: "string", context_summary: "string", project_id: "string", workspace_id: "string", mode: "string", assign_to_codex: "boolean", title: "string", messages: "array", memories: "array", payload: "object", payload_base64: "string", preview_text: "string", bundles: "array" }, ["user_request", "goal_prompt"]), async (args, context) => createGoal(store, config, args, context)),
    create_encoded_goal: tool("Create a shared Codex goal from a GPTChat preview plus base64-encoded JSON payload. The server decodes the payload, stores readable goal/context/transcript files, assigns Codex when requested, and can wait briefly for execution status with wait_ms.", schema({ preview_text: "string", payload_base64: "string", assign_to_codex: "boolean", wait_ms: "integer" }, ["preview_text", "payload_base64"]), async (args, context) => createEncodedGoal(store, config, args, context)),
    list_goals: tool("List shared GPTWork goals for ChatGPT and Codex. Codex should use this to discover assigned or open goal prompts before starting work.", schema({ status: "string", assignee: "string", workspace_id: "string", limit: "integer" }), async (args, context) => listGoals(store, args, context)),
    get_goal_context: tool("Return the full shared goal context: goal prompt, raw user request, conversation messages, durable memories, linked Codex task, and workspace-visible context files. Codex should call this before acting on a goal or linked task.", schema({ goal_id: "string", task_id: "string" }, []), async (args, context) => getGoalContext(store, config, args, context)),
    append_goal_message: tool("Append a ChatGPT, user, or Codex message to a shared goal conversation and optionally store a memory item for future Codex context. Also updates the workspace transcript/context files.", schema({ goal_id: "string", task_id: "string", role: "string", content: "string", memory_key: "string", memory_value: "string" }, ["content"]), async (args, context) => appendGoalMessage(store, config, args, context)),

    create_task: tool("Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.", schema({ title: "string", description: "string", assignee: "string", workspace_id: "string", mode: "string" }, ["title"]), async (args, context) => {
      const result = await createTask(store, config, args, context);
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    list_tasks: tool("List project tasks, optionally filtered. Check what Codex is working on and what tasks are waiting or completed.", schema({ status: "string", assignee: "string", limit: "integer" }), async ({ status, assignee, limit = 50 }) => {
      const state = await store.load();
      await normalizeLegacyModes(store, state);
      let tasks = state.tasks;
      if (status) tasks = tasks.filter((task) => task.status === status);
      if (assignee) tasks = tasks.filter((task) => task.assignee === assignee);
      return { tasks: tasks.slice(-limit).reverse() };
    }),
    get_task: tool("Return a task.", schema({ task_id: "string" }, ["task_id"]), async ({ task_id }) => ({ task: await findTask(store, task_id) })),
    update_task_status: tool("Update a task status. Syncs to GitHub if configured.", schema({ task_id: "string", status: "string" }, ["task_id", "status"]), async ({ task_id, status }) => {
      const result = await updateTask(store, task_id, (task) => { task.status = status; });
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    append_task_log: tool("Append a task log entry.", schema({ task_id: "string", message: "string" }, ["task_id", "message"]), async ({ task_id, message }) => updateTask(store, task_id, (task) => { task.logs.push({ time: new Date().toISOString(), message }); })),
    attach_task_artifact: tool("Attach a task artifact reference.", schema({ task_id: "string", path: "string", label: "string" }, ["task_id", "path"]), async ({ task_id, path, label }) => updateTask(store, task_id, (task) => { task.artifacts.push({ path, label: label || basename(path), time: new Date().toISOString() }); })),
    assign_task_to_codex: tool("Assign a task to Codex for execution. Ordinary tasks run in builder mode so Codex may edit files and perform implementation or deployment steps according to the task. The server ignores readonly for ordinary tasks; only the dedicated safe Codex session inventory task can remain readonly. Pass mode=deploy for Docker/service deployment or mode=admin for privileged maintenance.", schema({ task_id: "string", mode: "string" }, ["task_id"]), async ({ task_id, mode }, context) => {
      const result = await updateTask(store, task_id, (task) => {
        task.assignee = "codex";
        task.status = "assigned";
        task.mode = normalizeAssignedTaskMode(task, mode);
      });
      const linked = await ensureTaskGoal(store, config, result.task.id, context, { assign_to_codex: true });
      // Send created notification for newly assigned Codex task (after ensureTaskGoal handles goal linking)
      notifyCreatedTaskIfNeeded(result.task);
      github.syncTask(result.task).catch(() => {});
      return linked;
    }),
    list_codex_sessions_metadata: tool("Use this when the user asks to list /home/a9017 Codex sessions. Lists only files under the approved .codex/sessions directory. Metadata only: relative path, size, and modified time. Does not read session contents.", schema({ year: "string", month: "string", day: "string", limit: "integer" }), async (args, context) => listCodexSessionsMetadata(config, args, context)),
    create_codex_session_inventory_task: tool("Use this instead of create_task plus assign_task_to_codex when the user asks Codex to list Codex sessions. Creates a safe readonly task, streams progress, immediately runs the approved built-in handler, and returns the completed task with metadata-only results. It explicitly forbids transcript contents, tokens, configs, cookies, cache files, memories, or shell snapshots.", schema({ limit: "integer" }), async (args, context) => {
      const result = await createCodexSessionInventoryTask(store, config, args, context);
      github.syncTask(result.task).catch(() => {});
      emitTaskProgress(context, result.task, "started", "Safe Codex session metadata inventory started.");
      const completed = await completeCodexSessionInventoryTask(store, config, github, result.task, context);
      emitTaskProgress(context, completed.task, "completed", completed.task.result?.summary || "Safe Codex session metadata inventory completed.");
      return completed;
    }),
    run_assigned_codex_tasks: tool("Process assigned tasks. For session inventory tasks (readonly): safe metadata listing. For builder/deploy tasks: workspace inspection (file listing, port checks, health probes). Supports bounded concurrent execution.", schema({ limit: "integer", concurrency: "integer" }), async (args, context) => runAssignedCodexTasks(store, config, github, args, context)),
    preview_codex_context: tool("Show what Codex will see before executing a task: task status, linked goal, workspace paths, canonical repo, project context files, transcript/memory counts, acceptance criteria, size metrics, and warnings for missing repo, dirty worktree, stale clone, or huge transcript. Use this before large Codex runs to verify the execution environment.", schema({ task_id: "string" }, ["task_id"]), async ({ task_id }, context) => {
      requireScope(context, "task:read");
      const task = await findTask(store, task_id);
      const workspace = await selectWorkspace(store, task.workspace_id, context);
      const state = await store.load();
      const goal = task.goal_id ? state.goals.find(function(g) { return g.id === task.goal_id; }) : null;
      let contextJson = null;
      if (goal && workspace) {
        try { contextJson = JSON.parse(await readFile(join(workspace.root, ".gptwork/goals/" + goal.id + "/context.json"), "utf8")); } catch {}
      }
      let repoRecord = null;
      let repoStatus = null;
      if (registry) {
        const defaultRepo = registry.getDefaultRepo() || null;
        if (defaultRepo && typeof defaultRepo === "object") {
          repoRecord = defaultRepo;
        }
        if (!repoRecord && config.defaultRepoPath) {
          repoRecord = registry.findByPath(config.defaultRepoPath) || null;
        }
        if (repoRecord) {
          try { repoStatus = await getRepoStatus(repoRecord, config.defaultWorkspaceRoot, registry); } catch {}
        } else if (config.defaultRepoPath) {
          try { repoStatus = await getRepoStatus({ canonical_path: config.defaultRepoPath, default_branch: config.defaultBranch || "main", repo_id: "default", remote_url: "" }, config.defaultWorkspaceRoot); } catch {}
        }
      }
      const { context: ctx, preview } = await buildCodexContext({
        taskId: task.id,
        task,
        goal,
        contextJson,
        workspace,
        config,
        repoStatus,
        repoRecord,
      });
      return { context: ctx, preview, preview_text: preview };
    }),
    complete_task: tool("Mark a task completed with a summary of what was done. Use after Codex finishes the work and verification passes. Include a brief summary for ChatGPT review.", schema({ task_id: "string", summary: "string" }, ["task_id"]), async ({ task_id, summary = "" }) => {
      const result = await updateTask(store, task_id, (task) => { task.status = "completed"; task.result = { summary, completed_at: new Date().toISOString() }; });
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    request_human_review: tool("Mark a task as waiting for human review.", schema({ task_id: "string", message: "string" }, ["task_id"]), async ({ task_id, message = "" }) => updateTask(store, task_id, (task) => { task.status = "waiting_for_review"; task.review_message = message; })),
    schedule_service_restart: tool("Schedule a safe two-phase service restart. Writes a pending restart marker and schedules a detached systemd service restart. Use when the worker needs to restart itself after completing its work.", schema({ task_id: "string", expected_commit: "string", expected_remote_head: "string" }, ["task_id"]), async ({ task_id, expected_commit = null, expected_remote_head = null }) => {
      const result = await scheduleServiceRestart({
        workspaceRoot: config.defaultWorkspaceRoot,
        taskId: task_id,
        requestedBy: "codex",
        serviceName: "gptwork-mcp.service",
        expectedCommit: expected_commit,
        expectedRemoteHead: expected_remote_head,
        repoPath: config.defaultRepoPath,
        store,
      });
      return result;
    }),
    list_pending_restarts: tool("List all pending restart markers waiting for service restart and Phase C startup verification.", schema({}), async () => {
      const markers = await scanPendingRestartMarkers(config.defaultWorkspaceRoot);
      return { count: markers.length, markers };
    }),

    create_chatgpt_request: tool("Ask ChatGPT a question or request analysis. Use when Codex needs human input, product direction, design feedback, or a tricky judgment call. ChatGPT sees this and responds. Syncs to GitHub Issues if configured.", schema({ title: "string", prompt: "string", source: "string", task_id: "string", workspace_id: "string" }, ["title", "prompt"]), async (args) => {
      const result = await createChatGptRequest(store, args);
      github.syncChatGptRequest(result.request).catch(() => {});
      return result;
    }),
    list_chatgpt_requests: tool("List coordination requests from Codex needing ChatGPT attention. Open requests mean Codex is waiting for your analysis, decision, or input.", schema({ status: "string", source: "string", limit: "integer" }), async ({ status, source, limit = 50 }) => {
      const state = await store.load();
      state.chatgpt_requests ||= [];
      let requests = state.chatgpt_requests;
      if (status) requests = requests.filter((request) => request.status === status);
      if (source) requests = requests.filter((request) => request.source === source);
      return { requests: requests.slice(-limit).reverse() };
    }),
    get_chatgpt_request: tool("Return a ChatGPT coordination request.", schema({ request_id: "string" }, ["request_id"]), async ({ request_id }) => ({ request: await findChatGptRequest(store, request_id) })),
    answer_chatgpt_request: tool("Record ChatGPT response to a coordination request. Use this to attach ChatGPT analysis or decision so Codex can continue working.", schema({ request_id: "string", response: "string" }, ["request_id", "response"]), async ({ request_id, response }) => {
      const result = await updateChatGptRequest(store, request_id, (request) => { request.status = "answered"; request.response = response; request.answered_at = new Date().toISOString(); });
      github.syncChatGptRequest(result.request).catch(() => {});
      return result;
    }),

    list_dir: tool("List files and directories under a workspace path.", schema({ path: "string", recursive: "boolean", limit: "integer", workspace_id: "string" }), async (args, context) => workspaceListDir(store, config, args, context)),
    stat_path: tool("Return metadata for a file or directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceStat(store, config, args, context)),
    read_text_file: tool("Read a UTF-8 text file.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceReadText(store, config, args, context)),
    download_file_base64: tool("Download a file as base64.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDownloadBase64(store, config, args, context)),
    write_text_file: tool("Write a UTF-8 text file.", schema({ path: "string", content: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content"]), async (args, context) => workspaceWriteText(store, config, args, context)),
    upload_base64_file: tool("Upload a base64 encoded file.", schema({ path: "string", content_base64: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content_base64"]), async (args, context) => workspaceUploadBase64(store, config, args, context)),
    upload_bundle_base64: tool("Upload a ZIP bundle encoded as base64. Optionally extract it in the workspace after upload.", schema({ path: "string", zip_base64: "string", overwrite: "boolean", extract: "boolean", target_dir: "string", sha256_expected: "string", workspace_id: "string" }, ["path", "zip_base64"]), async (args, context) => workspaceUploadBundleBase64(store, config, args, context)),
    download_bundle_base64: tool("Create a ZIP bundle from a workspace directory or selected paths and return it as base64 with a SHA256 digest.", schema({ source_dir: "string", paths: "array", workspace_id: "string" }, []), async (args, context) => workspaceDownloadBundleBase64(store, config, args, context)),
    upload_from_url: tool("Download a URL and save it to the workspace.", schema({ url: "string", path: "string", overwrite: "boolean", workspace_id: "string" }, ["url", "path"]), async (args, context) => workspaceUploadFromUrl(store, config, args, context)),
    mkdir: tool("Create a directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceMkdir(store, config, args, context)),
    delete_path: tool("Permanently delete a file or directory. Files are deleted immediately, without recycle/trash. Use with caution.", schema({ path: "string", recursive: "boolean", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDelete(store, config, args, context)),
    move_path: tool("Move or rename a file/directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceMove(store, config, args, context)),
    copy_path: tool("Copy a file or directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceCopy(store, config, args, context)),
    search_files: tool("Search text content and file names under a directory.", schema({ q: "string", path: "string", limit: "integer", workspace_id: "string" }, ["q"]), async (args, context) => workspaceSearch(store, config, args, context)),
    sha256_file: tool("Calculate SHA256 of a file.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceSha256(store, config, args, context)),
    create_zip_archive: tool("Create a ZIP archive from a directory.", schema({ source_dir: "string", zip_path: "string", workspace_id: "string" }, ["source_dir", "zip_path"]), async (args, context) => workspaceShellZip(store, config, "create", args, context)),
    extract_zip_archive: tool("Extract a ZIP archive into a workspace directory.", schema({ zip_path: "string", target_dir: "string", workspace_id: "string" }, ["zip_path"]), async (args, context) => workspaceShellZip(store, config, "extract", args, context)),
    shell_exec: tool("在工作区执行终端命令，用于检查服务状态和运行配置脚本。", schema({ command: "string", cwd: "string", timeout: "integer", max_output_bytes: "integer", workspace_id: "string" }, ["command"]), async (args, context) => workspaceShellExec(store, config, args, context)),

    sync_to_github: tool("Sync all open tasks and ChatGPT requests to GitHub Issues.", schema({}), async () => {
      const state = await store.load();
      const tasks = state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
      const requests = (state.chatgpt_requests || []).filter((r) => r.status === 'open');
      const taskResults = await github.syncAllTasks(tasks);
      const requestResults = await github.syncAllRequests(requests);
      return { options: { github_repo: process.env.GPTWORK_GITHUB_REPO || '(not set)', github_enabled: github.enabled }, synced_tasks: taskResults.length, synced_requests: requestResults.length, taskResults, requestResults };
    }),
    sync_from_github: tool("Import open GitHub Issues as tasks, and import GitHub Issue comments as ChatGPT responses. This is the no-reverse-proxy flow: ChatGPT creates GitHub Issues, Codex imports and works on them, results sync back. Also detects ChatGPT responses in issue comments.", schema({}), async () => {
      const imported = await github.importFromIssues(store);
      const responses = await github.importResponsesFromComments(store);
      return { imported_tasks: imported.length, tasks: imported.map((t) => ({ id: t.id, title: t.title, status: t.status })), imported_responses: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, responded_by: r.user })) };
    }),
    github_status: tool("Return GitHub sync configuration and known issue count.", schema({}), async () => ({
      enabled: github.enabled,
      repo: process.env.GPTWORK_GITHUB_REPO || '',
      known_issues: github.getKnownIssues().length,
      env_vars_set: { repo: !!process.env.GPTWORK_GITHUB_REPO, token: !!process.env.GPTWORK_GITHUB_TOKEN }
    })),
    register_repository: tool("Register a repository in the workspace registry so Codex can find it via canonical path instead of stale temporary clones.", schema({ remote_url: "string", canonical_path: "string", default_branch: "string", roles: "string", tags: "string", status: "string" }, ["remote_url"]), async (args) => {
      const info = {
        remote_url: args.remote_url,
        canonical_path: args.canonical_path || null,
        default_branch: args.default_branch || null,
        roles: args.roles ? args.roles.split(",").map(s => s.trim()).filter(Boolean) : [],
        tags: args.tags ? args.tags.split(",").map(s => s.trim()).filter(Boolean) : [],
        status: args.status || "active",
      };
      const record = await registry.register(info);
      return { ok: true, record };
    }),

    list_repositories: tool("List all registered repositories in the workspace registry with canonical paths.", schema({}), async () => {
      const repos = registry.list();
      return { count: repos.length, repositories: repos };
    }),

    get_repository_status: tool("Get detailed status for a registered repository, including canonical/stale detection and ahead/behind. If no repo_id/owner/repo_name is provided and there is exactly one registered repo, it will be used automatically. Multi-repo projects must specify repo_id.", schema({ repo_id: "string", owner: "string", repo_name: "string" }, []), async (args) => {
      let record = null;
      if (args.repo_id) {
        record = registry.get(args.repo_id);
      } else if (args.owner && args.repo_name) {
        record = registry.findByName(args.owner, args.repo_name);
      } else {
        record = registry.getDefaultRepo();
      }
      if (!record) {
        const count = registry.count();
        if (count === 0) return { error: "No repositories registered. Use register_repository first.", repositories: [] };
        if (count > 1) return { error: "Multiple repositories registered. Please specify repo_id, owner/repo, or repo_name.", repositories: registry.list().map(r => ({ repo_id: r.repo_id, owner: r.owner, repo_name: r.repo_name })) };
        return { error: "Repository not found." };
      }
      const status = await getRepoStatus(record, registry.workspaceRoot, registry);
      return status;
    }),

    resolve_canonical_repository: tool("Resolve which repository to use for the current task context. If exactly one repo is registered, returns it; if multiple, returns the best match or asks for repo_id. Call this before doing repo work.", schema({ repo_id: "string", owner: "string", repo_name: "string" }, []), async (args) => {
      let record = null;
      if (args.repo_id) {
        record = registry.get(args.repo_id);
      } else if (args.owner && args.repo_name) {
        record = registry.findByName(args.owner, args.repo_name);
      } else {
        record = registry.getDefaultRepo();
      }
      if (!record) {
        const count = registry.count();
        if (count === 0) return { error: "No repositories registered. Use register_repository first.", repositories: [] };
        if (count > 1) return { error: "Multiple repositories registered. Please specify repo_id, owner/repo, or repo_name. Available: " + registry.list().map(r => r.repo_id).join(", ") };
        return { error: "Repository not found." };
      }
      return { ok: true, repo_id: record.repo_id, canonical_path: record.canonical_path, remote_url: record.remote_url, default_branch: record.default_branch, owner: record.owner, repo_name: record.repo_name };
    }),

    detect_stale_clones: tool("Scan the workspace root for stale temporary clones (.tmp-* directories) that could confuse Codex status checks. Returns matching directory names and whether they contain git repos.", schema({}), async () => {
      const clones = await detectStaleTempClones(registry.workspaceRoot);
      return { count: clones.length, clones };
    }),

    sync_github_comments: tool("Poll GitHub Issues for new comments and import ChatGPT responses as answers to coordination requests. After ChatGPT responds to a question via GitHub Issue comment, use this to bring the answer back into the system.", schema({}), async () => {
      const responses = await github.importResponsesFromComments(store);
      return { checked_issues: github.getKnownIssues().length, responses_found: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, from: r.user })) };
    }),

    browser_new_session: tool("Create a lightweight HTTP browser session (no JS execution, no real rendering).", schema({ headless: "boolean", viewport_width: "integer", viewport_height: "integer" }), async (args) => browser.newSession(args)),
    browser_list_sessions: tool("List browser sessions.", schema({}), async () => browser.listSessions()),
    browser_close_session: tool("Close a browser session.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.closeSession(session_id)),
    browser_goto: tool("Navigate a browser session to a URL. Performs a server-side HTTP GET; page JavaScript is not executed.", schema({ session_id: "string", url: "string" }, ["session_id", "url"]), async ({ session_id, url }) => browser.goto(session_id, url)),
    browser_current_state: tool("Return current page URL and title.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.currentState(session_id)),
    browser_get_text: tool("Extract visible inner text.", schema({ session_id: "string", max_chars: "integer" }, ["session_id"]), async ({ session_id, max_chars }) => browser.getText(session_id, max_chars)),
    browser_get_html: tool("Extract HTML.", schema({ session_id: "string", max_chars: "integer" }, ["session_id"]), async ({ session_id, max_chars }) => browser.getHtml(session_id, max_chars)),
    browser_extract_links: tool("Extract links.", schema({ session_id: "string", limit: "integer" }, ["session_id"]), async ({ session_id, limit }) => browser.extractLinks(session_id, limit)),
    browser_click: tool("Record a click target (lightweight HTTP browser; clicks do not trigger JS or navigation).", schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]), async ({ session_id, selector }) => browser.click(session_id, selector)),
    browser_fill: tool("Record input fill target (lightweight HTTP browser; does not execute form JS).", schema({ session_id: "string", selector: "string", text: "string" }, ["session_id", "selector", "text"]), async ({ session_id, selector, text }) => browser.fill(session_id, selector, text)),
    browser_press: tool("Record key press (lightweight HTTP browser; does not execute JS).", schema({ session_id: "string", selector: "string", key: "string" }, ["session_id", "selector", "key"]), async ({ session_id, selector, key }) => browser.press(session_id, selector, key)),
    browser_wait_for_selector: tool("Wait for selector (lightweight HTTP browser; no JS or DOM mutation tracking).", schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]), async ({ session_id, selector }) => browser.waitForSelector(session_id, selector)),
    browser_scroll: tool("Record scroll target (lightweight HTTP browser; does not execute JS).", schema({ session_id: "string", x: "integer", y: "integer" }, ["session_id"]), async ({ session_id, x, y }) => browser.scroll(session_id, x, y)),
    browser_screenshot: tool("[EXPERIMENTAL] Take a browser screenshot. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).", schema({ session_id: "string", path: "string" }, ["session_id"]), async ({ session_id, path = "" }) => ({ ok: false, session_id, path, error: "screenshots require a Playwright-enabled browser adapter" })),
    browser_set_input_files: tool("[EXPERIMENTAL] Upload files to a browser input. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).", schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector", "path"]), async (args) => ({ ok: false, ...args, error: "file input automation requires a Playwright-enabled browser adapter" })),
    browser_click_and_download: tool("[EXPERIMENTAL] Click an element and download its target. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).", schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector"]), async (args) => ({ ok: false, ...args, error: "download automation requires a Playwright-enabled browser adapter" })),
    browser_evaluate: tool("[EXPERIMENTAL] Evaluate JavaScript in the browser page. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).", schema({ session_id: "string", script: "string" }, ["session_id", "script"]), async ({ session_id, script }) => browser.evaluate(session_id, script)),
    runtime_status: tool("Return safe runtime diagnostics: process info, git state, config, env file and state file status.", schema({}), async () => {
      const repoDir = resolveRepoDir();
      let repo_head = null, remote_head = null, running_commit = null;
      let worktree_dirty = false, dirty_paths = [];

      if (repoDir) {
        try {
          const out = execSync("git rev-parse HEAD 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
          if (out) repo_head = out;
        } catch (e) {}
        try {
          const line = execSync("git ls-remote origin refs/heads/main 2>/dev/null", { cwd: repoDir, timeout: 2000, encoding: "utf8" }).trim();
          if (line) remote_head = line.split(/\s+/)[0];
        } catch (e) {}
        try {
          const statusOut = execSync("git status --short 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
          if (statusOut.length > 0) {
            worktree_dirty = true;
            dirty_paths = statusOut.split("\n").filter(l => l.trim()).map(l => l.trim());
          }
        } catch (e) {}
        running_commit = repo_head;
      }

      const statePath = config.statePath;
      const statePathAbs = statePath.startsWith("/") ? statePath : join(process.cwd(), statePath);
      const statePathInsideRepo = repoDir ? statePathAbs.startsWith(repoDir) : false;

      const envPath = envLoadResult.loadedPath;
      let envFileExists = false;
      if (envPath) {
        try {
          envFileExists = existsSync(envPath);
        } catch (e) {}
      }

      // Safe restart markers status (computed from marker files, no secrets)
      let restartMarkerData = { total_count: 0, active_count: 0, statuses: { pending: 0, scheduled: 0, restarted: 0, verified: 0, failed: 0 }, marker_dir_exists: false };
      try {
        const markerDir = getPendingRestartsDir(config.defaultWorkspaceRoot);
        restartMarkerData.marker_dir_exists = existsSync(markerDir);
        const markers = await scanPendingRestartMarkers(config.defaultWorkspaceRoot);
        restartMarkerData.total_count = markers.length;
    restartMarkerData.active_count = markers.filter(m => ["pending", "scheduled", "restarted"].includes(m.status)).length;
        for (const m of markers) {
          if (m.status && restartMarkerData.statuses[m.status] !== undefined) {
            restartMarkerData.statuses[m.status]++;
          }
        }
      } catch (e) { /* non-fatal */ }

      return {
        pid: process.pid,
        started_at: PROCESS_STARTED_AT.toISOString(),
        repo_head,
        remote_head,
        running_commit,
        defaultWorkspaceRoot: config.defaultWorkspaceRoot,
        codex_exec_timeout: config.codexExecTimeout,
        codex_exec_args: config.codexExecArgs,
        shell_timeout: config.shellTimeout,
        max_read_bytes: config.maxReadBytes,
        max_shell_output_bytes: config.maxShellOutputBytes,
        default_repo: config.defaultRepo,
        default_branch: config.defaultBranch,
        default_repo_path: config.defaultRepoPath,
        default_remote: config.defaultRemote,
        runtime_env_file_path: envPath,
        runtime_env_file_exists: envFileExists,
        runtime_env_loaded: envLoadResult.keys.length > 0,
        runtime_env_keys_loaded: envLoadResult.keys,
        state_path: statePath,
        state_path_inside_repo: statePathInsideRepo,
        worktree_dirty,
        dirty_paths,
        restart_markers: restartMarkerData,
        // Config sources for key operational values
        config_sources: {
          codex_exec_timeout: sources.codexExecTimeout,
          shell_timeout: sources.shellTimeout,
          state_path: sources.statePath,
          default_repo: sources.defaultRepo,
          default_branch: sources.defaultBranch,
          default_repo_path: sources.defaultRepoPath,
          default_remote: sources.defaultRemote,
          bark_enabled: sources.barkEnabled,
          bark_url: sources.barkUrl,
          bark_key: sources.barkKey,
          github_enabled: sources.githubEnabled,
          github_repo: sources.githubRepo,
          github_token: sources.githubToken,
          workspace_root: sources.workspaceRoot,
          max_read_bytes: sources.maxReadBytes,
          max_shell_output_bytes: sources.maxShellOutputBytes,
        },
        // Bark status (safe, no secrets)
        bark: bark ? {
          enabled: bark.isEnabled ? bark.isEnabled() : false,
          configured: bark.getStatus ? bark.getStatus().configured : false,
          source: bark.getStatus ? bark.getStatus().source : "unknown",
          url_set: bark.getStatus ? bark.getStatus().url_set : false,
          key_set: bark.getStatus ? bark.getStatus().key_set : false,
          group: bark.getStatus ? bark.getStatus().group : "gptwork",
        } : { enabled: false, configured: false, source: "none" },
        // GitHub sync status (safe, no secrets)
        github: {
          api_sync_enabled: (process.env.GPTWORK_GITHUB_ENABLED === "true" || process.env.GPTWORK_GITHUB_ENABLED === "1") && !!(process.env.GPTWORK_GITHUB_REPO && process.env.GPTWORK_GITHUB_TOKEN),
          api_repo_set: !!process.env.GPTWORK_GITHUB_REPO,
          api_token_set: !!process.env.GPTWORK_GITHUB_TOKEN,
          source: sources.githubEnabled,
          direct_git_available: true,
          direct_git_reader_available: true,
        },
        repo_locks: await getRepoLockSummary(config.defaultWorkspaceRoot),
      };
    }),
    notification_status: tool("Return safe Bark notification configuration and last-attempt diagnostics (no endpoint/key values).", schema({}), async () => bark ? bark.getStatus() : ({ enabled: false, configured: false, source: "unknown", url_set: false, key_set: false, group: "gptwork", sound_set: false, level_set: false, icon_set: false, url_action_set: false, last_attempt_at: null, last_success_at: null, last_failure_at: null, last_response_code: null, last_response_message: null, last_error_short: null, last_task_id: null, last_task_status: null, last_task_event: null })),
    test_bark_notification: tool("Send a test Bark notification and return safe diagnostic result without exposing endpoint/key values.", schema({}), async () => bark ? bark.testSend() : ({ ok: false, attempted_at: null, response_code: null, response_message: null, source: "unknown", group: "gptwork", endpoint_kind: "none", error_short: "bark not initialized" })),
    git_remote_resolve_repo: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Finds an existing Git checkout for a repo (owner/name, URL, or path). Returns repo_path, remote info, and local/tracking HEADs. Does NOT auto-clone.", schema({ repo: "string", repo_path: "string" }, []), async (args) => handleResolveRepo(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote })),

    git_remote_fetch: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Runs git fetch to update remote tracking refs from the local Git checkout.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string" }, []), async (args) => handleFetch(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultRepoPath: config.defaultRepoPath, defaultBranch: config.defaultBranch, defaultRemote: config.defaultRemote })),

    git_remote_status: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Returns local HEAD, tracking HEAD, remote HEAD (from git ls-remote), equality flags, and dirty state.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean" }, []), async (args) => handleStatus(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultRepoPath: config.defaultRepoPath, defaultBranch: config.defaultBranch, defaultRemote: config.defaultRemote })),

    git_remote_list_files: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Lists files from a Git ref using git ls-tree --name-only without checking out the ref.", schema({ repo: "string", repo_path: "string", ref: "string", path: "string", limit: "integer" }, []), async (args) => handleListFiles(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultRepoPath: config.defaultRepoPath, defaultBranch: config.defaultBranch, defaultRemote: config.defaultRemote })),

    git_remote_read_file: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Reads file content from a Git ref using git show <ref>:<path> without checking out the ref. Supports truncation via max_bytes.", schema({ repo: "string", repo_path: "string", ref: "string", path: "string", max_bytes: "integer" }, ["path"]), async (args) => handleReadFile(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultRepoPath: config.defaultRepoPath, defaultBranch: config.defaultBranch, defaultRemote: config.defaultRemote })),

    git_remote_changed_files: tool("Inspect GitHub remote repository changes without GitHub connector. Lists changed files between two refs/commits using git diff --name-status. Supports path scoping and limit.", schema({ repo: "string", repo_path: "string", base: "string", head: "string", path: "string", limit: "integer" }, []), async (args) => handleChangedFiles(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote })),

    git_remote_diff: tool("Inspect GitHub remote repository changes without GitHub connector. Returns unified diff between two refs/commits, optionally path-scoped. Truncates safely by max_bytes.", schema({ repo: "string", repo_path: "string", base: "string", head: "string", path: "string", max_bytes: "integer" }, []), async (args) => handleDiff(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote })),

    git_remote_show_commit: tool("Inspect GitHub remote repository changes without GitHub connector. Shows metadata and file list for one commit/ref using git show --name-status.", schema({ repo: "string", repo_path: "string", ref: "string", max_files: "integer" }, []), async (args) => handleShowCommit(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote })),

    git_remote_compare_local: tool("Inspect GitHub remote repository changes without GitHub connector. One-shot comparison: returns local HEAD, tracking HEAD, remote HEAD, ahead/behind counts, dirty state, and changed files summary. Fetches remote tracking refs by default.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean", limit: "integer" }, []), async (args) => handleCompareLocal(args, { registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote })),



    project_context_status: tool("Return a concise diagnostic showing context source health and precedence: canonical repo, workspace root, project context files (project.md, project.env), context source precedence summary, and optionally task-linked diagnostics (task status, linked goal, preview availability, warnings). Does not expose secret values from project.env.", schema({ task_id: "string" }, []), contextStatusHandler),

    context_status: tool("Provide context source health and precedence diagnostics: canonical repo, workspace root, project context files (project.md, project.env), context source precedence summary, and optionally task-linked diagnostics (task status, linked goal, preview availability, warnings). Natural alias for project_context_status, responds to queries like 上下文状态. Does not expose secret values from project.env.", schema({ task_id: "string" }, []), contextStatusHandler),

    context_prepare: tool("Prepare safe context hygiene fixes after project_context_status detects issues. Defaults to check-only (dry-run). In fix_safe mode, creates missing .gptwork/ directory, project.md, and project.env templates. Never overwrites existing content or exposes secrets. If the repo is dirty or another Codex run is active, stops and reports rather than racing. (上下文健康检查和自动修复)", schema({ task_id: "string", mode: "string" }, []), contextPrepareHandler),



    gptwork_doctor: tool("Return a comprehensive user-facing diagnostic summary: process info, runtime config, git state, repo registry, stale clones, worktree health, Bark/GitHub sync status, placeholder tool exposure, and suggested next actions. Does not expose secrets.", schema({}, []), async () => {
      const repoDir = resolveRepoDir();
      const registryData = { entries: [], count: 0, hasCanonical: false };
      try {
        const allRepos = registry.list();
        registryData.entries = allRepos;
        registryData.count = allRepos.length;
        registryData.hasCanonical = allRepos.some(r => r.canonical_path === config.defaultRepoPath);
      } catch (e) {}
      let staleCloneCount = 0;
      try {
        const wsRoot = config.defaultWorkspaceRoot || "";
        if (wsRoot && existsSync(wsRoot)) {
          const entries = readdirSync(wsRoot, { withFileTypes: true });
          staleCloneCount = entries.filter(e => e.isDirectory() && e.name.startsWith('.tmp-')).length;
        }
      } catch (e) {}
      let worktreeDirty = false, dirtyPaths = [];
      if (repoDir) {
        try {
          const out = execSync('git status --short 2>/dev/null', { cwd: repoDir, timeout: 5000, encoding: 'utf8' }).trim();
          if (out.length > 0) { worktreeDirty = true; dirtyPaths = out.split('\n').filter(l => l.trim()).map(l => l.trim()); }
        } catch (e) {}
      }
      const exposePlaceholder = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS === 'true';
      const _lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      return {
        pid: process.pid,
        started_at: PROCESS_STARTED_AT.toISOString(),
        running_commit: repoDir ? (() => { try { return execSync('git rev-parse HEAD 2>/dev/null', { cwd: repoDir, timeout: 5000, encoding: 'utf8' }).trim(); } catch(e){} return null; })() : null,
        runtime_env_loaded: envLoadResult.keys.length > 0,
        runtime_env_file_path: envLoadResult.loadedPath || null,
        workspace_root: config.defaultWorkspaceRoot,
        hosted_default_root_aligned: config.defaultWorkspaceRoot === '/home/a9017/mcp/workspace',
        default_repo: config.defaultRepo,
        default_branch: config.defaultBranch,
        default_repo_path: config.defaultRepoPath,
        repository_registry_count: registryData.count,
        repository_registry_has_canonical_repo: registryData.hasCanonical,
        stale_clone_count: staleCloneCount,
        worktree_dirty: worktreeDirty,
        dirty_paths: dirtyPaths,
        codex_exec_timeout: config.codexExecTimeout,
        github_api_sync_enabled: (process.env.GPTWORK_GITHUB_ENABLED === 'true' || process.env.GPTWORK_GITHUB_ENABLED === '1') && !!(process.env.GPTWORK_GITHUB_REPO && process.env.GPTWORK_GITHUB_TOKEN),
        direct_git_reader_available: true,
        bark_configured: bark ? (bark.getStatus ? bark.getStatus().configured : false) : false,
        bark_enabled: bark ? (bark.isEnabled ? bark.isEnabled() : false) : false,
        placeholder_tools_exposed: exposePlaceholder || false,
        suggested_next_actions: (() => {
          const actions = [];
          if (envLoadResult.keys.length === 0) actions.push('Set up runtime.env with GPTWORK_* variables or configure via process.env');
          if (!registryData.hasCanonical) actions.push('Register the canonical repo via register_repository');
          if (staleCloneCount > 0) actions.push('Clean up ' + staleCloneCount + ' stale clone(s) (rm -rf .tmp-* in workspace root)');
          if (worktreeDirty) actions.push('Commit or stash dirty worktree changes');
          if (config.defaultRepo !== '9018/gpt-codex-workspace') actions.push('Set GPTWORK_DEFAULT_REPO=9018/gpt-codex-workspace for canonical repo resolution');
          // Check restart markers: only active (pending/scheduled/restarted) ones need action; verified/failed are historical
          (() => {
            try {
              const markers = scanPendingRestartMarkersSync(config.defaultWorkspaceRoot);
              const active = markers.filter(m => ['pending','scheduled','restarted'].includes(m.status));
              if (active.length > 0) {
                actions.push(active.length + ' active restart marker(s) (' + active.map(m => m.task_id.slice(0,12) + ':' + m.status).join(', ') + ') — complete or verify via schedule_service_restart');
              }
            } catch(e) {}
          })();
          // Suggest project_context_status when project context is missing or unhealthy
          (() => {
            try {
              const canonPath = config.defaultRepoPath;
              if (canonPath) {
                const pmdPath = join(canonPath, ".gptwork", "project.md");
                const penvPath = join(canonPath, ".gptwork", "project.env");
                const mdExists = existsSync(pmdPath);
                const envExists = existsSync(penvPath);
                if (!mdExists || !envExists) {
                  actions.push('Run project_context_status / context_status for project context health — missing ' + (!mdExists ? 'project.md' : '') + (!mdExists && !envExists ? ' and ' : '') + (!envExists ? 'project.env' : ''));
                }
                // Also suggest if env file exists but appears empty
                if (envExists) {
                  try {
                    const envContent = readFileSync(penvPath, "utf8").trim();
                    if (!envContent) {
                      actions.push('Run project_context_status / context_status for project context health — project.env exists but is empty');
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
         })();

          // Suggest repo_lock_status/list_repo_locks when active or stale locks exist
          (() => {
            try {
              if (_lockSummary.active_repo_locks > 0 || _lockSummary.stale_repo_locks > 0) {
                const parts = [];
                if (_lockSummary.active_repo_locks > 0) parts.push(_lockSummary.active_repo_locks + ' active');
                if (_lockSummary.stale_repo_locks > 0) parts.push(_lockSummary.stale_repo_locks + ' stale');
                actions.push('Run repo_lock_status / list_repo_locks to inspect ' + parts.join(' and ') + ' repo lock(s) — concurrent Codex execution may be blocked');
              }
            } catch (e) {}
          })();

         return actions;
        })(),
        repo_locks: _lockSummary,
      };
    }),
    list_repo_locks: tool("List repo execution locks with safe diagnostics. Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)", schema({}), async () => {
      const _lockList = await listRepoLocks(config.defaultWorkspaceRoot);
      const _lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
     return { active_repo_locks: _lockSummary.active_repo_locks, stale_repo_locks: _lockSummary.stale_repo_locks, locks: _lockList };
   }),
    repo_lock_status: tool("List repo execution locks with safe diagnostics (alias for list_repo_locks). Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)", schema({}), async () => {
      const _lockList = await listRepoLocks(config.defaultWorkspaceRoot);
      const _lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      return { active_repo_locks: _lockSummary.active_repo_locks, stale_repo_locks: _lockSummary.stale_repo_locks, locks: _lockList };
    }),
  };
  // Gate experimental browser placeholder tools behind env flags (hidden by default unless GPTWORK_EXPOSE_PLACEHOLDER_TOOLS or GPTWORK_EXPERIMENTAL_BROWSER_TOOLS is set)
  const _exposePlaceholderTools = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS === 'true';
  if (!_exposePlaceholderTools && process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS !== 'true') {
    delete tools.browser_screenshot;
    delete tools.browser_set_input_files;
    delete tools.browser_click_and_download;
    delete tools.browser_evaluate;
  }
  return tools;
}

async function handleHttp(req, res, server) {
  setCors(res);
  if (req.method === "OPTIONS") return endJson(res, 204, {});
  if (req.url === "/health") return endJson(res, 200, { ok: true, service: "gptwork-mcp", time: new Date().toISOString() });
  if (!req.url?.startsWith("/mcp")) return endJson(res, 404, { error: "not found" });
  if (req.method === "GET") return endSse(res, ": connected\n\n");
  if (req.method !== "POST") return endJson(res, 406, { jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Not Acceptable: use POST with Accept: text/event-stream" } });

  try {
    const raw = await readRequest(req);
    const message = JSON.parse(raw || "{}");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] || randomUUID());
    setSseHeaders(res);
    const response = await server.handleRpc(message, headersWithPathToken(req), (progress) => writeSseMessage(res, progress));
    if (response) writeSseMessage(res, response);
    res.end();
  } catch (error) {
    const response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
    if (res.headersSent) {
      writeSseMessage(res, response);
      res.end();
    } else {
      endJson(res, 400, response);
    }
  }
}

function headersWithPathToken(req) {
  if (req.headers.authorization) return req.headers;
  const token = tokenFromMcpPath(req.url || "");
  if (!token) return req.headers;
  return { ...req.headers, authorization: `Bearer ${token}` };
}

function tokenFromMcpPath(url) {
  const path = url.split("?", 1)[0];
  const match = path.match(/^\/mcp\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

function endSse(res, body) {
  setSseHeaders(res);
  res.end(body);
}

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
}

function writeSseMessage(res, message) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function toolList(tools) {
  return Object.entries(tools).map(([name, value]) => ({
    name,
    description: value.description,
    inputSchema: value.inputSchema,
    outputSchema: { type: "object", additionalProperties: true }
  }));
}

function schema(properties, required = []) {
  const mapped = {};
  for (const [key, type] of Object.entries(properties)) mapped[key] = { type };
  return { type: "object", properties: mapped, required, additionalProperties: false };
}

function initializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      experimental: {},
      logging: {},
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
      tools: { listChanged: true },
      extensions: { "io.modelcontextprotocol/ui": {} }
    },
    serverInfo: { name: "GPTWork MCP", version: "0.1.0" }
  };
}

function assertAuthorized(headers, config) {
  if (!config.requireAuth) return defaultTokenContext("anonymous");
  const auth = headers.authorization || headers.Authorization || "";
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  if (!token || !config.tokenContexts[token]) {
    const error = new Error("Missing or invalid bearer token");
    error.code = -32001;
    throw error;
  }
  return config.tokenContexts[token];
}

function jsonResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseTokens(value) {
  return String(value).split(",").map((token) => token.trim()).filter(Boolean);
}

function parseTokenContexts(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTokenContexts(contexts, tokens) {
  const normalized = {};
  for (const token of tokens) normalized[token] = defaultTokenContext(token);
  for (const [token, context] of Object.entries(contexts || {})) {
    normalized[token] = {
      ...defaultTokenContext(token),
      ...context,
      user_name: context.user_name || context.name || defaultTokenContext(token).user_name,
      project_ids: normalizeList(context.project_ids, ["*"]),
      workspace_ids: normalizeList(context.workspace_ids, ["*"]),
      scopes: normalizeList(context.scopes, defaultScopes())
    };
  }
  return normalized;
}

function defaultTokenContext(token) {
  return {
    token_label: token === "anonymous" ? "anonymous" : `token:${String(token).slice(0, 6)}`,
    user_id: "user_default",
    user_name: "Default User",
    team_id: "team_default",
    project_ids: ["*"],
    workspace_ids: ["*"],
    scopes: defaultScopes()
  };
}

function defaultScopes() {
  return ["project:read", "project:admin", "task:create", "task:read", "task:update", "task:assign_codex", "workspace:read", "workspace:write", "files:upload", "files:download", "shell:exec", "ssh:use", "browser:use", "audit:read"];
}

function normalizeList(value, fallback) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function limits(config) {
  return {
    max_read_bytes: config.maxReadBytes,
    max_shell_output_bytes: config.maxShellOutputBytes,
    shell_timeout: config.shellTimeout,
    codex_exec_timeout: config.codexExecTimeout
  };
}

async function selectWorkspace(store, workspace_id, context = defaultTokenContext("system")) {
  const state = await store.load();
  const workspace = workspace_id
    ? state.workspaces.find((item) => item.id === workspace_id)
    : state.workspaces.find((item) => item.default) || state.workspaces[0];
  if (!workspace) throw new Error(`workspace not found: ${workspace_id || "default"}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);
  return workspace;
}

function findProject(state, project_id) {
  const project = state.projects.find((item) => item.id === project_id);
  if (!project) throw new Error(`project not found: ${project_id}`);
  return project;
}

function canAccessProject(context, projectId) {
  return context.project_ids.includes("*") || context.project_ids.includes(projectId);
}

function canAccessWorkspace(context, workspaceId) {
  return context.workspace_ids.includes("*") || context.workspace_ids.includes(workspaceId);
}

function requireProjectAccess(context, projectId) {
  if (!canAccessProject(context, projectId)) throw new Error(`project access denied: ${projectId}`);
}

function requireWorkspaceAccess(context, workspaceId) {
  if (!canAccessWorkspace(context, workspaceId)) throw new Error(`workspace access denied: ${workspaceId}`);
}

function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) throw new Error(`missing required scope: ${scope}`);
}

async function createWorkspace(store, config, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  requireProjectAccess(context, args.project_id);
  if (args.type === "ssh") requireScope(context, "ssh:use");
  if (!["hosted", "ssh"].includes(args.type)) throw new Error(`unsupported workspace type: ${args.type}`);
  if (args.type === "ssh" && !args.host) throw new Error("SSH workspace requires host");

  const state = await store.load();
  findProject(state, args.project_id);
  const now = new Date().toISOString();
  const id = args.id || `workspace_${randomUUID()}`;
  if (state.workspaces.some((workspace) => workspace.id === id)) throw new Error(`workspace already exists: ${id}`);

  const workspace = {
    id,
    project_id: args.project_id,
    name: args.name,
    type: args.type,
    root: args.root || join(config.defaultWorkspaceRoot, id),
    default: Boolean(args.default),
    created_at: now,
    updated_at: now
  };

  if (args.type === "ssh") {
    workspace.host = args.host;
    workspace.user = args.user || "";
    workspace.port = args.port || 22;
    if (args.identity_file) workspace.identity_file = args.identity_file;
    if (args.socks_proxy) workspace.socks_proxy = args.socks_proxy;
  }

  state.workspaces.push(workspace);
  if (workspace.default) setDefaultWorkspace(state, workspace);
  state.activities.push({ time: now, type: "workspace.created", workspace_id: workspace.id, project_id: workspace.project_id });
  await store.save();
  return { workspace };
}

async function updateWorkspace(store, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const workspace = state.workspaces.find((item) => item.id === args.workspace_id);
  if (!workspace) throw new Error(`workspace not found: ${args.workspace_id}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);

  for (const field of ["name", "root", "host", "user", "port", "identity_file", "socks_proxy"]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) workspace[field] = args[field];
  }
  if (Object.prototype.hasOwnProperty.call(args, "default")) {
    workspace.default = Boolean(args.default);
    if (workspace.default) setDefaultWorkspace(state, workspace);
  }
  workspace.updated_at = new Date().toISOString();
  state.activities.push({ time: workspace.updated_at, type: "workspace.updated", workspace_id: workspace.id });
  await store.save();
  return { workspace };
}

async function deleteWorkspace(store, { workspace_id }, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspace_id);
  if (index === -1) throw new Error(`workspace not found: ${workspace_id}`);
  const [removed] = state.workspaces.splice(index, 1);
  requireProjectAccess(context, removed.project_id);
  requireWorkspaceAccess(context, removed.id);

  if (removed.default) {
    const fallback = state.workspaces.find((workspace) => workspace.project_id === removed.project_id);
    if (fallback) setDefaultWorkspace(state, fallback);
  }
  const now = new Date().toISOString();
  state.activities.push({ time: now, type: "workspace.deleted", workspace_id: removed.id });
  await store.save();
  return { ok: true, removed };
}

async function testWorkspaceConnection(store, config, { workspace_id, dry_run = false }, context) {
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "hosted") {
    await mkdir(workspace.root, { recursive: true });
    return { ok: true, workspace_id: workspace.id, type: "hosted", root: workspace.root };
  }

  requireScope(context, "ssh:use");
  const built = buildSshExecCommand(workspace, "printf gptwork-ssh-ok", ".");
  if (dry_run) return { ok: true, dry_run: true, workspace_id: workspace.id, command: `${built.file} ${built.args.join(" ")}` };

  const result = await runSshExec(workspace, "printf gptwork-ssh-ok", ".", Math.min(config.shellTimeout, 15), config.maxShellOutputBytes);
  return { ok: result.returncode === 0 && result.stdout.includes("gptwork-ssh-ok"), workspace_id: workspace.id, result };
}

function setDefaultWorkspace(state, workspace) {
  for (const item of state.workspaces) {
    if (item.project_id === workspace.project_id) item.default = item.id === workspace.id;
  }
  const project = state.projects.find((item) => item.id === workspace.project_id);
  if (project) {
    project.default_workspace_id = workspace.id;
    project.updated_at = new Date().toISOString();
  }
}

async function createTask(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  const state = await store.load();
  ensureGoalState(state);
  requireProjectAccess(context, args.project_id || "default");
  if (args.workspace_id) requireWorkspaceAccess(context, args.workspace_id);
  const now = new Date().toISOString();
  const task = {
    id: `task_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    title: args.title,
    description: args.description || "",
    created_by: context.user_id,
    assignee: args.assignee || "",
    status: args.assignee ? "queued" : "draft",
    mode: normalizeCreatedTaskMode(args),
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
  state.tasks.push(task);
  state.activities.push({ time: now, type: "task.created", task_id: task.id, title: task.title });
  await store.save();
  if (isCodexSessionInventoryTaskKind(task)) return { task };
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: Boolean(task.assignee) });
  return { task: linked.task, goal: linked.goal, conversation: linked.conversation, memories: linked.memories, workspace_files: linked.workspace_files };
}

function ensureGoalState(state) {
  state.goals ||= [];
  state.conversations ||= [];
  state.memories ||= [];
  state.tasks ||= [];
  state.activities ||= [];
}

async function createGoal(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const projectId = args.project_id || "default";
  const workspaceId = args.workspace_id || "hosted-default";
  requireProjectAccess(context, projectId);
  requireWorkspaceAccess(context, workspaceId);

  const state = await store.load();
  ensureGoalState(state);
  const now = new Date().toISOString();
  const goalId = `goal_${randomUUID()}`;
  const conversationId = `conv_${randomUUID()}`;
  const assignToCodex = args.assign_to_codex !== false;
  const mode = normalizeCreatedTaskMode({ title: args.title || titleFromGoal(args), description: args.goal_prompt, mode: args.mode || "builder" });
  const messages = normalizeGoalMessages(args.messages, now, context.user_id);
  const memories = normalizeGoalMemories(args.memories, goalId, conversationId, now, context.user_id);
  const goal = {
    id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    task_id: null,
    user_request: String(args.user_request || ""),
    goal_prompt: String(args.goal_prompt || ""),
    context_summary: String(args.context_summary || ""),
    preview_text: String(args.preview_text || ""),
    title: args.title || titleFromGoal(args),
    created_by: context.user_id,
    assignee: assignToCodex ? "codex" : "",
    status: assignToCodex ? "assigned" : "open",
    mode,
    created_at: now,
    updated_at: now
  };
  const conversation = {
    id: conversationId,
    goal_id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    messages,
    created_at: now,
    updated_at: now
  };

  state.goals.push(goal);
  state.conversations.push(conversation);
  state.memories.push(...memories);
  state.activities.push({ time: now, type: "goal.created", goal_id: goalId, title: goal.title });

  let task = null;
  if (assignToCodex) {
    task = buildGoalTask(goal, conversation, context.user_id);
    state.tasks.push(task);
    goal.task_id = task.id;
    state.activities.push({ time: now, type: "goal.assigned_codex", goal_id: goalId, task_id: task.id, title: goal.title });
    if (!args.skip_created_notification) {
      notifyCreatedTaskIfNeeded(task);
    }
  }

  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {
    payload: args.payload || null,
    payload_base64: args.payload_base64 || "",
    bundles: args.bundles || [],
    initialize_result: true
  }, context);
  await store.save();
  return { goal, conversation, memories, task, workspace_files };
}

async function createEncodedGoal(store, config, { preview_text, payload_base64, assign_to_codex = true, wait_ms = 0 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const payload = decodeBase64Json(payload_base64, "payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded goal payload requires user_request and goal_prompt");
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  if (preview_text && !messages.some((message) => String(message.content || "") === String(preview_text))) {
    messages.push({ role: "chatgpt", content: String(preview_text) });
  }
  const created = await createGoal(store, config, {
    ...payload,
    messages,
    preview_text,
    payload,
    payload_base64,
    assign_to_codex: payload.assign_to_codex ?? assign_to_codex
  }, context);
  const execution = await waitForTaskExecution(store, created.task, wait_ms);
  return {
    ...created,
    workspace_files: publicGoalWorkspaceFiles(created.goal, payload),
    internal_files: internalGoalWorkspaceFiles(created.goal, payload),
    execution
  };
}

async function listGoals(store, { status, assignee, workspace_id, limit = 50 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);
  let goals = state.goals.filter((goal) => canAccessProject(context, goal.project_id) && canAccessWorkspace(context, goal.workspace_id));
  if (status) goals = goals.filter((goal) => goal.status === status);
  if (assignee) goals = goals.filter((goal) => goal.assignee === assignee);
  if (workspace_id) goals = goals.filter((goal) => goal.workspace_id === workspace_id);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  return { goals: goals.slice(-maxItems).reverse() };
}

async function getGoalContext(store, config, { goal_id, task_id } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);
  const goal = findGoalInState(state, { goal_id, task_id });
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);
  const conversation = state.conversations.find((item) => item.id === goal.conversation_id) || null;
  const memories = state.memories.filter((item) => item.goal_id === goal.id);
  const task = goal.task_id ? state.tasks.find((item) => item.id === goal.task_id) || null : null;
  return { goal, conversation, memories, task, workspace_files: goalWorkspaceFiles(goal), codex_instruction: codexInstruction(goal) };
}

async function appendGoalMessage(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  const state = await store.load();
  ensureGoalState(state);
  const goal = findGoalInState(state, args);
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);
  let conversation = state.conversations.find((item) => item.id === goal.conversation_id);
  const now = new Date().toISOString();
  if (!conversation) {
    conversation = {
      id: goal.conversation_id || `conv_${randomUUID()}`,
      goal_id: goal.id,
      project_id: goal.project_id,
      workspace_id: goal.workspace_id,
      messages: [],
      created_at: now,
      updated_at: now
    };
    goal.conversation_id = conversation.id;
    state.conversations.push(conversation);
  }
  conversation.messages ||= [];
  const message = normalizeGoalMessage({ role: args.role || "codex", content: args.content }, now, context.user_id);
  conversation.messages.push(message);
  conversation.updated_at = now;
  goal.updated_at = now;
  let memory = null;
  if (args.memory_key || args.memory_value) {
    memory = normalizeGoalMemory({ key: args.memory_key || "note", value: args.memory_value || args.content }, goal.id, conversation.id, now, context.user_id);
    state.memories.push(memory);
  }
  state.activities.push({ time: now, type: "goal.message_appended", goal_id: goal.id, role: message.role });
  const memories = state.memories.filter((item) => item.goal_id === goal.id);
  const task = goal.task_id ? state.tasks.find((item) => item.id === goal.task_id) || null : null;
  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, { initialize_result: false }, context);
  await store.save();
  return { goal, conversation, message, memory, workspace_files };
}

function findGoalInState(state, { goal_id, task_id } = {}) {
  const goal = goal_id
    ? state.goals.find((item) => item.id === goal_id)
    : state.goals.find((item) => item.task_id === task_id);
  if (!goal) throw new Error(`goal not found: ${goal_id || task_id || "missing id"}`);
  return goal;
}

async function ensureTaskGoal(store, config, taskId, context = defaultTokenContext("system"), options = {}) {
  const state = await store.load();
  ensureGoalState(state);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (isCodexSessionInventoryTaskKind(task)) return { task };

  let goal = task.goal_id ? state.goals.find((item) => item.id === task.goal_id) : null;
  if (goal) {
    const conversation = state.conversations.find((item) => item.id === goal.conversation_id) || null;
    const memories = state.memories.filter((item) => item.goal_id === goal.id);
    const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {}, context);
    return { task, goal, conversation, memories, workspace_files };
  }

  const encoded = decodeTaskDescriptionEnvelope(task.description || "");
  const payload = encoded?.payload || taskPayloadFromTask(task);
  const created = await createGoal(store, config, {
    ...payload,
    title: payload.title || task.title,
    project_id: payload.project_id || task.project_id,
    workspace_id: payload.workspace_id || task.workspace_id,
    mode: payload.mode || task.mode || "builder",
    assign_to_codex: options.assign_to_codex ?? task.assignee === "codex",
    skip_created_notification: true,
    preview_text: encoded?.preview_text || payload.preview_text || "",
    payload: encoded?.payload || payload,
    payload_base64: encoded?.payload_base64 || ""
  }, context);

  await updateTask(store, task.id, (item) => {
    item.goal_id = created.goal.id;
    item.conversation_id = created.conversation.id;
    if (created.task && created.task.id !== item.id) {
      created.goal.task_id = item.id;
    }
  });

  const linkedState = await store.load();
  const createdTask = created.task && created.task.id !== task.id ? created.task : null;
  if (createdTask) {
    const index = linkedState.tasks.findIndex((item) => item.id === createdTask.id);
    if (index !== -1) linkedState.tasks.splice(index, 1);
  }
  goal = linkedState.goals.find((item) => item.id === created.goal.id);
  goal.task_id = task.id;
  const linkedTask = linkedState.tasks.find((item) => item.id === task.id);
  const conversation = linkedState.conversations.find((item) => item.id === goal.conversation_id) || null;
  const memories = linkedState.memories.filter((item) => item.goal_id === goal.id);
  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, linkedTask, {}, context);
  await store.save();
  return { task: linkedTask, goal, conversation, memories, workspace_files };
}

function taskPayloadFromTask(task) {
  return {
    user_request: task.description || task.title,
    goal_prompt: [
      `Task: ${task.title}`,
      "",
      task.description || "",
      "",
      "Execute this task in the selected workspace and report progress/results back to GPTWork."
    ].join("\n"),
    context_summary: "Created automatically from create_task compatibility flow.",
    project_id: task.project_id,
    workspace_id: task.workspace_id,
    mode: task.mode || "builder",
    messages: [
      { role: "user", content: task.description || task.title },
      { role: "chatgpt", content: `Created compatibility goal from task ${task.id}.` }
    ],
    memories: []
  };
}

function decodeTaskDescriptionEnvelope(description) {
  const text = String(description || "").trim();
  if (!text) return null;
  let envelope = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind === "gptwork.encoded_goal.v1" && parsed.payload_base64) envelope = parsed;
  } catch {}
  if (!envelope) {
    const match = text.match(/payload_base64\s*[:=]\s*([A-Za-z0-9+/=\r\n]+)/);
    if (match) envelope = { payload_base64: match[1].replace(/\s+/g, "") };
  }
  if (!envelope?.payload_base64) return null;
  const payload = decodeBase64Json(envelope.payload_base64, "task.description payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded task payload requires user_request and goal_prompt");
  return { payload, payload_base64: envelope.payload_base64, preview_text: envelope.preview_text || "" };
}

function decodeBase64Json(value, label) {
  let decoded = "";
  try {
    decoded = Buffer.from(String(value || ""), "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

function goalWorkspaceFiles(goal) {
  const dir = `.gptwork/goals/${goal.id}`;
  return {
    dir,
    goal_md: `${dir}/goal.md`,
    context_json: `${dir}/context.json`,
    transcript_md: `${dir}/transcript.md`,
    result_md: `${dir}/result.md`,
    payload_json: `${dir}/payload.json`,
    payload_base64: `${dir}/payload.base64`,
    bundle_zip: `${dir}/bundle.zip`,
    attachments_dir: `${dir}/attachments`
  };
}

function publicGoalWorkspaceFiles(goal, payload = {}) {
  const files = goalWorkspaceFiles(goal);
  const visible = {
    dir: files.dir,
    goal_md: files.goal_md,
    result_md: files.result_md
  };
  if (hasGoalBundles(payload)) visible.attachments_dir = files.attachments_dir;
  return visible;
}

function internalGoalWorkspaceFiles(goal, payload = {}) {
  const files = goalWorkspaceFiles(goal);
  const internal = {
    context_json: files.context_json,
    transcript_md: files.transcript_md,
    payload_json: files.payload_json,
    payload_base64: files.payload_base64
  };
  if (hasGoalBundles(payload)) internal.attachments_dir = files.attachments_dir;
  return internal;
}

function hasGoalBundles(payload = {}) {
  return Array.isArray(payload.bundles) && payload.bundles.some((bundle) => bundle?.zip_base64);
}

async function waitForTaskExecution(store, task, waitMs = 0) {
  const boundedWaitMs = Math.max(0, Math.min(Number(waitMs) || 0, 300000));
  const deadline = Date.now() + boundedWaitMs;
  let snapshot = await taskExecutionSnapshot(store, task);
  while (boundedWaitMs > 0 && snapshot.task && !isTaskTerminal(snapshot.task) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(25, deadline - Date.now()))));
    snapshot = await taskExecutionSnapshot(store, task);
  }
  return snapshot;
}

async function taskExecutionSnapshot(store, task) {
  const state = await store.load();
  const freshTask = task?.id ? state.tasks.find((item) => item.id === task.id) || task : null;
  const goal = freshTask?.goal_id
    ? state.goals?.find((item) => item.id === freshTask.goal_id) || null
    : state.goals?.find((item) => item.task_id === freshTask?.id) || null;
  const conversation = goal?.conversation_id ? state.conversations?.find((item) => item.id === goal.conversation_id) || null : null;
  const messages = conversation?.messages || [];
  return {
    status: freshTask?.status || goal?.status || "open",
    task: freshTask,
    goal_status: goal?.status || null,
    result: freshTask?.result || null,
    messages_tail: messages.slice(-5)
  };
}

function isTaskTerminal(task) {
  return ["completed", "failed", "waiting_for_review", "cancelled"].includes(task?.status);
}

async function updateGoalStatus(store, goalId, status, updatedAt = new Date().toISOString()) {
  const state = await store.load();
  ensureGoalState(state);
  const goal = state.goals.find((item) => item.id === goalId);
  if (!goal) return null;
  goal.status = status;
  goal.updated_at = updatedAt;
  state.activities.push({ time: updatedAt, type: `goal.${status}`, goal_id: goal.id, title: goal.title });
  await store.save();
  return goal;
}

async function writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, extras = {}, context = defaultTokenContext("system")) {
  const workspaceFiles = goalWorkspaceFiles(goal);
  const payload = extras.payload || {
    user_request: goal.user_request,
    goal_prompt: goal.goal_prompt,
    context_summary: goal.context_summary,
    mode: goal.mode,
    workspace_id: goal.workspace_id,
    messages: conversation?.messages || [],
    memories
  };
  const payloadJson = JSON.stringify(payload, null, 2);
  const payloadBase64 = extras.payload_base64 || Buffer.from(payloadJson, "utf8").toString("base64");
  const files = [
    { path: workspaceFiles.goal_md, content: renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) },
    { path: workspaceFiles.context_json, content: JSON.stringify({ goal, conversation, memories, task, workspace_files: workspaceFiles, codex_instruction: codexInstruction(goal) }, null, 2) },
    { path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) },
    { path: workspaceFiles.payload_json, content: payloadJson },
    { path: workspaceFiles.payload_base64, content: payloadBase64 }
  ];
  if (extras.initialize_result || typeof extras.result_content === "string") {
    files.push({ path: workspaceFiles.result_md, content: typeof extras.result_content === "string" ? extras.result_content : "# Result\n\nPending.\n" });
  }
  for (const file of files) {
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, file.path, file.content, context);
  }
  for (const bundle of Array.isArray(extras.bundles) ? extras.bundles : []) {
    if (!bundle?.zip_base64) continue;
    const name = safeBundleName(bundle.name || `bundle-${randomUUID()}.zip`);
    const zipPath = `${workspaceFiles.attachments_dir}/${name}`;
    await workspaceUploadBundleBase64(store, config, { path: zipPath, zip_base64: bundle.zip_base64, overwrite: true, extract: true, target_dir: `${workspaceFiles.attachments_dir}/${name.replace(/\.zip$/i, "")}`, sha256_expected: bundle.sha256, workspace_id: goal.workspace_id }, context);
  }
  return workspaceFiles;
}

async function writeWorkspaceTextInternal(store, config, workspaceId, path, content, context) {
  return workspaceWriteText(store, config, { path, content, overwrite: true, workspace_id: workspaceId }, context);
}

function renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) {
  return [
    `# GPTWork Goal ${goal.id}`,
    "",
    `Title: ${goal.title}`,
    `Status: ${goal.status}`,
    `Mode: ${goal.mode}`,
    `Workspace: ${goal.workspace_id}`,
    task ? `Task: ${task.id}` : "Task: none",
    "",
    "## User Request",
    "",
    goal.user_request || "(none)",
    "",
    "## GPTChat Preview",
    "",
    goal.preview_text || "(none)",
    "",
    "## Goal Prompt",
    "",
    goal.goal_prompt || "(none)",
    "",
    "## Context Summary",
    "",
    goal.context_summary || "(none)",
    "",
    "## Workspace Files",
    "",
    `- context: ${workspaceFiles.context_json}`,
    `- transcript: ${workspaceFiles.transcript_md}`,
    `- result: ${workspaceFiles.result_md}`,
    "",
    "## Memories",
    "",
    ...(memories.length ? memories.map((memory) => `- ${memory.key}: ${memory.value}`) : ["(none)"]),
    "",
    "## Execution Contract",
    "",
    "Read context.json and transcript.md before acting. Execute the goal prompt, update result.md, and append progress with append_goal_message."
  ].join("\n");
}

function renderTranscriptMarkdown(goal, conversation) {
  const messages = conversation?.messages || [];
  return [
    `# Transcript for ${goal.id}`,
    "",
    ...messages.flatMap((message) => [
      `## ${message.role} - ${message.created_at}`,
      "",
      message.content || "",
      ""
    ])
  ].join("\n");
}

function codexInstruction(goal) {
  const files = goalWorkspaceFiles(goal);
  return [
    "You are executing a GPTWork encoded/shared goal.",
    `Read ${files.goal_md}, ${files.context_json}, and ${files.transcript_md} before acting.`,
    "Follow goal.md exactly, write result.md, and append progress/results with append_goal_message."
  ].join("\n");
}

function safeBundleName(name) {
  return basename(String(name || "bundle.zip")).replace(/[^A-Za-z0-9._-]/g, "_") || "bundle.zip";
}

function buildGoalTask(goal, conversation, createdBy) {
  const now = goal.created_at;
  return {
    id: `task_${randomUUID()}`,
    project_id: goal.project_id,
    workspace_id: goal.workspace_id,
    goal_id: goal.id,
    conversation_id: conversation.id,
    title: goal.title,
    description: [
      `Goal ID: ${goal.id}`,
      `Conversation ID: ${conversation.id}`,
      `Mode: ${goal.mode}`,
      "",
      "User Request:",
      goal.user_request,
      "",
      "Goal Prompt:",
      goal.goal_prompt,
      "",
      "Context Summary:",
      goal.context_summary || "(none)",
      "",
      "Before acting, call get_goal_context with this goal_id and append progress with append_goal_message."
    ].join("\n"),
    created_by: createdBy,
    assignee: "codex",
    status: "assigned",
    mode: goal.mode,
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
}

function titleFromGoal(args) {
  const source = String(args.user_request || args.goal_prompt || "Codex goal").replace(/\s+/g, " ").trim();
  return source.length > 80 ? `${source.slice(0, 77)}...` : source || "Codex goal";
}

function normalizeGoalMessages(messages, now, userId) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => message && message.content).map((message) => normalizeGoalMessage(message, now, userId));
}

function normalizeGoalMessage(message, now, userId) {
  const role = String(message.role || "user").trim().toLowerCase();
  const allowedRoles = new Set(["user", "assistant", "chatgpt", "codex", "system", "tool"]);
  return {
    id: `msg_${randomUUID()}`,
    role: allowedRoles.has(role) ? role : "user",
    content: String(message.content || ""),
    author_id: message.author_id || userId,
    created_at: message.created_at || now
  };
}

function normalizeGoalMemories(memories, goalId, conversationId, now, userId) {
  if (!Array.isArray(memories)) return [];
  return memories.filter((memory) => memory && (memory.key || memory.value)).map((memory) => normalizeGoalMemory(memory, goalId, conversationId, now, userId));
}

function normalizeGoalMemory(memory, goalId, conversationId, now, userId) {
  return {
    id: `mem_${randomUUID()}`,
    goal_id: goalId,
    conversation_id: conversationId,
    key: String(memory.key || "note"),
    value: String(memory.value || ""),
    created_by: memory.created_by || userId,
    created_at: memory.created_at || now
  };
}

function normalizeCreatedTaskMode(args) {
  const mode = String(args.mode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode && !allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
  if (mode === "readonly") {
    return isCodexSessionInventoryTaskKind({
      title: args.title,
      description: args.description || "",
      assignee: "codex",
      status: "assigned",
      mode: "readonly"
    }) ? "readonly" : "builder";
  }
  return mode || "builder";
}

function normalizeAssignedTaskMode(task, requestedMode = "") {
  const mode = String(requestedMode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode) {
    if (!allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
    if (mode === "readonly" && !isCodexSessionInventoryTaskKind({ ...task, assignee: "codex", mode: "readonly" })) return "builder";
    return mode;
  }
  if (isCodexSessionInventoryTaskKind({ ...task, assignee: "codex" })) return "readonly";
  return task.mode && task.mode !== "readonly" ? task.mode : "builder";
}

async function listCodexSessionsMetadata(config, { year = "", month = "", day = "", limit = 50 }, context) {
  requireScope(context, "workspace:read");
  const sessionsRoot = join(config.codexHome, ".codex", "sessions");
  const parts = [year, month, day].filter(Boolean).map(validateDateSegment);
  const targetRoot = join(sessionsRoot, ...parts);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  const sessions = [];

  async function walk(dir) {
    if (sessions.length >= maxItems) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sessions.length >= maxItems) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const item = await stat(child);
        sessions.push({
          name: entry.name,
          relative_path: relative(sessionsRoot, child).replaceAll("\\", "/"),
          size: item.size,
          modified_at: item.mtime.toISOString()
        });
      }
    }
  }

  await walk(targetRoot);
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { root: sessionsRoot, target: relative(sessionsRoot, targetRoot).replaceAll("\\", "/") || ".", count: sessions.length, limit: maxItems, sessions };
}

function validateDateSegment(value) {
  const text = String(value || "").trim();
  if (!/^\d{2,4}$/.test(text)) throw new Error("invalid date segment");
  return text;
}

async function createCodexSessionInventoryTask(store, config, { limit = 50 } = {}, context = defaultTokenContext("system")) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const result = await createTask(store, config, {
    title: "List Codex session metadata",
    description: [
      "List Codex session file metadata under /home/a9017/.codex/sessions only.",
      `Return at most ${boundedLimit} files with relative_path, size, and modified_at.`,
      "Do not read session file contents.",
      "Do not inspect tokens, configs, cookies, cache files, memories, or shell snapshots."
    ].join("\n"),
    assignee: "codex",
    mode: "readonly"
  }, context);
  result.task.status = "assigned";
  result.task.updated_at = new Date().toISOString();
  const state = await store.load();
  state.activities.push({ time: result.task.updated_at, type: "task.assigned_codex", task_id: result.task.id, title: result.task.title });
  await store.save();
  return result;
}

async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  const state = await store.load();
  await normalizeLegacyModes(store, state);
  const candidates = state.tasks
    .filter((task) => task.assignee === "codex" && (task.status === "assigned" || task.status === "queued"  || task.status === "waiting_for_lock") && canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id))
    .slice(0, maxTasks);


  const results = await mapConcurrent(candidates, maxConcurrency, async (task) => {
    // Auto-promote queued tasks to assigned
    if (task.status === "queued" ) {
      await updateTask(store, task.id, (t) => { t.status = "assigned"; if (!t.assignee) t.assignee = "codex"; t.logs.push({ time: new Date().toISOString(), message: `[worker] auto-assigned from ${task.status}` }); });
      task.status = "assigned";
    }
    if (isCodexSessionInventoryTask(task)) {
      const completed = await completeCodexSessionInventoryTask(store, config, github, task, context);
      return { task_id: completed.task.id, status: completed.task.status, kind: completed.task.result?.kind || "unknown", count: completed.task.result?.sessions?.count ?? 0 };
    }
    if (task.mode === "builder" || task.mode === "deploy" || task.mode === "admin") {
      return await processGeneralTask(store, config, task, context);
    }
    return { task_id: task.id, status: task.status, skipped: true, reason: "no safe built-in handler for this assigned task" };
  });

  return {
    ok: true,
    inspected: candidates.length,
    concurrency: maxConcurrency,
    completed: results.filter((item) => item.status === "completed").length,
    skipped: results.filter((item) => item.skipped).length,
    tasks: results
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isCodexSessionInventoryTask(task) {
  return task?.assignee === "codex"
    && task?.status === "assigned"
    && task?.mode === "readonly"
    && isCodexSessionInventoryTaskKind(task);
}

function isCodexSessionInventoryTaskKind(task) {
  return task?.assignee === "codex"
    && /Codex session metadata/i.test(task?.title || "")
    && /Do not read session file contents/i.test(task?.description || "");
}

async function completeCodexSessionInventoryTask(store, config, github, task, context) {
  const boundedLimit = extractTaskLimit(task.description, 50);
  const sessions = await listCodexSessionsMetadata(config, { limit: boundedLimit }, context);
  const now = new Date().toISOString();
  const result = await updateTask(store, task.id, (item) => {
    item.status = "completed";
    item.result = {
      kind: "codex_session_inventory",
      summary: `Listed ${sessions.count} Codex session metadata entries without reading session contents.`,
      sessions,
      completed_at: now
    };
    item.logs.push({ time: now, message: `Safe Codex worker completed session metadata inventory: ${sessions.count} files.` });
  });
  github.syncTask(result.task).catch(() => {});
  return result;
}

async function processGeneralTask(store, config, task, context) {
  const now = new Date().toISOString();
  await updateTask(store, task.id, (item) => {
    item.logs.push({ time: now, message: `[worker] started: ${task.title}` });
  });

  const workspace = await selectWorkspace(store, task.workspace_id, context);
  if (workspace.type !== "hosted") {
    await updateTask(store, task.id, (item) => {
      item.logs.push({ time: new Date().toISOString(), message: `[worker] skipped: unsupported workspace type ${workspace.type}` });
    });
    return { task_id: task.id, status: task.status, skipped: true, reason: `unsupported workspace type: ${workspace.type}` };
  }
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: true });
  const goal = linked.goal;
  const conversation = linked.conversation;
  const memories = linked.memories || [];
  const workspaceFiles = linked.workspace_files || goalWorkspaceFiles(goal);
  if (goal) {
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Starting Codex execution for task ${task.id}. Reading ${workspaceFiles.goal_md}.`
    }, context);
  }
  // Clear any previous repo lock blocking metadata if this is a retry
  await updateTask(store, task.id, (item) => {
    delete item.lock_blocked_at;
    delete item.lock_blocked_by;
  });
  // Acquire repo lock to prevent concurrent same-repo Codex execution
  const _repoLockPath = config.defaultRepoPath;
  if (_repoLockPath) {
    const _lockResult = await acquireRepoLock(config.defaultWorkspaceRoot, _repoLockPath, {
      taskId: task.id,
      runId: null,
      mode: task.mode || "builder"
    });
    if (!_lockResult.acquired) {
      const _lockMsg = "[worker] repo locked by task " + _lockResult.heldByTask + ", retry after completion. Skipping.";
      await updateTask(store, task.id, function(item) {
        item.status = "waiting_for_lock";
        item.lock_blocked_at = new Date().toISOString();
        item.lock_blocked_by = _lockResult.heldByTask;
        item.logs.push({ time: new Date().toISOString(), message: _lockMsg });
      });
      if (goal) {
        await appendGoalMessage(store, config, {
          goal_id: goal.id,
          role: "codex",
          content: _lockMsg
        }, context);
      }
      return { task_id: task.id, status: "waiting_for_lock", skipped: true, reason: _lockMsg };
    }
  }
  // Mark as running to prevent duplicate processing by subsequent ticks
  await updateTask(store, task.id, (item) => {
    item.status = "running";
    item.logs.push({ time: new Date().toISOString(), message: "[worker] codex exec started" });
  });

  const mode = task.mode || "builder";
  const promptFile = `/tmp/.gptwork-task-${task.id}.txt`;
  const separator = "=".repeat(60);
  const fullPrompt = `# Task: ${task.title}

${task.description || ""}

${goal ? `# GPTWork Goal Context

You are executing a GPTWork encoded/shared goal.

Read these files before acting:
- ${workspaceFiles.goal_md}
- ${workspaceFiles.context_json}
- .gptwork/project.md (if present — project-level context)
- .gptwork/project.env (if present — project-level env vars, do not commit or print secrets)

Follow ${workspaceFiles.goal_md} exactly.
Use ${workspaceFiles.context_json} only for metadata you need.
Do not dump or re-read ${workspaceFiles.transcript_md} unless the goal explicitly requires prior conversation details.

Write final results to ${workspaceFiles.result_md}.
When complete, write a concise structured report in TWO formats:

1. result.json — write to the task workspace directory with this exact structure:
   {
     "status": "completed|failed|timed_out",
     "summary": "one-line summary",
     "changed_files": ["path/to/file1.js", "path/to/file2.js"],
     "tests": "npm test: passed 15/15",
     "commit": "sha256",
     "remote_head": "sha256",
     "warnings": ["warning text"],
     "followups": ["follow-up item"]
   }

2. Stdout structured report (legacy, still read):
   STATUS=<completed|failed|timed_out>
   SUMMARY=<one line>
   CHANGED_FILES=<comma separated or none>
   TESTS=<commands and pass/fail or none>
   COMMIT=<sha or none>
   REMOTE_HEAD=<sha or none>

GPTWork will read result.json first when available, falling back to the stdout report.` : ""}
${separator}
${separator}
## Safe Restart Rule
If you need to restart the gptwork-mcp.service (the service running this worker), you MUST NOT run "systemctl --user restart gptwork-mcp.service" directly inline for a self-restart. Doing so will kill the worker before the task can complete, causing the task to get stuck.
Instead:
1. Write result.json with your final result first.
2. Call schedule_service_restart with your task_id, expected_commit (the HEAD you committed/pushed), and optional expected_remote_head.
3. The tool safely writes a pending restart marker and schedules the restart detached from the current request.
4. The actual service restart happens ~2 seconds later, giving time for the current response to return cleanly.
5. After restart, GPTWork detects the marker, verifies the running commit equals the expected_commit, and finalizes your task.


${separator}
Execute the EXACT steps above, in order. Do not skip, substitute, or improvise.
Use ${workspace.root} as the base directory for all file operations.
The canonical repository is at ${config.defaultRepoPath || "(not configured)"}.
Project context files (.gptwork/project.md, .gptwork/project.env) live under the canonical repo.

Write result.json to ${workspace.root}/.gptwork/goals/${goal ? goal.id : task.id}/result.json

After completing ALL steps, also output the structured report to stdout (legacy format):
STATUS=<completed|failed|timed_out>
SUMMARY=<one line>
CHANGED_FILES=<comma separated or none>
TESTS=<commands and pass/fail or none>
COMMIT=<sha or none>
REMOTE_HEAD=<sha or none>
${separator}`;
  await writeFile(promptFile, fullPrompt, "utf8");
  let summary = "";
  let parsedResult = null;
  let cr = null;
  
  // Initialize run metadata for diagnostics
  let runFilePath = null;
  let runId = null;
  try {
    const initResult = await initRun({
      workspaceRoot: config.defaultWorkspaceRoot,
      taskId: task.id,
      workspaceId: task.workspace_id,
      repoPath: config.defaultRepoPath,
      promptPath: promptFile
    });
    runFilePath = initResult.runFilePath;
    runId = initResult.runId;
    fireHeartbeat(runFilePath, "running_codex");
  } catch (e) {
    // Non-fatal: run metadata setup failed
  }
  
  try {
    const cmd = "codex exec " + config.codexExecArgs + " < " + promptFile;
    cr = await runLocalShell(cmd, workspace.root, config.codexExecTimeout, 1000000, (pid) => {
      updateRunHeartbeat(runFilePath, "running_codex", { codex_child_pid: pid }).catch(() => {});
    });
    
    // Write stdout/stderr to durable log files
    if (cr && runId) {
      writeRunLogs({ workspaceRoot: config.defaultWorkspaceRoot, taskId: task.id, runId, stdout: cr.stdout, stderr: cr.stderr }).catch(() => {});
    }
    
    // Heartbeat after Codex exits
    if (runFilePath) {
      fireHeartbeat(runFilePath, "parsing_result", {
        exit_code: cr?.returncode ?? -1,
        timed_out: cr?.timed_out || false
      });
    }
    
    const out = (cr.stdout || "").trim();
    // Try result.json first, fall back to stdout parsing
    const resultJsonPath = workspace.root + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json";
    parsedResult = await parseCodexResultWithFallback({ resultJsonPath, stdout: out });
    if (parsedResult.summary) {
      summary = parsedResult.summary;
    } else {
      if (out) {
        const hdr = out.indexOf(separator);
        summary = hdr >= 0 ? out.substring(hdr) : out;
      }
      if (!summary && cr.stderr) summary = (cr.stderr || "").trim().slice(0, 10000);
    }
  } catch (e) {
    summary = "[ERROR] " + e.message;
  } finally {
    try { await rm(promptFile, { force: true }); } catch {}
  }
 if (!summary) summary = "Task completed (no output captured)";

  const timedOut = cr?.timed_out || false;
  if (parsedResult && parsedResult.structured && parsedResult.status === "completed" && cr && cr.returncode !== 0) {
    parsedResult.status = "failed";
  }
  const taskResult = parsedResult
    ? buildTaskResult(parsedResult, { timedOut, timeoutSeconds: config.codexExecTimeout, returnCode: cr?.returncode ?? 0 })
    : {
        kind: timedOut ? "codex_timeout" : "codex_failed",
        summary,
        completed_at: new Date().toISOString(),
        ...(timedOut ? { timed_out: true, timeout_seconds: config.codexExecTimeout } : { timed_out: false })
      };

  const doneAt = new Date().toISOString();
  const taskStatus = taskResult.kind === "codex_executed" ? "completed"
    : taskResult.kind === "codex_timeout" ? "timed_out"
    : "failed";

  // Update run metadata with final phase
  if (runFilePath) {
    const resultJsonPath = workspace.root + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json";
    fireHeartbeat(runFilePath, taskStatus === "completed" ? "completed" : "failed", {
      result_json_path: resultJsonPath,
      exit_code: cr?.returncode ?? -1,
      timed_out: cr?.timed_out || false
    });
  }

  const result = await updateTask(store, task.id, (item) => {
    item.status = taskStatus;
    item.result = { ...taskResult, completed_at: doneAt };
    item.logs.push({ time: doneAt, message: taskResult.kind === "codex_timeout"
      ? "[worker] timed out after " + config.codexExecTimeout + "s"
      : "[worker] completed: task processed by Codex CLI" });
  });

  // Release repo lock after Codex execution completes
  if (_repoLockPath) {
    // Check if task scheduled a safe-restart — keep lock during restart window
    let _keptForRestart = false;
    try {
      const _rm = await loadRestartMarker(config.defaultWorkspaceRoot, task.id);
      if (_rm && ["pending", "scheduled", "restarted"].includes(_rm.status)) {
        await releaseRepoLock(config.defaultWorkspaceRoot, _repoLockPath, task.id, {
          restartState: "scheduled"
        });
        _keptForRestart = true;
      }
    } catch {}
    if (!_keptForRestart) {
      await releaseRepoLock(config.defaultWorkspaceRoot, _repoLockPath, task.id);
    }
  }
  if (goal) {
    const goalStatus = taskStatus === "timed_out" ? "failed" : taskStatus;
    await updateGoalStatus(store, goal.id, goalStatus, doneAt);
    const statusLabel = taskStatus === "timed_out" ? "Timed out" : "Completed";
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, workspaceFiles.result_md,
      "# Result\n\n" + summary + "\n\n" + statusLabel + " at: " + doneAt + "\n", context);
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: "[worker] " + statusLabel + " task " + task.id + ".\n\n" + summary,
      memory_key: "codex_last_result",
      memory_value: summary.slice(0, 4000)
    }, context);
  }
  try { github.syncTask(result.task).catch(() => {}); } catch {}
  return { task_id: result.task.id, status: taskStatus, kind: taskResult.kind };
}
function emitTaskProgress(context, task, phase, message) {
  context.emitProgress?.({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      level: "info",
      logger: "gptwork.codex_worker",
      data: {
        phase,
        task_id: task.id,
        title: task.title,
        status: task.status,
        message
      }
    }
  });
}

function extractTaskLimit(description = "", fallback = 50) {
  const match = String(description).match(/Return at most\s+(\d+)\s+files/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(Number(match[1]) || fallback, 200));
}

async function findTask(store, task_id) {
  const state = await store.load();
  await normalizeLegacyModes(store, state);
  const task = state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  return task;
}

async function normalizeLegacyModes(store, state) {
  let changed = false;
  for (const task of state.tasks || []) {
    if (task.mode === "readonly" && !isCodexSessionInventoryTaskKind(task)) {
      task.mode = "builder";
      task.updated_at = task.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  for (const goal of state.goals || []) {
    if (goal.mode === "readonly") {
      goal.mode = "builder";
      goal.updated_at = goal.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await store.save();
}

async function updateTask(store, task_id, updater) {
  const state = await store.load();
  const task = state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  updater(task);
  task.updated_at = new Date().toISOString();
  state.activities.push({ time: task.updated_at, type: "task.updated", task_id, status: task.status });
  
    // Use shared notification helper for terminal task states (deduplicated per task/status/channel)
  await notifyTerminalTaskIfNeeded(task);
await store.save();
  return { task };
}


async function notifyTerminalTaskIfNeeded(task) {
  if (!barkNotifier || !barkNotifier.isEnabled()) return;
  // Only notify for true terminal or human-review states.
  // Transient states such as waiting_for_lock (repo-lock block) are intentionally
  // excluded from the terminal list, so they never send a notification directly.
  // If a task later reaches a terminal failure or human-review state due to a lock
  // issue, that notification will be about the actual terminal/resolution state.
  const terminal = ["completed", "failed", "cancelled", "timed_out", "codex_timeout", "waiting_for_review", "waiting_review"];
  const channelKey = `notified:bark:${task.status}`;
  if (!terminal.includes(task.status) || task[channelKey]) return;

  const classification = classifyNotification(task);
  if (!classification.should_notify) {
    task.last_notification_policy = classification.reason;
    return;
  }

  try {
    const { title, body } = formatNotification(task, task.status);
    const nres = await barkNotifier.send(title, body, `task-${task.status}`);
    if (nres.ok) {
      task[channelKey] = true;
      task.notified_at = new Date().toISOString();
      // Track safe task metadata on the barkNotifier diagnostics
      if (barkNotifier._setTaskMetadata) {
        barkNotifier._setTaskMetadata(task.id, task.status, task.status);
      }
    }
    task.notifications ||= [];
    task.notifications.push({
      channel: "bark",
      event: nres.ok ? "sent" : "failed",
      attempted_at: new Date().toISOString(),
      ok: nres.ok,
      response_code: nres.ok ? 200 : null,
      response_message: nres.ok ? (nres.bark_id || "ok") : null,
      error_short: nres.ok ? null : (nres.reason || nres.error || null),
      source: (barkNotifier.getStatus ? barkNotifier.getStatus().source : null) || "unknown",
      group: (barkNotifier.getStatus ? barkNotifier.getStatus().group : null) || "gptwork",
      endpoint_kind: (() => {
        const st = barkNotifier.getStatus ? barkNotifier.getStatus() : {};
        return st.url_set ? "url" : st.key_set ? "key" : "none";
      })(),
      icon_set: (barkNotifier.getStatus ? barkNotifier.getStatus().icon_set : false) || false,
      url_action_set: (barkNotifier.getStatus ? barkNotifier.getStatus().url_action_set : false) || false
    });
  } catch {
    // notification failure is non-critical
  }
}

/**
 * Send a Bark notification for a newly created/assigned task.
 * Deduplicated (one `created` notification per task) and policy-gated.
 * Suppressed for draft tasks, readonly/internal/test mode tasks by default.
 */
async function notifyCreatedTaskIfNeeded(task) {
  if (!barkNotifier || !barkNotifier.isEnabled()) return;
  const channelKey = 'notified:bark:created';
  if (task[channelKey]) return;

  const classification = classifyCreatedNotification(task);
  if (!classification.should_notify) {
    task.last_notification_policy = classification.reason;
    return;
  }

  try {
    const { title, body } = formatCreatedNotification(task);
    const nres = await barkNotifier.send(title, body, 'task-created');
    if (nres.ok) {
      task[channelKey] = true;
      task.notified_at = new Date().toISOString();
      // Track safe task metadata on the barkNotifier diagnostics
      if (barkNotifier._setTaskMetadata) {
        barkNotifier._setTaskMetadata(task.id, task.status, task.status);
      }
    }
    // Track safe task metadata on the barkNotifier diagnostics
    if (barkNotifier._setTaskMetadata) {
      barkNotifier._setTaskMetadata(task.id, task.status, 'created');
    }
    task.notifications ||= [];
    task.notifications.push({
      channel: "bark",
      event: nres.ok ? "sent" : "failed",
      attempted_at: new Date().toISOString(),
      ok: nres.ok,
      response_code: nres.ok ? 200 : null,
      response_message: nres.ok ? (nres.bark_id || "ok") : null,
      error_short: nres.ok ? null : (nres.reason || nres.error || null),
      source: (barkNotifier.getStatus ? barkNotifier.getStatus().source : null) || "unknown",
      group: (barkNotifier.getStatus ? barkNotifier.getStatus().group : null) || "gptwork",
      endpoint_kind: (() => {
        const st = barkNotifier.getStatus ? barkNotifier.getStatus() : {};
        return st.url_set ? "url" : st.key_set ? "key" : "none";
      })(),
      icon_set: (barkNotifier.getStatus ? barkNotifier.getStatus().icon_set : false) || false,
      url_action_set: (barkNotifier.getStatus ? barkNotifier.getStatus().url_action_set : false) || false
    });
  } catch {
    // notification failure is non-critical
  }
}


async function createChatGptRequest(store, args) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const now = new Date().toISOString();
  const request = {
    id: `chatreq_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    task_id: args.task_id || null,
    title: args.title,
    prompt: args.prompt,
    source: args.source || "codex",
    status: "open",
    response: "",
    created_at: now,
    updated_at: now
  };
  state.chatgpt_requests.push(request);
  state.activities.push({ time: now, type: "chatgpt_request.created", request_id: request.id, title: request.title });
  await store.save();
  return { request };
}

async function findChatGptRequest(store, request_id) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  return request;
}

async function updateChatGptRequest(store, request_id, updater) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  updater(request);
  request.updated_at = new Date().toISOString();
  state.activities.push({ time: request.updated_at, type: "chatgpt_request.updated", request_id, status: request.status });
  await store.save();
  return { request };
}

async function resolvePath(store, config, args, context) {
  const workspace = await selectWorkspace(store, args.workspace_id, context);
  if (workspace.type === "ssh") {
    const base = workspace.root.replace(/\/+$/, "");
    const target = String(args.path || ".").replace(/\\/g, "/");
    const safePath = (base + "/" + (target === "." ? "" : target)).replace(/\/+/g, "/");
    if (!safePath.startsWith(base)) throw new Error("path is outside workspace root: " + target);
    return { workspace, path: safePath };
  }
  const resolved = await resolveWorkspacePath(workspace.root, args.path || ".");
  return { workspace, path: resolved.absolutePath };
}

async function workspaceListDir(store, config, { path = ".", recursive = false, limit = 500, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const raw = await sshListDir(workspace, path, 15);
    // Parse ls -la output into structured items for consistency with hosted
    const items = [];
    for (const line of (raw.stdout || "").split("\n")) {
      if (items.length >= limit) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("total ") || trimmed.startsWith("d********")) continue;
      // Parse typical ls -la line: permissions links owner group size date name
      const parts = trimmed.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;
      const type = parts[0].startsWith("d") ? "directory" : "file";
      const size = parseInt(parts[4], 10) || 0;
      items.push({ path: name, name, type, size, modified_at: parts[5] + " " + parts[6] + " " + parts[7] });
    }
    return { path, recursive, count: items.length, limit, items, raw: { returncode: raw.returncode, stdout: raw.stdout, stderr: raw.stderr } };
  }
  const items = [];
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (items.length >= limit) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      const childStat = await stat(childAbs);
      items.push({ path: childRel, name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: childStat.size, modified_at: childStat.mtime.toISOString() });
      if (recursive && entry.isDirectory()) await walk(childAbs, childRel);
    }
  }
  await walk(resolvedPath, path);
  return { path, recursive, count: items.length, limit, items };
}

async function workspaceStat(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshStat(workspace, resolvedPath, 10);
  const item = await stat(resolvedPath);
  return { path: args.path, type: item.isDirectory() ? "directory" : "file", size: item.size, modified_at: item.mtime.toISOString() };
}

async function workspaceReadText(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshReadTextFile(workspace, resolvedPath, 15);
    const max = max_bytes || config.maxReadBytes;
    return { path, size: result.stdout.length, truncated: Buffer.byteLength(result.stdout) > max, content: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content: bytes.subarray(0, max).toString("utf8") };
}

async function workspaceDownloadBase64(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "files:download");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshDownloadBase64(workspace, resolvedPath, 30);
    const max = max_bytes || config.maxReadBytes;
    return { path, truncated: result.stdout.length > max, content_base64: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content_base64: bytes.subarray(0, max).toString("base64") };
}

async function workspaceWriteText(store, config, { path, content, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshWriteTextFile(workspace, resolvedPath, content, 30);
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content, "utf8");
  return { ok: true, path, size: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) };
}

async function workspaceUploadBase64(store, config, { path, content_base64, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshUploadBase64(workspace, resolvedPath, content_base64, 60);
  const content = Buffer.from(content_base64, "base64");
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content);
  return { ok: true, path, size: content.length, sha256: sha256(content) };
}

async function workspaceUploadFromUrl(store, config, { url, path, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const response = await fetch(url);
  if (!response.ok) throw new Error("download failed: " + response.status);
  const content = Buffer.from(await response.arrayBuffer());
  return workspaceUploadBase64(store, config, { path, content_base64: content.toString("base64"), overwrite, workspace_id }, context);
}

async function workspaceUploadBundleBase64(store, config, { path, zip_base64, overwrite = false, extract = false, target_dir = "", sha256_expected = "", workspace_id }, context) {
  requireScope(context, "files:upload");
  const uploaded = await workspaceUploadBase64(store, config, { path, content_base64: zip_base64, overwrite, workspace_id }, context);
  if (sha256_expected && uploaded.sha256 !== sha256_expected) throw new Error(`bundle sha256 mismatch: expected ${sha256_expected}, got ${uploaded.sha256}`);
  let extracted = null;
  if (extract) {
    extracted = await workspaceShellZip(store, config, "extract", { zip_path: path, target_dir: target_dir || dirname(path), workspace_id }, context);
  }
  return { ok: true, path, size: uploaded.size, sha256: uploaded.sha256, extracted };
}

async function workspaceDownloadBundleBase64(store, config, { source_dir = "", paths = [], workspace_id }, context) {
  requireScope(context, "files:download");
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "ssh") throw new Error("download_bundle_base64 currently supports hosted workspaces only");
  const tmpRoot = await mkdtemp(join(tmpdir(), "gptwork-bundle-"));
  const bundlePath = join(tmpRoot, "bundle.zip");
  const source = source_dir || ".";
  if (Array.isArray(paths) && paths.length) {
    const staging = join(tmpRoot, "staging");
    await mkdir(staging, { recursive: true });
    for (const item of paths) {
      const resolved = await resolveWorkspacePath(workspace.root, item);
      const target = join(staging, resolved.relativePath);
      await ensureParent(target);
      await cp(resolved.absolutePath, target, { recursive: true, force: true });
    }
    await runZipCommand("create", staging, bundlePath, config.pythonCommand);
  } else {
    const resolved = await resolveWorkspacePath(workspace.root, source);
    await runZipCommand("create", resolved.absolutePath, bundlePath, config.pythonCommand);
  }
  const bytes = await readFile(bundlePath);
  await rm(tmpRoot, { recursive: true, force: true });
  return { ok: true, source_dir: source, paths, size: bytes.length, sha256: sha256(bytes), zip_base64: bytes.toString("base64") };
}

async function workspaceMkdir(store, config, args, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshMkdir(workspace, resolvedPath, 10);
  await mkdir(resolvedPath, { recursive: true });
  return { ok: true, path: args.path };
}

async function workspaceDelete(store, config, { path, recursive = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshDelete(workspace, resolvedPath, recursive, 15);
  await rm(resolvedPath, { recursive, force: false });
  return { ok: true, deleted: path, permanent: true };
}

async function workspaceMove(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshMove(workspace, srcPath, dstPath, 15);
  if (!overwrite) {
    try {
      await stat(dstPath);
      throw new Error("destination exists: " + dst);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(dstPath);
  await rename(srcPath, dstPath);
  return { ok: true, src, dst };
}

async function workspaceCopy(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshCopy(workspace, srcPath, dstPath, 30);
  await ensureParent(dstPath);
  await cp(srcPath, dstPath, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  return { ok: true, src, dst };
}

async function workspaceSearch(store, config, { q, path = ".", limit = 50, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const raw = await sshSearchFiles(workspace, q, resolvedPath, 60, limit);
    const paths = (raw.stdout || "").trim().split("\n").filter(Boolean).slice(0, limit);
    const results = paths.map((p) => ({ path: p, matched_name: true, matched_content: true, snippet: "" }));
    return { q, path, count: results.length, results, raw: { returncode: raw.returncode, stdout: raw.stdout, stderr: raw.stderr } };
  }
  const results = [];
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else {
        const bytes = await readFile(childAbs);
        const text = bytes.toString("utf8");
        const matchedName = childRel.includes(q);
        const idx = text.indexOf(q);
        if (matchedName || idx !== -1) {
          results.push({ path: childRel, size: bytes.length, matched_name: matchedName, matched_content: idx !== -1, snippet: idx === -1 ? "" : text.slice(Math.max(0, idx - 40), idx + q.length + 40) });
        }
      }
    }
  }
  await walk(resolvedPath, path);
  return { q, path, count: results.length, results };
}

async function workspaceSha256(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") {
    const hash = await sshSha256(workspace, resolvedPath, 15);
    return { path: args.path, sha256: hash };
  }
  const bytes = await readFile(resolvedPath);
  return { path: args.path, size: bytes.length, sha256: sha256(bytes) };
}

async function workspaceShellExec(store, config, { command, cwd = ".", timeout, max_output_bytes, workspace_id }, context) {
  requireScope(context, "shell:exec");
  const workspace = await selectWorkspace(store, workspace_id, context);
  const sshCwd = cwd === "." ? "." : cwd.replace(/\\/g, "/");
  if (workspace.type === "ssh") return runSshExec(workspace, command, sshCwd, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
  const { path: resolvedPath } = await resolvePath(store, config, { path: cwd || ".", workspace_id }, context);
  await mkdir(resolvedPath, { recursive: true });
  return runLocalShell(command, resolvedPath, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
}

async function workspaceShellZip(store, config, mode, args, context) {
  const command = mode === "create"
    ? config.pythonCommand + " -m zipfile -c " + shellQuotee(args.zip_path) + " " + shellQuotee(args.source_dir)
    : config.pythonCommand + " -m zipfile -e " + shellQuotee(args.zip_path) + " " + shellQuotee(args.target_dir || ".");
  return workspaceShellExec(store, config, { command, cwd: ".", workspace_id: args.workspace_id }, context);
}

async function runZipCommand(mode, sourcePath, zipPath, pythonCommand = process.platform === "win32" ? "python" : "python3") {
  const command = mode === "create"
    ? pythonCommand + " -m zipfile -c " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath)
    : pythonCommand + " -m zipfile -e " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath);
  const result = await runLocalShell(command, dirname(zipPath), 60, 1000000);
  if (result.returncode !== 0) throw new Error(`zip command failed: ${result.stderr || result.stdout}`);
  return result;
}

function runLocalShell(command, cwd, timeout, maxOutputBytes, onChildSpawned) {
  return new Promise((resolve) => {
    const started = Date.now();
    const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
    const shellFlag = process.platform === "win32" ? "/c" : "-c";
    const maxBuf = Number(maxOutputBytes) || 1048576;

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: maxBuf
    });

    if (onChildSpawned) {
      onChildSpawned(child.pid);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on("data", (data) => {
      if (!stdoutTruncated) {
        stdout += data.toString();
        if (Buffer.byteLength(stdout) >= maxBuf) {
          stdoutTruncated = true;
          child.stdout.destroy();
        }
      }
    });

    child.stderr.on("data", (data) => {
      if (!stderrTruncated) {
        stderr += data.toString();
        if (Buffer.byteLength(stderr) >= maxBuf) {
          stderrTruncated = true;
          child.stderr.destroy();
        }
      }
    });

    const timeoutMs = timeout * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) {
          // Kill the entire process group
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {}
      // After short grace period, SIGKILL the process group
      setTimeout(() => {
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {}
      }, 3000);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        returncode: -1,
        stdout,
        stderr: stderr || err.message,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        returncode: code ?? -1,
        stdout,
        stderr,
        timed_out: timedOut || (signal === "SIGTERM" || signal === "SIGKILL"),
        duration_ms: Date.now() - started,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      });
    });

    child.stdin?.end();
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuotee(value) {
  if (process.platform === "win32") return `"${String(value).replaceAll('"', '\\"')}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function endJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(status === 204 ? "" : JSON.stringify(body));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
