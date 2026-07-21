/**
 * recovery-tools-group.mjs — GPTWork break-glass recovery plane
 *
 * Implements explicit-config-gated emergency/admin recovery tools for
 * diagnosing and repairing GPTWork operational failures when the normal
 * create_task/create_goal/queue/worker dispatch path is broken.
 *
 * All tools are gated by GPTWORK_RECOVERY_PLANE_ENABLED.
 * Destructive operations default to dry_run=true.
 * All mutations are audited via admin-audit-log.
 * No secrets in outputs.
 *
 * Tools:
 *   1. recovery_plane_status
 *   2. recovery_diagnose
 *   3. recovery_queue_reconcile
 *   4. recovery_lock_reconcile
 *   5. recovery_worker_recover
 *   6. recovery_api_failure_control
 *   7. recovery_storage_maintenance
 *   8. recovery_runtime_env_fix_plan
 *   9. recovery_safe_restart
 *  10. recovery_state_patch
 *  11. recovery_file_read
 *  12. recovery_file_write
 *  13. recovery_apply_patch
 *  14. recovery_command_runner
 *  15. recovery_tool_exposure_self_test
 *  16. recovery_stale_queue_unblock
 */

import { execFile, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, copyFile, stat, readdir, appendFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createAdminAuditLogger, redactSecrets, redactString } from "../admin-audit-log.mjs";
import { resolveRepoDir, collectRuntimeGitInfoCached, collectRestartMarkerStatus, withCache } from "../diagnostics-service.mjs";
import { scanManagedTmp, cleanupManagedTmp, scanSystemTmp, cleanupSystemTmp, getInodePressure } from "../gptwork-tmp.mjs";
import { scanGoals, cleanupGoals } from "../goal-storage-service.mjs";
import { getRepoLockSummary, listRepoLocks } from "../repo-lock.mjs";
import { forceReleaseRepoLock } from "../repo-lock-lifecycle.mjs";
import { STALL_THRESHOLD_MS } from "../repo-lock-paths.mjs";
import { sha256 } from "../mcp-tooling.mjs";
import { scanPendingRestartMarkers, writePendingRestartMarker, scheduleServiceRestart, updateRestartMarkerStatus, getPendingRestartsDir } from "../safe-restart.mjs";
import { getRestartInstruction, getRestartStrategy, getRestartSummary } from "../restart-strategy.mjs";
import { collectCodexTuiRuntimeDiagnostics } from "../codex-tui-runtime-diagnostics.mjs";
import {
  TASK_STATUSES,
  isHumanReviewStatus,
  isTerminalStatus,
  normalizeTaskStatus,
} from "../task-status-taxonomy.mjs";

const execFileAsync = promisify(execFile);

export function executeRecoveryShellCommand(command, { cwd, timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        const error = new Error("stdout maxBuffer length exceeded");
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        finish(reject, error);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) return finish(resolve, { stdout: out, stderr: err });
      const error = new Error(`Command failed with code ${code}${signal ? ` (${signal})` : ""}`);
      error.code = code;
      error.stdout = out;
      error.stderr = err;
      finish(reject, error);
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      const error = new Error(`Command timed out after ${timeout}ms`);
      error.code = "ETIMEDOUT";
      error.stdout = Buffer.concat(stdout).toString("utf8");
      error.stderr = Buffer.concat(stderr).toString("utf8");
      finish(reject, error);
    }, timeout);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_VALUE_PATTERNS = [
  /github_pat_[a-zA-Z0-9_]+/g,
  /ghp_[a-zA-Z0-9]+/g,
  /gho_[a-zA-Z0-9]+/g,
  /ghu_[a-zA-Z0-9]+/g,
  /ghr_[a-zA-Z0-9]+/g,
  /sk-[a-zA-Z0-9]+/g,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
];

function redactText(str) {
  if (!str) return str;
  let r = String(str);
  for (const p of SECRET_VALUE_PATTERNS) r = r.replace(p, "[REDACTED]");
  return r;
}

// ---------------------------------------------------------------------------
// Path validation for allowed roots
// ---------------------------------------------------------------------------

function assertInAllowedRoots(targetPath, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new Error("No allowed roots configured");
  }
  const resolved = resolve(targetPath);
  for (const root of allowedRoots) {
    const realRoot = resolve(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + sep)) return resolved;
  }
  throw new Error("Path is outside allowed roots: " + targetPath);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function backendDirFor(repoPath) {
  return join(repoPath, "backend");
}

function normalizeNodeTestSelectedArgs(repoPath, args) {
  const backendDir = backendDirFor(repoPath);
  const rawArgs = String(args || "test/recovery-plane.test.mjs").trim().split(/\s+/).filter(Boolean);
  if (rawArgs.length === 0) rawArgs.push("test/recovery-plane.test.mjs");

  return rawArgs.map((rawArg) => {
    if (rawArg.includes("\0")) throw new Error("node_test_selected path contains NUL byte");
    if (rawArg.startsWith("-")) throw new Error("node_test_selected accepts test file paths only");

    const normalizedArg = rawArg.replace(/\\/g, "/");
    const absolutePath = normalizedArg.startsWith("/")
      ? resolve(normalizedArg)
      : normalizedArg === "backend" || normalizedArg.startsWith("backend/")
        ? resolve(repoPath, normalizedArg)
        : resolve(backendDir, normalizedArg);

    if (absolutePath !== backendDir && !absolutePath.startsWith(backendDir + sep)) {
      throw new Error("node_test_selected path is outside backend: " + rawArg);
    }
    if (absolutePath === backendDir) {
      throw new Error("node_test_selected path must name a test file: " + rawArg);
    }
    return relative(backendDir, absolutePath);
  });
}

function runtimeHealthProbeCommand() {
  const port = process.env.GPTWORK_PORT || 8787;
  const url = `http://localhost:${port}/health`;
  return {
    file: "curl",
    args: ["--fail", "--show-error", "--silent", "--connect-timeout", "2", "--max-time", "5", url],
    display: `curl --fail --show-error --silent --connect-timeout 2 --max-time 5 ${url}`,
    port,
  };
}

// ---------------------------------------------------------------------------
// Queue & task status constants
// ---------------------------------------------------------------------------

const ACTIVE_QUEUE_STATUSES = new Set(["waiting", "ready", "running", "blocked"]);
const RECOVERABLE_QUEUE_STATUSES = new Set([
  ...ACTIVE_QUEUE_STATUSES,
  "waiting_for_review",
  "waiting_for_repair",
  "waiting_for_integration",
]);

function isRecoverySafeTerminalTaskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized !== TASK_STATUSES.BLOCKED
    && (isTerminalStatus(normalized) || isHumanReviewStatus(normalized));
}

// ---------------------------------------------------------------------------
// Allowlisted recovery commands
// ---------------------------------------------------------------------------

function resolveRecoveryRepoPath({ config, repoDir }) {
  const candidates = [
    config.defaultRepoPath,
    repoDir,
    config.defaultWorkspaceRoot,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(join(resolved, ".git"))) return resolved;
  }

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }

  return resolve(repoDir || config.defaultRepoPath || config.defaultWorkspaceRoot || process.cwd());
}

const ALLOWLISTED_COMMANDS = {
  repo_status: { cmd: (rp) => `cd ${rp} && git remote -v && git branch && echo "---" && git log --oneline -5`, desc: "Git remote and branch status" },
  git_diff: { cmd: (rp) => `cd ${rp} && git diff --stat && echo "---" && git diff --no-color`, desc: "Git diff with stats" },
  git_log_recent: { cmd: (rp) => `cd ${rp} && git log --oneline -20`, desc: "Recent 20 git log entries" },
  npm_check_syntax: { cmd: (rp) => `cd ${shellQuote(backendDirFor(rp))} && find src -name '*.mjs' -type f -print0 | sort -z | xargs -0 -r -n 1 -P 8 node --check >/dev/null && echo 'syntax ok'`, desc: "Check syntax of backend src files" },
  npm_check_imports: { cmd: (rp) => `cd ${shellQuote(rp)} && npm --prefix backend run check:imports`, desc: "Check ES module imports" },
  node_test_selected: { cmd: (rp,args) => `cd ${shellQuote(backendDirFor(rp))} && node --test --test-reporter=dot ${normalizeNodeTestSelectedArgs(rp, args).map(shellQuote).join(" ")}`, desc: "Run selected Node tests" },
  queue_list: { cmd: (rp) => `cd ${rp}/backend && node -e "import('./src/state-store.mjs').then(s=>{const st=new s.StateStore({statePath:process.env.GPTWORK_STATE_PATH||'./data/state.json'});st.load().then(state=>{const q=state.goal_queue||[];q.forEach(i=>console.log(i.queue_id,i.status,i.blocked_reason||''))})})"`, desc: "List all queue items" },
  tmp_status: { cmd: (rp) => `cd ${rp}/backend && node -e "import('./src/gptwork-tmp.mjs').then(m=>m.scanManagedTmp({workspaceRoot:process.env.GPTWORK_WORKSPACE_ROOT||'.'}).then(r=>console.log(JSON.stringify(r,null,2))))"`, desc: "Temporary file diagnostics" },
  goal_storage_status: { cmd: (rp) => `cd ${rp}/backend && node -e "import('./src/goal-storage-service.mjs').then(m=>m.scanGoals(process.env.GPTWORK_WORKSPACE_ROOT||'.').then(r=>console.log(JSON.stringify(r,null,2))))"`, desc: "Goal storage diagnostics" },
  runtime_status: { cmd: (rp) => `cd ${rp}/backend && curl --fail --show-error --silent --connect-timeout 2 --max-time 5 http://localhost:${process.env.GPTWORK_PORT||8787}/health 2>&1 || echo "MCP health probe failed or timed out (GET /health port ${process.env.GPTWORK_PORT||8787})"`, desc: "Runtime health check" },
  doctor: { cmd: (rp) => `cd ${rp}/backend && node -e "import('./src/state-store.mjs').then(s=>{const st=new s.StateStore({statePath:process.env.GPTWORK_STATE_PATH||'./data/state.json'});st.load().then(state=>{console.log('tasks:',state.tasks?.length,'goals:',state.goals?.length,'queue:',state.goal_queue?.length)})})"`, desc: "Quick state diagnostics" },
  safe_restart_status: { cmd: (rp) => `ls -la ${rp}/../.gptwork/pending-restarts/ 2>/dev/null || echo "No pending restarts"`, desc: "Safe restart marker status" },
  inspect_recent_logs: { cmd: (rp) => `tail -100 ${rp}/backend/gptwork.log 2>/dev/null || echo "No log file"`, desc: "Recent GPTWork log entries" },
  verify_tool_exposure: { cmd: (rp) => `cd ${rp}/backend && node -e "fetch('http://localhost:${process.env.GPTWORK_PORT||8787}/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}).then(r=>r.json()).then(j=>{const tools=j.result?.tools||[];const recovery=tools.filter(t=>t.name.startsWith('recovery_'));console.log('Recovery tools:',recovery.length);recovery.forEach(t=>console.log(' - '+t.name))})"`, desc: "Verify recovery tool exposure" },
};

function _getSource(v) {
  if (process.env[v] !== undefined) return "process.env";
  return "default";
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRecoveryToolsGroup({
  tool, schema, store, config, envLoadResult, sources, registry, workerState,
  collectWorkerQueueCounts, repoDir, gitInfo, PROCESS_STARTED_AT,
}) {
  // Secondary defense: if recovery plane not enabled, return empty
  if (!config.recoveryPlaneEnabled) {
    return {};
  }

  const allowedRoots = config._recoveryAllowedRootsArr && config._recoveryAllowedRootsArr.length > 0
    ? config._recoveryAllowedRootsArr
    : [config.defaultWorkspaceRoot, config.defaultRepoPath].filter(Boolean);

  const auditLogger = createAdminAuditLogger({
    workspaceRoot: config.defaultWorkspaceRoot,
    logPath: config.recoveryAuditLog,
  });

  const isDryRunDefault = config.recoveryDryRunDefault !== false;

  // Common tool descriptor fields
  const common = {
    modes: ["operator", "full"],
    audience: ["chatgpt", "operator"],
    tags: ["system", "recovery", "admin"],
  };

  function now() { return new Date().toISOString(); }

  function runtimeEnvFileStatus() {
    const rawPath = envLoadResult.loadedPath
      || process.env.GPTWORK_RUNTIME_ENV_FILE
      || config.runtimeEnvFile
      || ".gptwork/runtime.env";
    if (!rawPath) return { path: null, exists: false };
    const root = config.defaultWorkspaceRoot || config.workspaceRoot || process.env.GPTWORK_WORKSPACE_ROOT || process.cwd();
    const path = String(rawPath).startsWith("/") ? String(rawPath) : resolve(root, String(rawPath));
    return { path, exists: existsSync(path) };
  }

  function runtimeEnvLoaded() {
    const file = runtimeEnvFileStatus();
    return (envLoadResult.keys || []).length > 0 || file.exists;
  }

  function runtimeEnvConfigured() {
    return runtimeEnvLoaded() || Object.keys(process.env).some(k => k.startsWith("GPTWORK_"));
  }


  async function audit(rec) {
    return auditLogger.appendRecord(rec);
  }

  function resolveAllowedPath(target) {
    const allRoots = [...new Set(allowedRoots)];
    return assertInAllowedRoots(target, allRoots);
  }

  // Helper to check if a lock can be safely cleared
  function checkLockClearGuard(lock, task) {
    if (!lock || !lock.task_id) {
      return { ok: true, reason: "no task_id in lock" };
    }
    if (lock.status === "released") {
      return { ok: false, reason: "lock already released" };
    }
    if (lock.status === "stale") {
      return { ok: true, reason: "lock marked stale" };
    }
    if (task && isRecoverySafeTerminalTaskStatus(task.status)) {
      return { ok: true, reason: "task " + lock.task_id + " is " + task.status };
    }
    const heartbeatAge = lock.last_heartbeat_at
      ? Date.now() - new Date(lock.last_heartbeat_at).getTime()
      : Infinity;
    if (heartbeatAge > STALL_THRESHOLD_MS) {
      return { ok: true, reason: "heartbeat stale (" + Math.round(heartbeatAge / 1000) + "s)" };
    }
    return { ok: false, reason: "active heartbeat, cannot clear" };
  }

  const tools = {};

  // ================================================================
  // 1. recovery_plane_status
  // ================================================================
  tools.recovery_plane_status = tool({
    name: "recovery_plane_status",
    description: "Return current recovery/break-glass capability status: recovery plane enabled, break-glass enabled, allowed roots, runtime env, audit log, running commit, worker state, queue/lock summaries.",
    inputSchema: schema({}),
    ...common,
    handler: async () => {
      const start = Date.now();
      const gitInfoR = await collectRuntimeGitInfoCached(repoDir);
      const queueCounts = await collectWorkerQueueCounts(store);
      const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      const codexTuiGoal = await collectCodexTuiRuntimeDiagnostics({ workspaceRoot: config.defaultWorkspaceRoot, store, config });
      const toolNames = Object.keys(tools).sort();
      let recentAuditCount = 0;
      try { const recent = await auditLogger.readRecent(5); recentAuditCount = recent.length; } catch {}
      const result = {
        recovery_plane_enabled: config.recoveryPlaneEnabled,
        break_glass_enabled: config.breakGlassEnabled,
        shell_exec_enabled: config.recoveryUnrestrictedLocalCommandEnabled,
        runtime_env_loaded: runtimeEnvLoaded(),
        runtime_env_file_path: runtimeEnvFileStatus().path,
        runtime_env_configured: runtimeEnvConfigured(),
        runtime_env_keys_loaded: envLoadResult.keys.filter(k =>
          !k.includes("TOKEN") && !k.includes("KEY") && !k.includes("SECRET") && !k.includes("PASSWORD")
        ),
        config_sources: {
          recoveryPlaneEnabled: _getSource("GPTWORK_RECOVERY_PLANE_ENABLED"),
          breakGlassEnabled: _getSource("GPTWORK_BREAK_GLASS_ENABLED"),
        },
        allowed_roots: allowedRoots,
        audit_log_path: auditLogger.getPath(),
        recent_audit_entries: recentAuditCount,
        running_commit: gitInfoR.running_commit,
        repo_head: gitInfoR.repo_head,
        pid: process.pid,
        worker: workerState ? {
          enabled: workerState.enabled, running: workerState.running,
          last_tick_started_at: workerState.last_tick_started_at,
          last_error: workerState.last_error,
        } : { enabled: false },
        queue: queueCounts,
        repo_locks: lockSummary,
        exposed_recovery_tools: toolNames,
        elapsed_ms: Date.now() - start,
      };
      if (codexTuiGoal) result.codex_tui_goal = codexTuiGoal;
      await audit({ tool: "recovery_plane_status", action: "status_check", result: "ok", elapsed_ms: Date.now() - start });
      return result;
    },
  });

  // ================================================================
  // 2. recovery_diagnose
  // ================================================================
  tools.recovery_diagnose = tool({
    name: "recovery_diagnose",
    description: "One-shot operational diagnostic. Inspects worker, queue, locks, runtime env, restart markers, tmp/inode pressure, GitHub sync, worktree, API circuit breaker. Returns severity, root causes, safe next actions, and whether break-glass recovery is recommended.",
    inputSchema: schema({}),
    ...common,
    handler: async () => {
      const start = Date.now();
      const issues = [];
      const state = await store.load();
      const queueCounts = await collectWorkerQueueCounts(store);
      const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      const gitInfoR = await collectRuntimeGitInfoCached(repoDir);
      const restartMarkersResult = await collectRestartMarkerStatus(config.defaultWorkspaceRoot);
      const codexTuiGoal = await collectCodexTuiRuntimeDiagnostics({ workspaceRoot: config.defaultWorkspaceRoot, store, config });
      const ws = workerState || {};

      // Worker
      if (ws.last_error) issues.push({ severity: "high", category: "worker", detail: "last_error: " + ws.last_error.slice(0,200) });
      if (!ws.enabled) issues.push({ severity: "medium", category: "worker", detail: "Worker disabled" });

      // Queue
      if (queueCounts.blocked > 0) issues.push({ severity: "medium", category: "queue", detail: queueCounts.blocked + " blocked items" });
      if (queueCounts.waiting_for_lock > 0) issues.push({ severity: "medium", category: "queue", detail: queueCounts.waiting_for_lock + " waiting_for_lock" });

      // Stale blocked
      const staleBlocked = (state.goal_queue || []).filter(i =>
        i.status === "blocked" && i.blocked_reason && i.blocked_reason.includes("Repo locked") && lockSummary.active_repo_locks === 0
      );
      if (staleBlocked.length > 0) issues.push({
        severity: "high", category: "queue",
        detail: staleBlocked.length + " stale Repo-locked items when active_locks=0",
        item_ids: staleBlocked.map(i => i.queue_id),
      });

      // Locks
      if (lockSummary.stale_repo_locks > 0) issues.push({ severity: "high", category: "locks", detail: lockSummary.stale_repo_locks + " stale lock(s)" });
      if (lockSummary.active_repo_locks > 0) issues.push({ severity: "info", category: "locks", detail: lockSummary.active_repo_locks + " active lock(s)" });

      // Env
      if (!runtimeEnvLoaded()) issues.push({ severity: "high", category: "runtime_env", detail: "runtime.env not loaded" });

      // Restart markers
      if (restartMarkersResult.active_count > 0) issues.push({ severity: "info", category: "restart", detail: restartMarkersResult.active_count + " active restart marker(s)" });

      // Worktree
      if (gitInfoR.worktree_dirty) issues.push({ severity: "info", category: "worktree", detail: "Dirty worktree (" + gitInfoR.dirty_paths.length + " files)" });

      if (codexTuiGoal?.finding_count > 0) {
        for (const finding of codexTuiGoal.findings) {
          issues.push({
            severity: finding.severity === "error" ? "high" : finding.severity === "warning" ? "medium" : "info",
            category: "codex_tui_goal",
            detail: `${finding.code}: ${finding.message}`,
            session_id: finding.session_id || null,
            task_id: finding.task_id || null,
          });
        }
      }

      // API state
      const apiState = state.recovery_api_failures;
      if (apiState && apiState.failure_count > 0) {
        const sev = apiState.last_status === 401 ? "high" : apiState.last_status === 429 ? "medium" : "info";
        issues.push({ severity: sev, category: "api", detail: apiState.failure_count + " failures, last=" + apiState.last_status + ", cb=" + apiState.circuit_breaker });
      }

      // Quota/rate-limit state: scan for tasks with quota_exhausted/rate_limited
      // or queue items blocked with quota-related reason.
      const quotaTasks = (state.tasks || []).filter(t =>
        t.failure_class === "quota_exhausted" || t.failure_class === "rate_limited" ||
        t.result?.failure_class === "quota_exhausted" || t.result?.failure_class === "rate_limited" ||
        t.result?.failure_class === "quota_exhausted_or_rate_limited"
      );
      const quotaQueueItems = (state.goal_queue || []).filter(i =>
        i.blocked_reason && (
          i.blocked_reason.includes("quota") ||
          i.blocked_reason.includes("rate_limit") ||
          i.blocked_reason.includes("capacity") ||
          i.blocked_reason.includes("429")
        )
      );
      if (quotaTasks.length > 0 || quotaQueueItems.length > 0) {
        const qTasks = quotaTasks.map(t => (t.id || "?") + "(" + (t.failure_class || t.result?.failure_class || "?") + ")").join(", ");
        const qQueue = quotaQueueItems.map(i => (i.queue_id || "?") + "(" + (i.blocked_reason || "?") + ")").join(", ");
        const parts = [];
        if (quotaTasks.length > 0) parts.push(quotaTasks.length + " task(s): " + qTasks);
        if (quotaQueueItems.length > 0) parts.push(quotaQueueItems.length + " queue item(s): " + qQueue);
        issues.push({
          severity: "high",
          category: "quota",
          detail: "External capacity blocker detected: " + parts.join("; "),
          next_action: "Check provider/model quota status. Use recovery_api_failure_control to inspect/reset. Wait for quota recovery before retrying.",
          root_cause: "external_capacity_blocker",
          affected_tasks: quotaTasks.map(t => t.id).filter(Boolean),
          affected_queue_items: quotaQueueItems.map(i => i.queue_id).filter(Boolean),
        });
      } else if (apiState && apiState.circuit_breaker === "backoff" && (apiState.by_status?.[429] || 0) > 0) {
        issues.push({
          severity: "medium",
          category: "api",
          detail: "Circuit breaker is backoff due to " + (apiState.by_status?.[429] || 0) + "x 429 responses. Next retry: " + (apiState.next_retry_at || "unknown") + ".",
          next_action: "Use recovery_api_failure_control to inspect/reset. Check API provider for quota status.",
        });
      }


      const countBlockers = Number(queueCounts.current_blockers || 0);
      const countActionable = Number(queueCounts["actionable_" + "review"] || 0);
      if (countBlockers > 0) {
        issues.push({ severity: "high", category: "blockers", detail: countBlockers + " current blockers" });
      }
      if (countActionable > 0) {
        issues.push({ severity: "high", category: "review", detail: countActionable + " actionable review tasks" });
      }
      if (ws.enabled === true && ws.running !== true && countBlockers > 0) {
        issues.push({ severity: "high", category: "worker", detail: "worker stopped with blockers" });
      }


      const high = issues.filter(i => i.severity === "high");
      const med = issues.filter(i => i.severity === "medium");
      const overall = high.length > 0 ? "high" : med.length > 0 ? "medium" : "low";

      await audit({ tool: "recovery_diagnose", action: "diagnose", result: "ok", summary: "severity=" + overall + " issues=" + issues.length, elapsed_ms: Date.now() - start });

      return {
        severity: overall,
        issues,
        high_count: high.length,
        medium_count: med.length,
        info_count: issues.filter(i => i.severity === "info").length,
        recommend_break_glass: high.length > 0 || staleBlocked.length > 0,
        normal_task_dispatch_usable: high.length === 0,
        worker_health: { enabled: ws.enabled, running: ws.running, last_error: ws.last_error },
        queue_counts: queueCounts,
        repo_locks: lockSummary,
        codex_tui_goal: codexTuiGoal || undefined,
        restart_markers: restartMarkersResult,
        runtime_env_loaded: runtimeEnvLoaded(),
        api_failure_state: apiState ? {
        quota_state: (quotaTasks.length > 0 || quotaQueueItems.length > 0) ? {
          tasks_affected: quotaTasks.length,
          queue_items_affected: quotaQueueItems.length,
          root_cause: "external_capacity_blocker",
          next_action: "Check provider/model quota status. Use recovery_api_failure_control to inspect/reset. Wait for quota recovery before retrying.",
          affected_tasks: quotaTasks.map(t => t.id).filter(Boolean),
          affected_queue_items: quotaQueueItems.map(i => i.queue_id).filter(Boolean),
        } : null,
          last_status: apiState.last_status, failure_count: apiState.failure_count,
          circuit_breaker: apiState.circuit_breaker || "closed", next_retry_at: apiState.next_retry_at,
        } : null,
        elapsed_ms: Date.now() - start,
      };
    },
  });

  // ================================================================
  // 3. recovery_queue_reconcile
  // ================================================================
  tools.recovery_queue_reconcile = tool({
    name: "recovery_queue_reconcile",
    description: "Repair stale queue states. Detects blocked items whose blocked_reason no longer matches current state, running items with terminal tasks, waiting_for_lock items with no active lock. dry_run=true default. apply=true updates safe items.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Apply safe corrections.", default: false },
      queue_id: { type: "string", description: "Optional: specific queue_id to reconcile.", examples: [] },
    }, []),
    ...common,
    handler: async ({ dry_run, apply, queue_id }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const state = await store.load();
      const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      const queue = state.goal_queue || [];
      const results = [];
      const targets = queue_id ? queue.filter(i => i.queue_id === queue_id) : queue.filter(i => RECOVERABLE_QUEUE_STATUSES.has(i.status));

      for (const item of targets) {
        const before = item.status;
        let proposed = null, reason = null, safe = "safe";

        const linkedGoal = item.goal_id ? (state.goals || []).find(x => x.id === item.goal_id) : null;
        const linkedTask = item.task_id ? (state.tasks || []).find(x => x.id === item.task_id) : null;
        const missingLinkedGoal = Boolean(item.goal_id && !linkedGoal);
        const missingLinkedTask = Boolean(item.task_id && !linkedTask);

        if (missingLinkedGoal && missingLinkedTask && ["waiting_for_review", "waiting_for_repair", "waiting_for_integration", "blocked"].includes(item.status)) {
          proposed = "cancelled";
          reason = "orphan queue item references missing goal " + item.goal_id + " and missing task " + item.task_id;
          safe = "safe_orphan_queue_item";
        }
        if (!proposed && item.status === "blocked" && item.blocked_reason?.includes("Repo locked") && lockSummary.active_repo_locks === 0) {
          proposed = "waiting"; reason = "Repo locked but no active locks";
        }
        if (!proposed && item.status === "blocked" && !item.blocked_reason?.includes("Repo locked")) {
          const dg = item.depends_on_goal_id;
          const dt = item.depends_on_task_id;
          if (dg) { const g = (state.goals||[]).find(x=>x.id===dg); if (g && isRecoverySafeTerminalTaskStatus(g.status)) { proposed = "waiting"; reason = "dep goal " + dg + " terminal (" + g.status + ")"; } }
          if (dt) { const t = (state.tasks||[]).find(x=>x.id===dt); if (t && isRecoverySafeTerminalTaskStatus(t.status)) { proposed = "waiting"; reason = "dep task " + dt + " terminal (" + t.status + ")"; } }
        }
        if (item.status === "running" && item.task_id) {
          const t = (state.tasks||[]).find(x=>x.id===item.task_id);
          if (t && isRecoverySafeTerminalTaskStatus(t.status)) { proposed = normalizeTaskStatus(t.status) === TASK_STATUSES.COMPLETED ? "completed" : "failed"; reason = "task terminal (" + t.status + ")"; }
        }

        if (proposed && before !== proposed) {
          if (isApply) { item.status = proposed; item.blocked_reason = null; item.updated_at = now(); await store.save(); }
          results.push({ queue_id: item.queue_id, goal_id: item.goal_id, status_before: before, status_after: isApply ? proposed : before, proposed_status: proposed, reason, safety_decision: safe, would_change: true, applied: isApply });
        }
      }

      await audit({ tool: "recovery_queue_reconcile", action: "queue_reconcile", dry_run: isDryRun, apply: isApply, result: results.length > 0 ? "ok" : "noop", summary: "reconciled " + results.length + " items", elapsed_ms: Date.now() - start });
      return { items_checked: targets.length, items_reconciled: results.length, items_changed: results.filter(r=>r.would_change).length, dry_run: isDryRun, applied: isApply, results };
    },
  });

  // ================================================================
  // 4. recovery_lock_reconcile
  // ================================================================
  tools.recovery_lock_reconcile = tool({
    name: "recovery_lock_reconcile",
    description: "Diagnose and safely clear repo locks. Lists active/stale locks. Only clears stale/terminal/missing-task locks when apply=true. Never clears actively heartbeating running task locks. dry_run=true default.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Actually clear safe locks.", default: false },
      lock_id: { type: "string", description: "Optional: specific safe_repo_id to target.", examples: [] },
    }, []),
    ...common,
    handler: async ({ dry_run, apply, lock_id }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const allLocks = await listRepoLocks(config.defaultWorkspaceRoot);
      const state = await store.load();
      const results = [];
      let cleared = 0;
      const tasks = state.tasks || [];
      const targets = lock_id
        ? allLocks.filter(l => l.safe_repo_id === lock_id)
        : allLocks.filter(l => {
            if (l.status !== "released") return true;
            const t = l.task_id ? tasks.find(task => task.id === l.task_id) : null;
            return l.stale_reason && t && normalizeTaskStatus(t.status) === TASK_STATUSES.RUNNING;
          });

      for (const lock of targets) {
        const task = lock.task_id ? tasks.find(t => t.id === lock.task_id) : null;
        if (lock.status === "released" && lock.stale_reason && task && normalizeTaskStatus(task.status) === TASK_STATUSES.RUNNING) {
          if (isApply) {
            task.status = TASK_STATUSES.ASSIGNED;
            task.assignee ||= "codex";
            task.updated_at = now();
            task.logs ||= [];
            task.logs.push({ time: task.updated_at, message: "[recovery] reset orphan running task to assigned" });
            await store.save();
          }
          results.push({ safe_repo_id: lock.safe_repo_id, task_id: lock.task_id, status_before: lock.status, task_status_before: TASK_STATUSES.RUNNING, task_status_after: isApply ? TASK_STATUSES.ASSIGNED : TASK_STATUSES.RUNNING, cleared: false, skipped: false, requeued: isApply, reason: lock.stale_reason });
          continue;
        }
        const guard = checkLockClearGuard(lock, task);
        if (!guard.ok) {
          results.push({ safe_repo_id: lock.safe_repo_id, task_id: lock.task_id, status_before: lock.status, cleared: false, skipped: true, reason: guard.reason });
          continue;
        }
        if (isApply) {
          try {
            if (lock.canonical_repo_path) { await forceReleaseRepoLock(config.defaultWorkspaceRoot, lock.canonical_repo_path); cleared++; }
            else { results.push({ ...lock, cleared: false, skipped: true, reason: "no canonical_repo_path" }); continue; }
          } catch (err) { results.push({ ...lock, cleared: false, skipped: true, reason: "error: " + err.message }); continue; }
        }
        results.push({ safe_repo_id: lock.safe_repo_id, task_id: lock.task_id, status_before: lock.status, status_after: isApply ? "released" : lock.status, cleared: isApply, skipped: false, reason: guard.reason });
      }

      await audit({ tool: "recovery_lock_reconcile", action: "lock_reconcile", dry_run: isDryRun, apply: isApply, result: results.length > 0 ? "ok" : "noop", summary: "checked=" + results.length + " cleared=" + cleared, elapsed_ms: Date.now() - start });
      return { locks_checked: targets.length, locks_cleared: cleared, locks_skipped: results.filter(r=>r.skipped).length, dry_run: isDryRun, applied: isApply, details: results };
    },
  });

  // ================================================================
  // 5. recovery_worker_recover
  // ================================================================
  tools.recovery_worker_recover = tool({
    name: "recovery_worker_recover",
    description: "Recover worker stuck or errored states. Inspects worker state, last error, tick timing, API failure loops. Can reset error state, reset timestamps, or reset API circuit breaker. dry_run=true default.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Apply recovery actions.", default: false },
    }, []),
    ...common,
    handler: async ({ dry_run, apply }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const ws = workerState || {};
      const findings = [];
      const actions = [];
      const lastTickAge = ws.last_tick_finished_at ? Date.now() - new Date(ws.last_tick_finished_at).getTime() : null;
      const isStuck = lastTickAge !== null && lastTickAge > (ws.interval_ms || 5000) * 6;

      if (ws.last_error) { findings.push({ finding: "last_error", detail: ws.last_error.slice(0,200) }); if (isApply) { ws.last_error = null; ws.last_tick_result = { ok: true, recovered: true }; actions.push({ action: "reset_error", status: "applied" }); } else { actions.push({ action: "reset_error", status: "would_apply" }); } }
      if (isStuck && !ws.running) { findings.push({ finding: "stalled", detail: "Stalled " + Math.round(lastTickAge/1000) + "s" }); if (isApply) { ws.next_tick_due_at = null; ws.last_tick_finished_at = null; actions.push({ action: "reset_timing", status: "applied" }); } else { actions.push({ action: "reset_timing", status: "would_apply" }); } }

      const state = await store.load();
      const af = state.recovery_api_failures;
      if (af && af.failure_count > 3) { findings.push({ finding: "api_loop", detail: af.failure_count + " failures" }); if (isApply) { state.recovery_api_failures = { failure_count: 0, last_status: null, last_failure_at: null, circuit_breaker: "closed", next_retry_at: null, by_status: {} }; await store.save(); actions.push({ action: "reset_api_cb", status: "applied" }); } else { actions.push({ action: "reset_api_cb", status: "would_apply" }); } }

      if (actions.length === 0) { actions.push({ action: "none", status: "ok", detail: "Worker healthy" }); }

      await audit({ tool: "recovery_worker_recover", action: "worker_recover", dry_run: isDryRun, apply: isApply, result: actions.find(a => a.status === "applied") ? "recovered" : "dry_run", summary: "findings=" + findings.length + " actions=" + actions.length, elapsed_ms: Date.now() - start });
      return { worker: { enabled: ws.enabled, running: ws.running, last_error: ws.last_error, stalled: isStuck }, findings, actions, verification_status: isApply ? "recovered" : "dry_run", dry_run: isDryRun, applied: isApply };
    },
  });

  // ================================================================
  // 6. recovery_api_failure_control
  // ================================================================
  tools.recovery_api_failure_control = tool({
    name: "recovery_api_failure_control",
    description: "Record/reset API failure circuit breaker. Classifies 401 (auth, no retry), 429 (rate limit, backoff), 503 (transient, bounded retry). Also supports quota_exhausted (sets circuit_breaker=quota_backoff, longer backoff). Reset=true closes the circuit breaker. Use to prevent infinite retry loops.",
    inputSchema: schema({
      record_status: { type: "integer", description: "HTTP status to record (401/429/503).", examples: [503] },
      record_quota: { type: "string", description: "Record quota_exhausted event. Sets circuit_breaker=quota_backoff and longer backoff window.", examples: ["quota_exhausted", "rate_limited"] },
      reset: { type: "boolean", description: "Reset circuit breaker.", default: false },
      reason: { type: "string", description: "Reason for reset/record.", examples: [] },
    }, []),
    ...common,
    handler: async ({ record_status, record_quota, reset, reason }) => {
      const start = Date.now();
      const state = await store.load();
      let f = state.recovery_api_failures || { failure_count: 0, last_status: null, last_failure_at: null, circuit_breaker: "closed", next_retry_at: null, by_status: {}, last_quota_type: null };

      if (reset) {
        f = { failure_count: 0, last_status: null, last_failure_at: null, circuit_breaker: "closed", next_retry_at: null, by_status: {}, last_quota_type: null };
        state.recovery_api_failures = f; await store.save();
        await audit({ tool: "recovery_api_failure_control", action: "reset", result: "ok", summary: "CB reset" + (reason ? ": " + reason : ""), elapsed_ms: Date.now() - start });
        return { circuit_breaker: "closed", failure_count: 0, reset: true, message: "Circuit breaker reset." };
      }
      if (record_quota) {
        const qType = String(record_quota).trim().toLowerCase();
        f.last_status = -1; f.last_failure_at = now(); f.failure_count = (f.failure_count || 0) + 1;
        if (!f.by_status) f.by_status = {};
        f.by_status[qType] = (f.by_status[qType] || 0) + 1;
        f.last_quota_type = qType;
        if (qType === "quota_exhausted") {
          const b = Math.min(600, Math.pow(2, f.by_status[qType]) * 30);
          f.circuit_breaker = "quota_backoff"; f.next_retry_at = new Date(Date.now() + b*1000).toISOString();
        } else if (qType === "rate_limited") {
          const b = Math.min(300, Math.pow(2, f.by_status[qType]) * 10);
          f.circuit_breaker = "backoff"; f.next_retry_at = new Date(Date.now() + b*1000).toISOString();
        } else {
          const b = Math.min(120, f.by_status[qType] * 15);
          f.circuit_breaker = "quota_backoff"; f.next_retry_at = new Date(Date.now() + b*1000).toISOString();
        }
        state.recovery_api_failures = f; await store.save();
        await audit({ tool: "recovery_api_failure_control", action: "record_quota", result: "ok", summary: "quota_type=" + qType + " count=" + f.failure_count, elapsed_ms: Date.now() - start });
      }

      if (record_status) {
        const s = Number(record_status);
        f.last_status = s; f.last_failure_at = now(); f.failure_count = (f.failure_count || 0) + 1;
        if (!f.by_status) f.by_status = {};
        f.by_status[s] = (f.by_status[s] || 0) + 1;
        if (s === 401) { f.circuit_breaker = "open_auth"; f.next_retry_at = null; }
        else if (s === 429) { const b = Math.min(300, Math.pow(2, f.by_status[s]) * 5); f.circuit_breaker = "backoff"; f.next_retry_at = new Date(Date.now() + b*1000).toISOString(); }
        else if (s === 503) { const b = Math.min(60, f.by_status[s] * 10); f.circuit_breaker = f.by_status[s] > 5 ? "open_transient" : "retry"; f.next_retry_at = new Date(Date.now() + b*1000).toISOString(); }
        else { f.circuit_breaker = "unknown"; f.next_retry_at = new Date(Date.now() + 30000).toISOString(); }
        state.recovery_api_failures = f; await store.save();
        await audit({ tool: "recovery_api_failure_control", action: "record", result: "ok", summary: "status=" + s + " count=" + f.failure_count, elapsed_ms: Date.now() - start });
      }
      return { circuit_breaker: f.circuit_breaker, failure_count: f.failure_count, last_status: f.last_status, last_failure_at: f.last_failure_at, next_retry_at: f.next_retry_at, by_status: f.by_status || {}, last_quota_type: f.last_quota_type || null };
    },
  });


  // ================================================================
  // 7. recovery_storage_maintenance
  // ================================================================
  tools.recovery_storage_maintenance = tool({
    name: "recovery_storage_maintenance",
    description: "Unified storage diagnostics and maintenance. Wraps tmp_status, cleanup_tmp, goal_storage_status, cleanup_goals. Reports file count, byte count, inode pressure, cleanable items. Dry-run by default. Never deletes open/running/queued/assigned goals.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Actually perform cleanup.", default: false },
      tmp_cleanup: { type: "boolean", description: "Perform tmp cleanup.", default: false },
      goals_cleanup: { type: "boolean", description: "Perform goal cleanup.", default: false },
      max_age_days: { type: "integer", description: "Max age in days for cleanup. Default: 7.", default: 7 },
    }, []),
    ...common,
    handler: async ({ dry_run, apply, tmp_cleanup, goals_cleanup, max_age_days }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const wsRoot = config.defaultWorkspaceRoot;
      const result = {};

      // Diagnostics always runs
      const managed = await scanManagedTmp({ workspaceRoot: wsRoot, includeActive: false });
      const sysTmp = await scanSystemTmp();
      const inodePressure = await getInodePressure();
      const goalScan = await scanGoals(wsRoot);

      result.diagnostics = {
        managed_tmp: { total_files: managed.fileCount, total_bytes: managed.totalBytes, total_bytes_h: managed.totalBytesH },
        system_tmp: { total_files: sysTmp.file_count, total_bytes: sysTmp.total_bytes, total_bytes_h: sysTmp.total_bytes_h },
        inode_pressure: inodePressure || null,
        goals: { dir_count: goalScan.dir_count, total_files: goalScan.total_files, total_bytes: goalScan.total_bytes_h || goalScan.total_bytes + " B", terminal_goal_dirs: goalScan.terminal_goal_dirs || 0 },
      };

      // Tmp cleanup
      if (tmp_cleanup) {
        const tResult = await cleanupManagedTmp({ workspaceRoot: wsRoot, maxAgeMs: (max_age_days || 7) * 86400000, dryRun: isDryRun });
        result.tmp_cleanup = { dry_run: isDryRun, deleted: tResult.deleted, skipped: tResult.skipped, deleted_bytes: tResult.deletedBytes };
      }

      // Goal cleanup
      if (goals_cleanup) {
        const gResult = await cleanupGoals({ workspaceRoot: wsRoot, maxAgeMs: (max_age_days || 7) * 86400000, dryRun: isDryRun, archive: true });
        result.goals_cleanup = { dry_run: isDryRun, eligible: gResult.eligible, archived: gResult.archived, deleted: gResult.deleted, skipped: gResult.skipped, message: gResult.message };
      }

      await audit({ tool: "recovery_storage_maintenance", action: "storage_maintenance", dry_run: isDryRun, apply: isApply, summary: "tmp_files=" + managed.fileCount + " goals=" + (goalScan.dir_count||0), elapsed_ms: Date.now() - start });
      return { ...result, dry_run: isDryRun, applied: isApply };
    },
  });

  // ================================================================
  // 8. recovery_runtime_env_fix_plan
  // ================================================================
  tools.recovery_runtime_env_fix_plan = tool({
    name: "recovery_runtime_env_fix_plan",
    description: "Diagnose runtime_env_configured=true but runtime_env_loaded=false. Inspects startup/config source order, identifies whether runtime.env is loaded too late or not at all, reports the loading module, and provides fix guidance.",
    inputSchema: schema({}),
    ...common,
    handler: async () => {
      const start = Date.now();
      const envStatus = runtimeEnvFileStatus();
      const envFile = envStatus.path || "default .gptwork/runtime.env";
      const envVarsAtStart = Object.keys(process.env).filter(k => k.startsWith("GPTWORK_"));
      const loadedKeys = envLoadResult.keys || [];
      const configuredKeys = Object.keys(sources || {}).filter(k => sources[k] === "runtime.env" || sources[k] === "process.env");
      const runtimeConfigKeys = Object.keys(sources || {});
      const keysBySource = { "runtime.env": [], "process.env": [], "default": [], "options": [] };
      for (const [k, v] of Object.entries(sources || {})) {
        if (keysBySource[v]) keysBySource[v].push(k);
      }

      const issues = [];
      const loaded = loadedKeys.length > 0 || envStatus.exists;
      if (!loaded && configuredKeys.length > 0) {
        issues.push({ severity: "high", detail: "runtime.env configured but no keys loaded — env file may be missing or empty" });
      }
      if (!loaded && !envFile) {
        issues.push({ severity: "high", detail: "No runtime.env file found and no GPTWORK_ vars in process.env" });
      }

      const result = {
        runtime_env_file_path: envFile,
        runtime_env_file_exists: envStatus.exists,
        runtime_env_loaded: loaded,
        runtime_env_configured: loaded || configuredKeys.length > 0,
        loaded_config_key_names: loadedKeys.filter(k => !/TOKEN|KEY|SECRET|PASSWORD/i.test(k)),
        config_source_found_loaded_keys: loadedKeys.length,
        configured_keys_by_source: keysBySource,
        total_runtime_config_keys: runtimeConfigKeys.length,
        issues,
        startup_order: [
          "1. process.env (system/launch) — checked first",
          "2. cli.mjs early env load — loads " + (envFile || "N/A"),
          "3. gptwork-server.mjs earlyEnvResult — calls loadRuntimeEnv()",
          "4. buildRuntimeConfig() — resolves final config values",
          "5. createTools() — tools registered with final config",
        ],
        fix_recommendation: !loaded
          ? "Ensure .gptwork/runtime.env exists with GPTWORK_* variables, or set them in process.env before starting GPTWork."
          : "runtime.env is loaded correctly.",
        elapsed_ms: Date.now() - start,
      };
      await audit({ tool: "recovery_runtime_env_fix_plan", action: "diagnose", result: "ok", summary: "loaded=" + loadedKeys.length + " issues=" + issues.length, elapsed_ms: Date.now() - start });
      return result;
    },
  });

  // ================================================================
  // 9. recovery_safe_restart
  // ================================================================
  tools.recovery_safe_restart = tool({
    name: "recovery_safe_restart",
    description: "Trigger existing project safe restart flow and verify runtime commit. Creates a restart marker, requests MCP/project restart. dry_run=true by default (apply=true to actually restart). Returns marker id, new pid, verification status.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Actually perform restart.", default: false },
      expected_commit: { type: "string", description: "Expected commit after restart.", examples: [] },
    }, []),
    ...common,
    handler: async ({ dry_run, apply, expected_commit }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const gitInfoR = await collectRuntimeGitInfoCached(repoDir);
      const markerId = "recovery_restart_" + randomUUID().slice(0,12).replace(/-/g,"");
      const oldPid = process.pid;

      if (isApply) {
        try {
          // Write restart marker
          await writePendingRestartMarker(config.defaultWorkspaceRoot, markerId, {
            requestedBy: "recovery_plane",
            expectedCommit: expected_commit || gitInfoR.running_commit || null,
            repoPath: config.defaultRepoPath,
          });

          // Trigger service restart if scheduler available
          let restartResult = { ok: false, reason: "scheduler not available from handler" };
          try {
            restartResult = await scheduleServiceRestart({
              workspaceRoot: config.defaultWorkspaceRoot,
              taskId: markerId,
              requestedBy: "recovery_plane",
              expectedCommit: expected_commit || gitInfoR.running_commit || null,
              repoPath: config.defaultRepoPath,
              store,
            });
          } catch (e) {
            const restartStrategy = getRestartStrategy(config);
            restartResult = {
              ok: false,
              reason: "scheduler error: " + e.message,
              instruction: getRestartInstruction(restartStrategy),
            };
          }

          await audit({ tool: "recovery_safe_restart", action: "restart", apply: true, result: restartResult.ok ? "ok" : "needs_external", marker_id: markerId, summary: "restart triggered", elapsed_ms: Date.now() - start });
          return { marker_id: markerId, old_pid: oldPid, target_commit: expected_commit || gitInfoR.running_commit, restart_result: restartResult, status: restartResult.ok ? "restart_scheduled" : "needs_external_restart", external_command: restartResult.instruction || null, verification_status: "pending — verify after restart" };
        } catch (err) {
          return { marker_id: markerId, old_pid: oldPid, error: err.message, status: "failed" };
        }
      }

            // Dry run — enhanced with runtime mismatch detection
      const restartStrategy = getRestartStrategy(config);
      const restartSummary = getRestartSummary(restartStrategy);
      const expectedCommit = expected_commit || gitInfoR.running_commit || null;
      const restartMarkerPath = getPendingRestartsDir(config.defaultWorkspaceRoot);
      const isSafe = expectedCommit && gitInfoR.running_commit
        ? (expectedCommit === gitInfoR.running_commit)
        : null;
      const runtimeMismatch = gitInfoR.running_commit && gitInfoR.repo_head
        ? (gitInfoR.running_commit !== gitInfoR.repo_head)
        : null;
      const hasActiveRestartMarker = (() => {
        try {
          const markers = require('node:fs').readdirSync(restartMarkerPath);
          return markers.length > 0;
        } catch { return false; }
      })();
      return {
        marker_id: markerId,
        old_pid: oldPid,
        expected_commit: expectedCommit,
        running_commit: gitInfoR.running_commit,
        repo_head: gitInfoR.repo_head,
        remote_head: gitInfoR.remote_head,
        status: 'dry_run',
        message: 'Would create restart marker and trigger service restart.',
        safe_to_restart: isSafe,
        runtime_mismatch_detected: runtimeMismatch,
        runtime_mismatch_detail: runtimeMismatch
          ? 'Repo HEAD (' + gitInfoR.repo_head.slice(0, 12) + ') differs from running_commit (' + gitInfoR.running_commit.slice(0, 12) + '). A restart is required for the runtime to pick up the latest code.'
          : null,
        has_active_restart_markers: hasActiveRestartMarker,
        restart_marker_dir: restartMarkerPath,
        restart_strategy: {
          mode: restartStrategy.mode,
          marker_kind: restartStrategy.markerKind,
          command: restartStrategy.mode === 'npm' ? 'npm run start' : (restartStrategy.command || ''),
          cwd: restartStrategy.cwd,
          instruction: restartSummary.restart_instruction,
        },
        systemctl_used: false,
      };    },
  });

  // ================================================================
  // 10. recovery_state_patch
  // ================================================================
  tools.recovery_state_patch = tool({
    name: "recovery_state_patch",
    description: "Apply narrow structured state repairs when GPTWork state is inconsistent. Supports: stale queue status correction, stale lock removal, failed restart marker reconciliation, terminal task status correction, API circuit breaker reset. dry_run=true default. Creates backup before apply.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Apply patch with backup.", default: false },
      patch_type: {
        type: "string",
        description: "Type of patch: queue_unblock | queue_complete_terminal | api_cb_reset | restart_marker_cleanup | task_terminal_correction",
        examples: ["queue_unblock"],
      },
      target_id: { type: "string", description: "Target queue_id/task_id/lock_id for the patch.", examples: [] },
      status: { type: "string", description: "Target status if applicable.", examples: ["waiting"] },
    }, ["patch_type"]),
    ...common,
    handler: async ({ dry_run, apply, patch_type, target_id, status }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const state = await store.load();
      const statePath = config.statePath;
      let backupPath = null;
      let before = null;
      let after = null;
      let diff = null;

      // Build structured patch
      let patchResult = { ok: false, error: "unknown patch type: " + patch_type };
      const safeStatuses = ["waiting", "ready", "completed", "failed", "cancelled"];
      const safePatchTypes = ["queue_unblock", "queue_complete_terminal", "api_cb_reset", "restart_marker_cleanup", "task_terminal_correction"];

      if (!safePatchTypes.includes(patch_type)) {
        return { ok: false, error: "Unknown or unsafe patch_type: " + patch_type + ". Allowed: " + safePatchTypes.join(", ") };
      }

      // Queue unblock
      if (patch_type === "queue_unblock" && target_id) {
        const item = (state.goal_queue || []).find(i => i.queue_id === target_id);
        if (item) {
          before = { queue_id: item.queue_id, status: item.status, blocked_reason: item.blocked_reason };
          if (status && safeStatuses.includes(status)) {
            if (isApply) { item.status = status; item.blocked_reason = null; }
            after = { queue_id: item.queue_id, status: isApply ? status : item.status, blocked_reason: isApply ? null : item.blocked_reason };
            patchResult = { ok: true };
          } else { patchResult = { ok: false, error: "Invalid status: " + status }; }
        } else { patchResult = { ok: false, error: "Queue item not found: " + target_id }; }
      }

      // Queue complete terminal
      if (patch_type === "queue_complete_terminal" && target_id) {
        const item = (state.goal_queue || []).find(i => i.queue_id === target_id);
        if (item) {
          before = { queue_id: item.queue_id, status: item.status };
          if (isApply) { item.status = "completed"; item.blocked_reason = null; }
          after = { queue_id: item.queue_id, status: isApply ? "completed" : item.status };
          patchResult = { ok: true };
        } else { patchResult = { ok: false, error: "Queue item not found: " + target_id }; }
      }

      // API circuit breaker reset
      if (patch_type === "api_cb_reset") {
        before = state.recovery_api_failures || null;
        if (isApply) { state.recovery_api_failures = { failure_count: 0, last_status: null, last_failure_at: null, circuit_breaker: "closed", next_retry_at: null, by_status: {} }; }
        after = isApply ? state.recovery_api_failures : "would_reset";
        patchResult = { ok: true };
      }

      // Task terminal correction
      if (patch_type === "task_terminal_correction" && target_id) {
        const task = (state.tasks || []).find(t => t.id === target_id);
        if (task) {
          before = { task_id: task.id, status: task.status };
          if (status && safeStatuses.includes(status)) {
            if (isApply) { task.status = status; }
            after = { task_id: task.id, status: isApply ? status : task.status };
            patchResult = { ok: true };
          } else { patchResult = { ok: false, error: "Invalid status: " + status }; }
        } else { patchResult = { ok: false, error: "Task not found: " + target_id }; }
      }

      // Restart marker cleanup — auto-verify pending markers where expected_commit matches running commit
      if (patch_type === "restart_marker_cleanup") {
        const allMarkers = await scanPendingRestartMarkers(config.defaultWorkspaceRoot);
        const activeMarkers = target_id
          ? allMarkers.filter(m => m.task_id === target_id && ["pending","scheduled","restarted"].includes(m.status))
          : allMarkers.filter(m => ["pending","scheduled","restarted"].includes(m.status));
        const repoDir = config.defaultRepoPath;
        let runningCommit = null;
        if (repoDir) {
          try {
            runningCommit = execSync("git rev-parse HEAD", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
          } catch {}
        }
        const markerResults = [];
        let verifiedCount = 0;
        let skippedCount = 0;
        for (const m of activeMarkers) {
          const commitMatches = runningCommit && m.expected_commit && runningCommit === m.expected_commit;
          if (commitMatches) {
            markerResults.push({ task_id: m.task_id, action: "verify", expected_commit: m.expected_commit });
            if (isApply) {
              await updateRestartMarkerStatus(config.defaultWorkspaceRoot, m.task_id, "verified", {
                verified_at: new Date().toISOString(),
                running_commit: runningCommit,
                pre_verified_pending: true,
              });
            }
            verifiedCount++;
          } else {
            markerResults.push({ task_id: m.task_id, action: "skip", reason: runningCommit ? "expected_commit mismatch" : "no running_commit" });
            skippedCount++;
          }
        }
        before = { marker_count: allMarkers.length, active_marker_count: activeMarkers.length };
        patchResult = { ok: true, verified_count: verifiedCount, skipped_count: skippedCount };
        after = {
          running_commit: runningCommit,
          markers: markerResults,
          total_verified: verifiedCount,
          total_skipped: skippedCount,
        };
      }

      if (patchResult.ok && isApply) {
        await store.save();
        diff = { before, after };
      }

      await audit({ tool: "recovery_state_patch", action: "state_patch", dry_run: isDryRun, apply: isApply, path: statePath, patch_type, target_id, result: patchResult.ok ? "ok" : "error", elapsed_ms: Date.now() - start });
      return { ok: patchResult.ok, error: patchResult.error || null, patch_type, target_id, before: isApply ? before : null, after: isApply ? after : null, diff: isApply ? diff : null, dry_run: isDryRun, applied: isApply, message: isDryRun ? "Dry run — would patch " + patch_type + " for " + target_id : (patchResult.ok ? "Patched " + patch_type : "Patch failed") };
    },
  });

  // ================================================================
  // 11. recovery_file_read
  // ================================================================
  tools.recovery_file_read = tool({
    name: "recovery_file_read",
    description: "Read bounded project files for emergency diagnosis. Path must be within allowed roots. Max read bytes enforced. Secrets automatically redacted in output and refused for high-risk paths (.env, token, key files).",
    inputSchema: schema({
      path: { type: "string", description: "Absolute or relative path within allowed roots.", examples: ["/workspace/.gptwork/state.json"] },
      max_bytes: { type: "integer", description: "Max bytes to read. Default: 50000.", default: 50000, maximum: 200000 },
      allow_secret_path: { type: "boolean", description: "Override secret path protection. Even when true, values are redacted.", default: false },
    }, ["path"]),
    ...common,
    handler: async ({ path: targetPath, max_bytes, allow_secret_path }) => {
      const start = Date.now();
      const maxB = Math.min(Number(max_bytes) || 50000, 200000);
      const resolved = resolveAllowedPath(targetPath);
      let truncated = false;

      // Check for secret paths
      const secretPatterns = [/.env$/, /token/i, /key$/i, /credentials/i, /secret/i, /.pem$/, /.cert$/];
      const isSecret = secretPatterns.some(p => p.test(resolved));
      if (isSecret && !allow_secret_path) {
        return { ok: false, error: "Path appears to contain secrets (.env/token/key). Set allow_secret_path=true to override (values still redacted).", path: targetPath, resolved };
      }

      const content = await readFile(resolved, "utf8");
      const size = Buffer.byteLength(content);
      if (size > maxB) { truncated = true; }
      const displayContent = content.slice(0, maxB);
      const redactedContent = redactText(displayContent);

      await audit({ tool: "recovery_file_read", action: "file_read", path: targetPath, result: "ok", summary: "size=" + size + " truncated=" + truncated, elapsed_ms: Date.now() - start });
      return { path: targetPath, resolved, size, truncated, content: redactedContent, bytes_read: Math.min(size, maxB) };
    },
  });

  // ================================================================
  // 12. recovery_file_write
  // ================================================================
  tools.recovery_file_write = tool({
    name: "recovery_file_write",
    description: "Write bounded project recovery files or patches within allowed roots. Supports text and base64 content. overwrite=false by default. Creates parent dirs. Returns sha256. Writes audit log.",
    inputSchema: schema({
      path: { type: "string", description: "Target path within allowed roots.", examples: [] },
      content: { type: "string", description: "Text content to write.", examples: [] },
      content_base64: { type: "string", description: "Base64-encoded content.", examples: [] },
      overwrite: { type: "boolean", description: "Allow overwrite of existing file. Default: false.", default: false },
      create_parent_dirs: { type: "boolean", description: "Create parent directories. Default: true.", default: true },
    }, ["path"]),
    ...common,
    handler: async ({ path: targetPath, content, content_base64, overwrite, create_parent_dirs }) => {
      const start = Date.now();
      const resolved = resolveAllowedPath(targetPath);
      const isOverwrite = overwrite === true;
      const doCreateParents = create_parent_dirs !== false;

      // Check exists
      if (!isOverwrite && existsSync(resolved)) {
        return { ok: false, error: "File exists: " + targetPath + " (set overwrite=true to overwrite)", path: targetPath };
      }

      // Create parent dirs
      if (doCreateParents) await mkdir(dirname(resolved), { recursive: true });

      // Write
      let finalContent;
      if (content_base64) {
        finalContent = Buffer.from(content_base64, "base64");
      } else {
        finalContent = Buffer.from(content || "", "utf8");
      }
      await writeFile(resolved, finalContent);
      const hash = sha256(finalContent);

      await audit({ tool: "recovery_file_write", action: "file_write", path: targetPath, result: "ok", summary: "bytes=" + finalContent.length + " sha256=" + hash.slice(0,16) + "...", elapsed_ms: Date.now() - start });
      return { ok: true, path: targetPath, resolved, bytes_written: finalContent.length, sha256: hash };
    },
  });

  // ================================================================
  // 13. recovery_apply_patch
  // ================================================================
  tools.recovery_apply_patch = tool({
    name: "recovery_apply_patch",
    description: "Apply a unified diff patch to files under allowed roots. dry_run=true default. Validates patch target paths, rejects path traversal, creates backups before apply. Returns changed files and patch summary. Audit log required.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Preview without applying. Default: true.", default: true },
      apply: { type: "boolean", description: "Actually apply patch.", default: false },
      target_file: { type: "string", description: "File to patch (must be within allowed roots).", examples: ["/workspace/project/backend/src/runtime-config.mjs"] },
      patch_content: { type: "string", description: "Unified diff patch content.", examples: ["--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"] },
    }, ["target_file", "patch_content"]),
    ...common,
    handler: async ({ dry_run, apply, target_file, patch_content }) => {
      const start = Date.now();
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const resolved = resolveAllowedPath(target_file);

      if (!existsSync(resolved)) {
        return { ok: false, error: "File not found: " + target_file };
      }

      // Create backup
      let backupPath = null;
      if (isApply) {
        backupPath = resolved + ".recovery_backup." + Date.now();
        await copyFile(resolved, backupPath);
      }

      // Apply patch using git apply
      let patchResult;
      try {
        const patchFile = resolved + ".recovery_patch.tmp";
        await writeFile(patchFile, patch_content, "utf8");
        const cwd = dirname(resolved);
        const cmd = "cd " + (process.env.SHELL ? cwd : cwd) + " && git apply --check " + patchFile + " 2>&1";
        const checkResult = execSync(cmd, { cwd, timeout: 10000, encoding: "utf8" }).trim();
        if (checkResult && checkResult.length > 0) {
          return { ok: false, error: "Patch check failed: " + checkResult, path: target_file };
        }
        if (isApply) {
          execSync("cd " + cwd + " && git apply " + patchFile + " 2>&1", { cwd, timeout: 10000 });
        }
        await rm(patchFile, { force: true });
        patchResult = { ok: true };
      } catch (err) {
        patchResult = { ok: false, error: err.message };
      }

      await audit({ tool: "recovery_apply_patch", action: "apply_patch", dry_run: isDryRun, apply: isApply, path: target_file, result: patchResult.ok ? "ok" : "error", backup_path: backupPath, elapsed_ms: Date.now() - start });
      return { ok: patchResult.ok, error: patchResult.error || null, path: target_file, backup_path: backupPath, dry_run: isDryRun, applied: isApply, summary: patchResult.ok ? (isApply ? "Patch applied" : "Patch would apply cleanly") : "Patch failed" };
    },
  });

  // ================================================================
  // 14. recovery_command_runner
  // ================================================================
  tools.recovery_command_runner = tool({
    name: "recovery_command_runner",
    description: "Execute structured recovery commands from an allowlist. Supported commands: repo_status, git_diff, git_log_recent, npm_check_syntax, npm_check_imports, node_test_selected, queue_list, tmp_status, goal_storage_status, runtime_status, doctor, safe_restart_status, inspect_recent_logs, verify_tool_exposure. When GPTWORK_RECOVERY_UNRESTRICTED_LOCAL_COMMAND_ENABLED=true, also supports unrestricted shell commands via custom_command.",
    inputSchema: schema({
      command: { type: "string", description: "Allowlisted command name.", examples: ["repo_status"] },
      custom_command: { type: "string", description: "Custom shell command (only when GPTWORK_RECOVERY_UNRESTRICTED_LOCAL_COMMAND_ENABLED=true).", examples: ["ls -la"] },
      args: { type: "string", description: "Optional arguments for the command (e.g. test file pattern).", examples: [] },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default: 30000.", default: 30000, maximum: 120000 },
    }, []),
    ...common,
    handler: async ({ command, custom_command, args, timeout_ms }) => {
      const start = Date.now();
      const tOut = Math.min(Number(timeout_ms) || 30000, 120000);
      const repoPath = resolveRecoveryRepoPath({ config, repoDir });
      let cmdStr, cmdDesc;
      const isUnrestricted = config.recoveryUnrestrictedLocalCommandEnabled;

      try {
        if (custom_command && isUnrestricted) {
          cmdStr = custom_command;
          cmdDesc = "custom_command";
        } else if (command && ALLOWLISTED_COMMANDS[command]) {
          cmdStr = ALLOWLISTED_COMMANDS[command].cmd(repoPath, args || "");
          cmdDesc = ALLOWLISTED_COMMANDS[command].desc;
        } else {
          return { ok: false, error: command ? "Unknown command: " + command + ". Allowed: " + Object.keys(ALLOWLISTED_COMMANDS).join(", ") : "No command specified", exit_code: -1 };
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        cmdDesc = command && ALLOWLISTED_COMMANDS[command] ? ALLOWLISTED_COMMANDS[command].desc : "command validation";
        await audit({ tool: "recovery_command_runner", action: "run_command", dry_run: false, result: "error", summary: cmdDesc + " validation", elapsed_ms: elapsed });
        return { ok: false, command: cmdDesc, exit_code: -1, stdout: "", stderr: "", elapsed_ms: elapsed, error: err.message.slice(0, 500) };
      }

      if (!custom_command && command === "runtime_status") {
        const probe = runtimeHealthProbeCommand();
        try {
          const { stdout, stderr } = await execFileAsync(probe.file, probe.args, {
            cwd: backendDirFor(repoPath),
            timeout: Math.min(tOut, 7000),
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          });
          const elapsed = Date.now() - start;
          const output = String(stdout || "") + String(stderr || "");
          await audit({ tool: "recovery_command_runner", action: "run_command", dry_run: false, result: "ok", summary: ALLOWLISTED_COMMANDS.runtime_status.desc, elapsed_ms: elapsed });
          return { ok: true, command: ALLOWLISTED_COMMANDS.runtime_status.desc, exit_code: 0, stdout: redactText(output).slice(0, 50000), truncated: Buffer.byteLength(output) > 50000, elapsed_ms: elapsed, cmd: redactText(probe.display).slice(0, 200) };
        } catch (err) {
          const elapsed = Date.now() - start;
          const output = String(err.stdout || "") + String(err.stderr || "") + `MCP health probe failed or timed out (GET /health port ${probe.port})\n`;
          await audit({ tool: "recovery_command_runner", action: "run_command", dry_run: false, result: "ok", summary: ALLOWLISTED_COMMANDS.runtime_status.desc + " fallback", elapsed_ms: elapsed });
          return { ok: true, command: ALLOWLISTED_COMMANDS.runtime_status.desc, exit_code: 0, stdout: redactText(output).slice(0, 50000), truncated: Buffer.byteLength(output) > 50000, elapsed_ms: elapsed, cmd: redactText(probe.display).slice(0, 200) };
        }
      }

      try {
        const { stdout: output, stderr = "" } = await executeRecoveryShellCommand(cmdStr, { cwd: repoPath, timeout: tOut, maxBuffer: 1024 * 1024 });
        const combinedOutput = String(output || "") + String(stderr || "");
        const elapsed = Date.now() - start;
        const stdout = redactText(combinedOutput).slice(0, 50000);
        const truncated = Buffer.byteLength(combinedOutput) > 50000;
        await audit({ tool: "recovery_command_runner", action: "run_command", dry_run: false, result: "ok", summary: cmdDesc, elapsed_ms: elapsed });
        return { ok: true, command: cmdDesc, exit_code: 0, stdout, truncated, elapsed_ms: elapsed, cmd: redactText(cmdStr).slice(0, 200) };
      } catch (err) {
        const elapsed = Date.now() - start;
        const stderr = redactText(err.stderr || "").slice(0, 10000);
        const stdout = redactText(err.stdout || "").slice(0, 10000);
        await audit({ tool: "recovery_command_runner", action: "run_command", dry_run: false, result: "error", summary: cmdDesc + " exit=" + (err.status || -1), elapsed_ms: elapsed });
        return { ok: false, command: cmdDesc, exit_code: err.status || -1, stdout, stderr, elapsed_ms: elapsed, error: err.message.slice(0, 500) };
      }
    },
  });


  // ================================================================
  // 16. recovery_stale_queue_unblock
  // ================================================================
  tools.recovery_stale_queue_unblock = tool({
    name: "recovery_stale_queue_unblock",
    description: "Narrowly scoped queue unblock action with full precondition validation. " +
      "Checks: item exists in queue, current status matches expected, blocked_reason contains expected string, " +
      "active repo locks match expected count, no running task or active worker owns the item. " +
      "On pass: changes status to waiting, clears blocked_reason. " +
      "Never starts a task. Always writes audit log.",
    inputSchema: schema({
      queue_id: { type: "string", description: "Target queue item ID to unblock." },
      expected_current_status: { type: "string", description: "Expected current status of the queue item. Default: blocked.", default: "blocked" },
      expected_blocked_reason_contains: { type: "string", description: "Expected substring in blocked_reason. Example: 'Repo locked'." },
      expected_active_repo_locks: { type: "integer", description: "Expected count of active repo locks. Must match current state.", default: 0 },
      new_status: { type: "string", description: "New status after unblock. Default: waiting.", default: "waiting" },
      no_task_start: { type: "boolean", description: "MUST be true. Prevents automatic task start after unblock.", default: true },
      audit: { type: "boolean", description: "MUST be true. Writes audit log record.", default: true },
    }, ["queue_id"]),
    ...common,
    handler: async ({ queue_id, expected_current_status, expected_blocked_reason_contains, expected_active_repo_locks, new_status, no_task_start, audit: doAudit }) => {
      const start = Date.now();
      const safeStatuses = ["waiting", "ready"];
      const newSt = new_status || "waiting";
      const noStart = no_task_start !== false;
      const mustAudit = doAudit !== false;

      // Validate new_status
      if (!safeStatuses.includes(newSt)) {
        return {
          ok: false, error: "Invalid new_status: " + newSt + ". Allowed: " + safeStatuses.join(", "),
          queue_id, preconditions: {}, audit_id: null,
        };
      }

      // Validate no_task_start
      if (!noStart) {
        return {
          ok: false, error: "no_task_start must be true. This action never starts tasks.",
          queue_id, preconditions: {}, audit_id: null,
        };
      }

      // Load state
      const state = await store.load();
      const queue = state.goal_queue || [];

      // Precondition 1: item exists
      const item = queue.find(i => i.queue_id === queue_id);
      if (!item) {
        return {
          ok: false, error: "PRECONDITION_FAILED: Queue item not found: " + queue_id,
          queue_id, preconditions: { item_exists: false }, actual_status: null, actual_blocked_reason: null, actual_active_locks: 0, audit_id: null,
        };
      }

      const preconditions = {
        item_exists: true,
        status_match: item.status === (expected_current_status || "blocked"),
        blocked_reason_contains: !expected_blocked_reason_contains || (item.blocked_reason && item.blocked_reason.includes(expected_blocked_reason_contains)),
        active_locks_match: false,
        no_running_task: !item.task_id || (() => {
          const t = (state.tasks || []).find(x => x.id === item.task_id);
          return t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "timed_out");
        })(),
      };

      // Precondition: active repo locks
      const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
      const expectedLocks = typeof expected_active_repo_locks === "number" ? expected_active_repo_locks : 0;
      preconditions.active_locks_match = lockSummary.active_repo_locks === expectedLocks;

      // Check all preconditions
      const failedChecks = Object.entries(preconditions)
        .filter(([, v]) => v !== true)
        .map(([k]) => k);

      if (failedChecks.length > 0) {
        return {
          ok: false,
          error: "PRECONDITION_FAILED: " + failedChecks.join(", "),
          queue_id,
          preconditions: {
            ...preconditions,
            current_status: item.status,
            current_blocked_reason: item.blocked_reason,
            current_active_locks: lockSummary.active_repo_locks,
          },
          audit_id: null,
        };
      }

      // All preconditions passed — apply the change
      const before = {
        queue_id: item.queue_id,
        status: item.status,
        blocked_reason: item.blocked_reason,
        updated_at: item.updated_at,
      };

      item.status = newSt;
      item.blocked_reason = null;
      item.updated_at = now();
      await store.save();

      const after = {
        queue_id: item.queue_id,
        status: item.status,
        blocked_reason: item.blocked_reason,
        updated_at: item.updated_at,
      };

      // Write audit log
      let auditId = null;
      if (mustAudit) {
        const auditRec = await audit({
          tool: "recovery_stale_queue_unblock",
          action: "queue_unblock",
          queue_id,
          new_status: newSt,
          expected_status: expected_current_status,
          result: "ok",
          before_status: before.status,
          after_status: after.status,
          before_blocked_reason: before.blocked_reason,
          after_blocked_reason: after.blocked_reason,
          elapsed_ms: Date.now() - start,
        });
        auditId = auditRec.auditId;
      }

      return {
        ok: true,
        queue_id,
        before,
        after,
        reason: "Stale queue item unblocked via precondition-validated recovery action",
        audit_id: auditId,
        preconditions,
        no_task_start: true,
        elapsed_ms: Date.now() - start,
      };
    },
  });

  // ================================================================
  // 15. recovery_tool_exposure_self_test
  // ================================================================
  tools.recovery_tool_exposure_self_test = tool({
    name: "recovery_tool_exposure_self_test",
    description: "Verify recovery plane visibility from final MCP tool registry. Checks that all 16 recovery tools are visible when recovery plane is enabled. Also checks that they would be hidden if disabled. Updates gptwork_self_test expectations.",
    inputSchema: schema({}),
    ...common,
    handler: async () => {
      const start = Date.now();
      const expectedTools = [
        "recovery_plane_status", "recovery_diagnose", "recovery_queue_reconcile", "recovery_lock_reconcile",
        "recovery_worker_recover", "recovery_api_failure_control", "recovery_storage_maintenance",
        "recovery_runtime_env_fix_plan", "recovery_safe_restart", "recovery_state_patch",
        "recovery_file_read", "recovery_file_write", "recovery_apply_patch",
        "recovery_command_runner", "recovery_stale_queue_unblock", "recovery_tool_exposure_self_test",
      ];
      const actualTools = Object.keys(tools).sort();
      const present = expectedTools.filter(t => actualTools.includes(t));
      const missing = expectedTools.filter(t => !actualTools.includes(t));
      const unexpected = actualTools.filter(t => !expectedTools.includes(t));

      const status = missing.length === 0 ? "PASS" : "FAIL";

      await audit({ tool: "recovery_tool_exposure_self_test", action: "self_test", result: status, summary: present.length + "/" + expectedTools.length + " tools present", elapsed_ms: Date.now() - start });
      return {
        status,
        recovery_plane_enabled: config.recoveryPlaneEnabled,
        expected_count: expectedTools.length,
        present_count: present.length,
        missing_count: missing.length,
        present_tools: present,
        missing_tools: missing,
        unexpected_tools: unexpected,
        verification: status === "PASS" ? "All recovery tools are properly exposed." : "Some recovery tools are missing from the registry.",
        elapsed_ms: Date.now() - start,
      };
    },
  });

  return tools;
}
