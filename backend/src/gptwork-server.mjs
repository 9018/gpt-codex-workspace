import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { exec, execSync } from "node:child_process";
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
import { basename, dirname, join, relative } from "node:path";
import { StateStore } from "./state-store.mjs";
import { createBrowserRegistry } from "./browser-http.mjs";
import { buildSshExecCommand, runSshExec } from "./ssh-adapter.mjs";
import { createGithubSync } from "./github-adapter.mjs";
import { RepoRegistry, parseGitHubUrl, isTempClone, detectStaleTempClones } from "./repo-registry.mjs";
import { createBarkNotifier, classifyNotification, classifyCreatedNotification, formatNotification, formatCreatedNotification, formatManualTestNotification } from "./bark-notifier.mjs";
import { parseCodexResult, buildTaskResult, parseCodexResultWithFallback, parseResultJson, validateAutonomyResult, detectRuntimeCodeChanges } from "./codex-result-parser.mjs";
import { buildCodexContext, formatSize, loadProjectEnv, loadProjectMd } from "./codex-context-builder.mjs";
import { buildCodexPrompt } from "./codex-prompt-builder.mjs";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { buildRuntimeConfig } from "./runtime-config.mjs";
import { initRun, fireHeartbeat, writeRunLogs, updateRunHeartbeat, getLatestRun, getRunFilePath } from "./codex-run-metadata.mjs";
import { writePendingRestartMarker, loadRestartMarker, scanPendingRestartMarkers, scanPendingRestartMarkersSync, updateRestartMarkerStatus, verifyRestartMarker, scheduleServiceRestart, getPendingRestartsDir, validateWorkspaceRoot, scanMisplacedMarkersSync, migrateMisplacedMarker, getMisplacedMarkerDiagnostic, removeMisplacedMarker } from "./safe-restart.mjs";
import { acquireRepoLock, releaseRepoLock, reconcileRepoLocks, releaseLockForTask, getRepoLockSummary, listRepoLocks, safeRepoId, getLockFilePath } from "./repo-lock.mjs";
import {
  MCP_PROTOCOL_VERSION,
  schema, toolList, initializeResult, jsonResult, jsonError,
  endSse, setSseHeaders, writeSseMessage,
  setCors, endJson, readRequest,
} from "./mcp-tooling.mjs";
import {
  headersWithPathToken, tokenFromMcpPath,
  parseTokens, parseTokenContexts, normalizeTokenContexts,
  defaultTokenContext, defaultScopes, normalizeList,
  limits, assertAuthorized, selectWorkspace, findProject,
  canAccessProject, canAccessWorkspace,
  requireProjectAccess, requireWorkspaceAccess, requireScope
} from "./auth-context.mjs";
import { goalWorkspaceFiles, publicGoalWorkspaceFiles, internalGoalWorkspaceFiles, renderGoalMarkdown, renderTranscriptMarkdown, codexInstruction, safeBundleName } from "./goal-files.mjs";
import { isTaskTerminal, isCodexSessionInventoryTask, isCodexSessionInventoryTaskKind, extractTaskLimit } from "./task-status.mjs";
import { ensureGoalState, findGoalInState, taskPayloadFromTask, emitTaskProgress, normalizeLegacyModes, findTask, updateTask, updateGoalStatus, setTerminalNotifier } from "./task-lifecycle.mjs";
import { titleFromGoal, normalizeGoalMessage, normalizeGoalMessages, normalizeGoalMemory, normalizeGoalMemories } from "./goal-lifecycle.mjs";
import { resolvePath, workspaceWriteText, workspaceUploadBase64, workspaceUploadFromUrl, workspaceUploadBundleBase64, workspaceMkdir, workspaceDelete, workspaceMove, workspaceCopy, workspaceShellExec, workspaceShellZip, runZipCommand, runLocalShell, writeWorkspaceTextInternal } from "./workspace-service.mjs";

import { resolveRepoDir, determineBarkConfigSource, collectRuntimeGitInfo, collectRestartMarkerStatus, queryContextStatus } from "./diagnostics-service.mjs";
import { createWorkerState, markWorkerStarted, markWorkerTickStarted, recordWorkerTickSuccess, recordWorkerTickError, markWorkerTickFinished, workerStatusSnapshot } from "./codex-worker-state.mjs";
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
import { createRuntimeStatusToolsGroup } from "./tool-groups/runtime-status-tools-group.mjs";
import { createContextHealthToolsGroup } from "./tool-groups/context-health-tools-group.mjs";
import { createRepositoryToolsGroup } from "./tool-groups/repository-tools-group.mjs";
import { createWorkspaceReadToolsGroup } from "./tool-groups/workspace-read-tools-group.mjs";
import { createGitRemoteToolsGroup } from "./tool-groups/git-remote-tools-group.mjs";
import { applyOptionSourceOverrides, createServerContext } from "./server-context.mjs";
import { createTool } from "./tool-registry.mjs";
let barkNotifier = null;


const PROCESS_STARTED_AT = new Date();

// Process-level Codex worker state tracking.
// Populated by startCodexWorker; read by worker_status,
// runtime_status, and gptwork_doctor tools.
const workerState = createWorkerState();

async function collectWorkerQueueCounts(store) {
  try {
    const state = await store.load();
    const codexTasks = state.tasks.filter(t => t.assignee === "codex");
    return { assigned: codexTasks.filter(t => t.status === "assigned").length, queued: codexTasks.filter(t => t.status === "queued").length, running: codexTasks.filter(t => t.status === "running").length, waiting_for_lock: codexTasks.filter(t => t.status === "waiting_for_lock").length, waiting_for_review: codexTasks.filter(t => t.status === "waiting_for_review").length, completed: codexTasks.filter(t => t.status === "completed").length, failed: codexTasks.filter(t => t.status === "failed").length };
  } catch (e) {
    return { assigned: 0, queued: 0, running: 0, waiting_for_lock: 0, waiting_for_review: 0, completed: 0, failed: 0 };
  }
}


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
  const bark = createBarkNotifier(barkOptions, barkConfigSource); barkNotifier = bark;
  const serverContext = createServerContext({ config, store, browser, github, bark, barkConfigSource, envLoadResult, earlyEnvResult });
setTerminalNotifier(notifyTerminalTaskIfNeeded);
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
            // Phase A.1: Try result.json recovery before codex_stalled
            const goalId = task.goal_id;
            const resultJsonPath = goalId
              ? join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "result.json")
              : null;
            let recovered = false;
            if (resultJsonPath && existsSync(resultJsonPath)) {
              try {
                // Check if file contains valid JSON first
                const rawContent = readFileSync(resultJsonPath, "utf8");
                JSON.parse(rawContent);
                // Use parseResultJson for full contract validation
                const parsedResult = await parseResultJson(resultJsonPath);
                if (parsedResult && parsedResult.status) {
                  // Valid result.json found --- recover task
                  const taskResult = buildTaskResult(parsedResult, {});
                  const recoveredStatus = parsedResult.status === "completed" ? "completed"
                    : parsedResult.status === "failed" ? "failed"
                    : "waiting_for_review";
                  const prevRecoveryStatus = task.status;
                  task.status = recoveredStatus;
                  task.result = { ...(task.result || {}), ...taskResult };
                  task.result.reconciled_at = new Date().toISOString();
                  task.result.recovered_from_result_json = true;
                  task.logs = task.logs || [];
                  task.logs.push({ time: new Date().toISOString(), message: "[worker] recovered completed result from existing result.json before codex_stalled" });
                  // Update goal status
                  try { await updateGoalStatus(store, goalId, recoveredStatus, new Date().toISOString()); } catch {}
                  // Update run metadata if a run exists
                  if (run && run.run_id) {
                    try {
                      const runFp = getRunFilePath(config.defaultWorkspaceRoot, task.id, run.run_id);
                      if (existsSync(runFp)) {
                        fireHeartbeat(runFp, "completed", { result_json_path: resultJsonPath, phase: "completed" });
                      }
                    } catch {}
                  }
                  // Release repo lock
                  try { await releaseLockForTask(config.defaultWorkspaceRoot, task.id); } catch {}
                  try { await notifyTerminalTaskIfNeeded(task); } catch {}
                  reconciled.push({ task_id: task.id, previous_status: prevRecoveryStatus, new_status: recoveredStatus, message: "Recovered from existing result.json" });
                  if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} recovered from result.json -> ${recoveredStatus}
`);
                  recovered = true;
                } else {
                  // File exists but contract validation failed
                  throw new Error("result.json at " + resultJsonPath + " exists but does not match expected contract (missing or invalid status field)");
                }
              } catch (parseErr) {
                // Malformed result.json
                const prevParseStatus = task.status;
                task.status = "waiting_for_review";
                task.result = task.result || {};
                task.result.kind = "result_json_parse_failed";
                task.result.reconciliation_message = "result.json found at " + resultJsonPath + " but parse failed: " + parseErr.message;
                task.result.reconciled_at = new Date().toISOString();
                task.logs = task.logs || [];
                task.logs.push({ time: new Date().toISOString(), message: "[worker] result.json parse failed for reconciliation: " + parseErr.message });
                // Release lock since process is gone
                try { await releaseLockForTask(config.defaultWorkspaceRoot, task.id); } catch {}
                try { await notifyTerminalTaskIfNeeded(task); } catch {}
                reconciled.push({ task_id: task.id, previous_status: prevParseStatus, new_status: "waiting_for_review", message: "result.json parse failed: " + parseErr.message });
                if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} result.json parse failed -> waiting_for_review
`);
                recovered = true;
              }
            }
            if (!recovered) {
              // Fall through to existing codex_stalled behavior
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
          // Phase C.0: Check for misplaced repo-local restart markers
          try {
            const _misplacedRepoPaths = [config.defaultRepoPath].filter(Boolean);
            if (_misplacedRepoPaths.length > 0) {
              const _misplaced = scanMisplacedMarkersSync(_misplacedRepoPaths);
              for (const _mp of _misplaced) {
                const _canonicalMarker = await loadRestartMarker(config.defaultWorkspaceRoot, _mp.taskId);
                if (!_canonicalMarker) {
                  const _migrateResult = await migrateMisplacedMarker(config.defaultWorkspaceRoot, _mp.repoPath, _mp.taskId);
                  if (_migrateResult.migrated) {
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: migrated misplaced restart marker for task ${_mp.taskId} from ${_mp.repoPath}/.gptwork/pending-restarts to canonical path
`);
                  } else {
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: ${_migrateResult.diagnostic}
`);
                  }
                } else {
                  await removeMisplacedMarker(_mp.repoPath, _mp.taskId);
                  if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: removed duplicate misplaced restart marker for task ${_mp.taskId}
`);
                }
              }
            }
          } catch (_misplacedErr) {
            if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C misplaced marker scan error: ${_misplacedErr.message}
`);
          }
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
                    // P1.1/P1.2: Validate autonomy policy for restart-verified tasks
                    let autonomyValidation = { valid: true };
                    if (goalId) {
                      try {
                        const contextJsonPath = join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "context.json");
                        if (existsSync(contextJsonPath)) {
                          const contextData = JSON.parse(readFileSync(contextJsonPath, "utf8"));
                          const goal = contextData.goal || null;
                          autonomyValidation = validateAutonomyResult(resultData, goal);
                        }
                      } catch {}
                    }
                    if (autonomyValidation.valid) {
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
                      taskObj.status = "waiting_for_review";
                      taskObj.result = taskObj.result || {};
                      taskObj.result.kind = "codex_executed";
                      taskObj.result.summary = resultData.summary || "Autonomy validation failed after restart";
                      taskObj.result.warnings = taskObj.result.warnings || [];
                      taskObj.result.warnings.push("Autonomy policy validation failed after restart: " + autonomyValidation.reason);
                      taskObj.result.restart_state = "verified";
                      taskObj.result.restart_verified_at = new Date().toISOString();
                      taskObj.result.commit = resultData.commit;
                      taskObj.result.remote_head = resultData.remote_head;
                      taskObj.logs = taskObj.logs || [];
                      taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Autonomy validation failed after restart: " + autonomyValidation.reason });
                      await notifyTerminalTaskIfNeeded(taskObj);
                      taskObj.updated_at = new Date().toISOString();
                      restartVerifications.push({ task_id: marker.task_id, status: "waiting_for_review", verified: true });
                      // Release repo lock after restart verification (even on autonomy failure)
                      await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                      if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} autonomy validation failed after restart: ${autonomyValidation.reason}
`);
                    }
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
            } else if (marker.status === "pending") {
              const { verified, diagnostics } = await verifyRestartMarker(marker, {
                defaultRepoPath: config.defaultRepoPath,
                defaultRemote: config.defaultRemote,
                defaultBranch: config.defaultBranch,
              });
              if (verified) {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "verified", {
                  verified_at: new Date().toISOString(),
                  running_commit: diagnostics.running_commit,
                  pre_verified_pending: true,
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Pending restart marker pre-verified: expected_commit ${marker.expected_commit} matches running commit ${diagnostics.running_commit || "unknown"}` });
                  taskObj.updated_at = new Date().toISOString();
                }
                await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                restartVerifications.push({ task_id: marker.task_id, status: "verified", verified: true, pre_verified_pending: true });
                if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: pending marker ${marker.task_id} pre-verified (expected_commit matches running commit)\n`);
              } else {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "failed", {
                  failed_at: new Date().toISOString(),
                  failure_reason: (diagnostics.failures || []).join("; ") || diagnostics.error || "expected_commit_mismatch",
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Pending restart marker verification failed: expected_commit ${marker.expected_commit} mismatch ${diagnostics.running_commit ? `(running: ${diagnostics.running_commit})` : ""}` });
                  taskObj.updated_at = new Date().toISOString();
                }
                await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                restartVerifications.push({ task_id: marker.task_id, status: "failed", verified: false, pre_verified_pending: false });
                if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: pending marker ${marker.task_id} verification failed (expected_commit mismatch)\n`);
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


  // Initialize module-level worker state tracking
  markWorkerStarted(workerState, { intervalMs, limit, concurrency });
  async function tick() {
    if (stopped || running) return;
    running = true;
    markWorkerTickStarted(workerState);
    try {
      const wr = await server.runAssignedCodexTasks({ limit, concurrency });
      recordWorkerTickSuccess(workerState, wr);
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) {
        const done = wr.tasks.filter(t => t.status === "completed").length;
        const skip = wr.tasks.filter(t => t.skipped).length;
        appendFileSync(_lp, `[gptwork-worker] tick inspected=${wr.inspected} completed=${done} skipped=${skip}\n`);
      }}
    } catch (error) {
      recordWorkerTickError(workerState, error);
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] ${error.message}\n`); }
    } finally {
      markWorkerTickFinished(workerState);
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
  // resolveRepoDir is imported from ./diagnostics-service.mjs
  const tool = createTool;
  // queryContextStatus is imported from ./diagnostics-service.mjs

  const tools = {
    health_check: tool("Check whether the GPTWork MCP server is running.", schema({}), async () => ({ ok: true, service: "gptwork-mcp", time: new Date().toISOString() })),
    get_current_user: tool("Return the current token-bound user context.", schema({}), async (_args, context) => ({
      user: { id: context.user_id, name: context.user_name },
      team_id: context.team_id,
      project_ids: context.project_ids,
      workspace_ids: context.workspace_ids,
      scopes: context.scopes
    })),
    ...createProjectWorkspaceToolsGroup({ tool, schema, config, store, createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection }),
    list_recent_activity: tool("List recent project activity.", schema({ limit: "integer" }), async ({ limit = 50 }) => {
      const state = await store.load();
      return { activities: state.activities.slice(-limit).reverse() };
    }),

    ...createGoalToolsGroup({ tool, schema, config, store, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }),

    ...createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github }),
    ...createExecutionToolsGroup({ tool, schema, config, store, github, registry,
      normalizeAssignedTaskMode,
      ensureTaskGoal,
      notifyCreatedTaskIfNeeded,
      runAssignedCodexTasks,
    }),
    ...createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask }),
    ...createTaskCompletionToolsGroup({ tool, schema, config, store, github }),
    ...createRestartToolsGroup({ tool, schema, config, store }),

    ...createChatGptRequestToolsGroup({ tool, schema, config, store, github }),

    ...createWorkspaceReadToolsGroup({ tool, schema, store, config }),
    write_text_file: tool("Write a UTF-8 text file.", schema({ path: "string", content: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content"]), async (args, context) => workspaceWriteText(store, config, args, context)),
    upload_base64_file: tool("Upload a base64 encoded file.", schema({ path: "string", content_base64: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content_base64"]), async (args, context) => workspaceUploadBase64(store, config, args, context)),
    upload_bundle_base64: tool("Upload a ZIP bundle encoded as base64. Optionally extract it in the workspace after upload.", schema({ path: "string", zip_base64: "string", overwrite: "boolean", extract: "boolean", target_dir: "string", sha256_expected: "string", workspace_id: "string" }, ["path", "zip_base64"]), async (args, context) => workspaceUploadBundleBase64(store, config, args, context)),
    upload_from_url: tool("Download a URL and save it to the workspace.", schema({ url: "string", path: "string", overwrite: "boolean", workspace_id: "string" }, ["url", "path"]), async (args, context) => workspaceUploadFromUrl(store, config, args, context)),
    mkdir: tool("Create a directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceMkdir(store, config, args, context)),
    delete_path: tool("Permanently delete a file or directory. Files are deleted immediately, without recycle/trash. Use with caution.", schema({ path: "string", recursive: "boolean", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDelete(store, config, args, context)),
    move_path: tool("Move or rename a file/directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceMove(store, config, args, context)),
    copy_path: tool("Copy a file or directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceCopy(store, config, args, context)),
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
    ...createRepositoryToolsGroup({ tool, schema, registry }),
    ...createContextHealthToolsGroup({ tool, schema, config, registry, store }),


    sync_github_comments: tool("Poll GitHub Issues for new comments and import ChatGPT responses as answers to coordination requests. After ChatGPT responds to a question via GitHub Issue comment, use this to bring the answer back into the system.", schema({}), async () => {
      const responses = await github.importResponsesFromComments(store);
      return { checked_issues: github.getKnownIssues().length, responses_found: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, from: r.user })) };
    }),

    ...createBrowserToolsGroup({ tool, schema, browser }),
    browser_close_session: tool("Close a browser session.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.closeSession(session_id)),
    browser_current_state: tool("Return current page URL and title.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.currentState(session_id)),
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
    test_bark_notification: tool("Send a test Bark notification and return safe diagnostic result without exposing endpoint/key values.", schema({}), async () => bark ? bark.testSend() : ({ ok: false, attempted_at: null, response_code: null, response_message: null, source: "unknown", group: "gptwork", endpoint_kind: "none", error_short: "bark not initialized" })),
    ...createGitRemoteToolsGroup({ tool, schema, registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote }),
    worker_status: tool("Return Codex worker status: enabled, running, last tick timing, queue counts (assigned, queued, running, waiting_for_lock, waiting_for_review, completed, failed).", schema({}), async () => {
      const queue = await collectWorkerQueueCounts(store);
      return { ...workerStatusSnapshot(workerState), queue, queues: queue };
    }),
    ...createRuntimeStatusToolsGroup({ tool, schema, config, sources, envLoadResult, bark, github, registry, store, workerState, PROCESS_STARTED_AT, collectWorkerQueueCounts }),
    ...createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary }),
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

  // P0.1: Inject default autonomy/subagent policies if not provided in payload
  const payloadPolicies = args.payload || {};
  goal.autonomy_policy = payloadPolicies.autonomy_policy || {
    mode: 'subagent_first',
    gpt_question_budget: 0,
    allow_autonomous_defaults: true,
    default_decision_rule: 'choose_smallest_reversible_goal_aligned_change'
  };
  goal.subagent_policy = payloadPolicies.subagent_policy || {
    mode: 'optional',
    roles: ['analyst', 'architect', 'implementer', 'tester', 'reviewer', 'escalation_judge'],
    require_review_before_completion: false,
    require_test_or_verification: true
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



async function writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, extras = {}, context = defaultTokenContext("system")) {
  const workspaceFiles = goalWorkspaceFiles(goal);
  const payload = extras.payload || {
    user_request: goal.user_request,
    goal_prompt: goal.goal_prompt,
    context_summary: goal.context_summary,
    mode: goal.mode,
    workspace_id: goal.workspace_id,
    messages: conversation?.messages || [],
    autonomy_policy: goal.autonomy_policy,
    subagent_policy: goal.subagent_policy,
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
  const { fullPrompt } = buildCodexPrompt({
    task,
    goal,
    workspaceFiles,
    workspaceRoot: workspace.root,
    defaultRepoPath: config.defaultRepoPath,
  });
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
    let promptBytes = 0;
    try { promptBytes = (await stat(promptFile)).size; } catch {}
    fireHeartbeat(runFilePath, "running_codex", {
      prompt_bytes: promptBytes,
      first_output_timeout_seconds: config.codexFirstOutputTimeout || 180,
      stdout_bytes: 0,
      stderr_bytes: 0
    });
  } catch (e) {
    // Non-fatal: run metadata setup failed
  }
  
  try {
    const cmd = "codex exec " + config.codexExecArgs + " < " + promptFile;
    cr = await runLocalShell(cmd, workspace.root, config.codexExecTimeout, 1000000, (pid) => {
      updateRunHeartbeat(runFilePath, "running_codex", { codex_child_pid: pid }).catch(() => {});
    }, {
      firstOutputTimeoutSeconds: config.codexFirstOutputTimeout || 180,
      onOutput: (event) => {
        updateRunHeartbeat(runFilePath, "running_codex", {
          stdout_bytes: event.stdout_bytes,
          stderr_bytes: event.stderr_bytes,
          first_stdout_at: event.first_stdout_at,
          first_stderr_at: event.first_stderr_at,
          first_output_delay_ms: event.first_output_delay_ms
        }).catch(() => {});
      }
    });
    
    // Write stdout/stderr to durable log files
    if (cr && runId) {
      writeRunLogs({ workspaceRoot: config.defaultWorkspaceRoot, taskId: task.id, runId, stdout: cr.stdout, stderr: cr.stderr }).catch(() => {});
    }
    
    // Heartbeat after Codex exits
    if (runFilePath) {
      fireHeartbeat(runFilePath, "parsing_result", {
        exit_code: cr?.returncode ?? -1,
        timed_out: cr?.timed_out || false,
        no_first_output_timeout: cr?.no_first_output_timeout || false,
        first_output_timeout_seconds: cr?.first_output_timeout_seconds,
        stdout_bytes: cr?.stdout_bytes,
        stderr_bytes: cr?.stderr_bytes,
        first_stdout_at: cr?.first_stdout_at,
        first_stderr_at: cr?.first_stderr_at,
        first_output_delay_ms: cr?.first_output_delay_ms
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
        kind: cr?.no_first_output_timeout ? "no_first_output_timeout" : timedOut ? "codex_timeout" : "codex_failed",
        summary: cr?.no_first_output_timeout ? "Codex produced no stdout/stderr before the first-output timeout." : summary,
        completed_at: new Date().toISOString(),
        stdout_bytes: cr?.stdout_bytes ?? 0,
        stderr_bytes: cr?.stderr_bytes ?? 0,
        first_stdout_at: cr?.first_stdout_at || null,
        first_stderr_at: cr?.first_stderr_at || null,
        first_output_delay_ms: cr?.first_output_delay_ms ?? null,
        no_first_output_timeout: cr?.no_first_output_timeout || false,
        ...(timedOut ? { timed_out: true, timeout_seconds: cr?.no_first_output_timeout ? cr?.first_output_timeout_seconds : config.codexExecTimeout } : { timed_out: false })
      };

  const doneAt = new Date().toISOString();
  let taskStatus = taskResult.kind === "codex_executed" ? "completed"
    : (taskResult.kind === "codex_timeout" || taskResult.kind === "no_first_output_timeout") ? "timed_out"
    : "failed";

  // P1.1/P1.2: Validate autonomy policy for completed results
  if (taskStatus === "completed" && goal && parsedResult) {
    const autonomyValidation = validateAutonomyResult(parsedResult, goal);
    if (!autonomyValidation.valid) {
      taskStatus = "waiting_for_review";
      taskResult.warnings = taskResult.warnings || [];
      taskResult.warnings.push("Autonomy policy validation failed: " + autonomyValidation.reason);
    }
  }

  // P1.3: Runtime code change check for deploy-mode tasks
  if (taskStatus === "completed" && mode === "deploy" && parsedResult) {
    const runtimeCheck = detectRuntimeCodeChanges(parsedResult.changed_files || []);
    if (runtimeCheck.hasRuntimeChanges) {
      // Check if safe restart marker exists for this task
      let _hasRestartMarker = false;
      try {
        const _rm = await loadRestartMarker(config.defaultWorkspaceRoot, task.id);
        if (_rm && ["pending", "scheduled", "restarted"].includes(_rm.status)) {
          _hasRestartMarker = true;
        }
      } catch {}
      if (!_hasRestartMarker) {
        taskStatus = "waiting_for_review";
        taskResult.warnings = taskResult.warnings || [];
        taskResult.warnings.push("runtime_code_changed_without_safe_restart: " +
          runtimeCheck.matchedFiles.join(", "));
      }
    }
  }

  // Update run metadata with final phase
  if (runFilePath) {
    const resultJsonPath = workspace.root + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json";
    fireHeartbeat(runFilePath, taskStatus === "completed" ? "completed" : "failed", {
      result_json_path: resultJsonPath,
      exit_code: cr?.returncode ?? -1,
      timed_out: cr?.timed_out || false,
      no_first_output_timeout: cr?.no_first_output_timeout || false,
      first_output_timeout_seconds: cr?.first_output_timeout_seconds,
      stdout_bytes: cr?.stdout_bytes,
      stderr_bytes: cr?.stderr_bytes,
      first_stdout_at: cr?.first_stdout_at,
      first_stderr_at: cr?.first_stderr_at,
      first_output_delay_ms: cr?.first_output_delay_ms
    });
  }

  const result = await updateTask(store, task.id, (item) => {
    item.status = taskStatus;
    item.result = { ...taskResult, completed_at: doneAt };
    item.logs.push({ time: doneAt, message: taskResult.kind === "no_first_output_timeout"
      ? "[worker] timed out waiting for first Codex output after " + (cr?.first_output_timeout_seconds || config.codexFirstOutputTimeout || 180) + "s"
      : taskResult.kind === "codex_timeout"
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
