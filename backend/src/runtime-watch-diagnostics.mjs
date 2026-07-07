/**
 * runtime-watch-diagnostics.mjs — AFC-10 Runtime Watch Self-Heal
 *
 * Unified runtime diagnostics and self-heal coverage for queue, lock, and
 * worker states.  Detects stale locks, terminal tasks left running, and
 * eligible queue items blocked by stale state.  Recommends safe recovery
 * actions and supports dry-run diagnostics.
 *
 * System domains:
 *   1. REPO LOCKS   — Locks whose owning task is terminal or does not exist
 *   2. TASK STATE   — Tasks marked "running" whose run metadata is stale
 *   3. QUEUE STATE  — Queue items blocked by resolved dependencies or
 *                     stale repo locks
 *
 * All detection functions support pure diagnostics (dryRun=true).  Recovery
 * functions accept a dryRun flag; when dryRun=true they return the action
 * description without mutating state.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLocksDir, STALL_THRESHOLD_MS } from "./repo-lock-paths.mjs";
import {
  TASK_STATUSES,
  isTerminalStatus,
  isCompletedStatus,
  isFailedTerminalStatus,
} from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * If a running task's latest heartbeat is older than this, it is considered
 * stale.  Default is 15 minutes (matches STALL_THRESHOLD_MS).
 */
const DEFAULT_RUN_STALL_MS = STALL_THRESHOLD_MS;

/**
 * Path where codex-run metadata files are stored under a workspace.
 */
const RUN_META_DIR = ".gptwork/tasks";

// ---------------------------------------------------------------------------
// Recovery action schema
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RecoveryAction
 * @property {"release_lock"|"mark_task_terminal"|"unblock_queue_item"|"notify_review"|"noop"} action
 * @property {"safe"|"needs_review"} safety
 * @property {string} description — Human-readable description
 * @property {object} target — { domain: "lock"|"task"|"queue", id: string }
 * @property {boolean} is_dry_run
 */

// ---------------------------------------------------------------------------
// Domain 1: Stale lock detection
// ---------------------------------------------------------------------------

/**
 * Detect repo locks whose owning task is terminal, non-existent, or whose
 * heartbeat has exceeded the stall threshold.
 *
 * A "stale" lock is one that:
 *   a) Has status "held" but the owning task is in a terminal state
 *      (completed, failed, blocked, cancelled, timed_out)
 *   b) Has status "held" but the owning task ID does not exist in state
 *   c) Has status "held" with a heartbeat age > STALL_THRESHOLD_MS and
 *      the process is no longer alive (coarse PID check)
 *
 * @param {string} workspaceRoot — Workspace root path
 * @param {object} store — State store (for task lookup)
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] — When true, only report, do not mutate
 * @returns {Promise<object>} { stale_locks: Array<object>, summary: object }
 */
export async function detectStaleLocks(workspaceRoot, store, { dryRun = true } = {}) {
  if (!workspaceRoot) {
    return { stale_locks: [], summary: { total_locks: 0, stale: 0, active: 0 } };
  }

  const lockDir = getLocksDir(workspaceRoot);
  if (!existsSync(lockDir)) {
    return { stale_locks: [], summary: { total_locks: 0, stale: 0, active: 0 } };
  }

  const state = await store.load();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const taskMap = new Map(tasks.filter(t => t && t.id).map(t => [t.id, t]));

  const now = Date.now();
  const staleLocks = [];
  let totalLocks = 0;
  let activeCount = 0;
  let staleCount = 0;

  try {
    const entries = await readdir(lockDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const lockPath = join(lockDir, entry.name);
      let lockData;
      try {
        lockData = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        continue;
      }

      totalLocks++;

      // Already released or stale — skip for active-stale detection
      if (lockData.status === "released") continue;
      if (lockData.status === "stale") {
        staleCount++;
        continue;
      }

      // status === "held" — check if still valid
      const taskId = lockData.task_id;
      let isStale = false;
      let staleReasons = [];

      // (a) Task does not exist in state
      const owningTask = taskId ? taskMap.get(taskId) : null;
      if (taskId && !owningTask) {
        isStale = true;
        staleReasons.push(`owning task ${taskId} not found in state`);
      }

      // (b) Task exists but is in a terminal state
      if (owningTask && isTerminalStatus(owningTask.status)) {
        isStale = true;
        staleReasons.push(`owning task ${taskId} status=${owningTask.status} (terminal)`);
      }

      // (c) Heartbeat age exceeds threshold AND process not alive
      const lastHb = lockData.last_heartbeat_at || lockData.acquired_at;
      const ageMs = now - new Date(lastHb).getTime();
      let processAlive = false;
      for (const pidField of ["child_pid", "pid"]) {
        const pid = lockData[pidField];
        if (pid && typeof pid === "number" && pid > 0) {
          try {
            process.kill(pid, 0);
            processAlive = true;
            break;
          } catch {
            // Process not found
          }
        }
      }

      // If already stale from (a)/(b), skip heartbeat double-check
      if (!isStale) {
        if (ageMs > STALL_THRESHOLD_MS && !processAlive) {
          isStale = true;
          staleReasons.push(`heartbeat stale (age=${Math.round(ageMs / 1000)}s, threshold=${STALL_THRESHOLD_MS / 1000}s, no active process)`);
        } else {
          // Heartbeat within threshold or process alive — lock is active
          activeCount++;
          continue;
        }
      }

      staleCount++;
      staleLocks.push({
          lock_path: lockPath,
          safe_repo_id: lockData.safe_repo_id || entry.name.replace(/\.json$/, ""),
          task_id: taskId || null,
          run_id: lockData.run_id || null,
          acquired_at: lockData.acquired_at,
          last_heartbeat_at: lockData.last_heartbeat_at,
          stale_reasons: staleReasons,
          task_status: owningTask?.status || "(task not found)",
          detected_at: new Date().toISOString(),
          diagnostic_level: "blocker",
          recovery: {
            action: "release_lock",
            safety: "safe",
            description: `Release stale lock for task ${taskId || "unknown"} — ${staleReasons.join("; ")}`,
          },
        });
    }
  } catch {
    // Non-fatal
  }

  return {
    stale_locks: staleLocks,
    summary: {
      total_locks: totalLocks,
      stale: staleCount,
      active: activeCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Domain 2: Terminal tasks left running
// ---------------------------------------------------------------------------

/**
 * Detect tasks marked "running" whose run metadata indicates the Codex
 * process has stopped without updating task status.
 *
 * Checks:
 *   1. Run metadata last_heartbeat is older than stall threshold and
 *      Codex child process is not alive
 *   2. Run metadata has result_json_path pointing to an existing result.json
 *      that has a terminal status, but the task itself is still "running"
 *   3. Repo lock for the task has been released while the task is still
 *      marked "running"
 *
 * @param {object} state — Loaded state with tasks[]
 * @param {string} workspaceRoot — Workspace root for run metadata lookup
 * @param {object} [options]
 * @param {number} [options.stallThresholdMs=DEFAULT_RUN_STALL_MS]
 * @returns {Promise<object>} { terminal_tasks_running: Array<object>, summary: object }
 */
export async function detectTerminalTasksRunning(state, workspaceRoot, { stallThresholdMs = DEFAULT_RUN_STALL_MS } = {}) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const findings = [];
  const now = Date.now();

  for (const task of tasks) {
    if (task.status !== "running") continue;

    const reasons = [];
    const taskId = task.id;

    // Check result.json in goal directory
    const goalId = task.goal_id;
    let resultJsonTerminal = false;
    let resultJsonStatus = null;

    if (goalId && workspaceRoot) {
      const resultPath = join(workspaceRoot, ".gptwork/goals", goalId, "result.json");
      if (existsSync(resultPath)) {
        try {
          const raw = await readFile(resultPath, "utf8");
          const parsed = JSON.parse(raw);
          resultJsonStatus = parsed.status;
          if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "timed_out") {
            resultJsonTerminal = true;
            reasons.push(`result.json found with terminal status "${parsed.status}"`);
          }
        } catch {
          // Parse error — not helpful for detection
        }
      }
    }

    // Check run metadata
    let runStale = false;
    let runAgeMs = 0;
    let runProcessAlive = false;

    if (workspaceRoot) {
      const taskDir = join(workspaceRoot, RUN_META_DIR, taskId);
      if (existsSync(taskDir)) {
        try {
          const runEntries = await readdir(taskDir, { withFileTypes: true });
          // Find the latest run file
          let latestRun = null;
          let latestRunPath = null;
          for (const runEntry of runEntries) {
            if (!runEntry.isFile() || !runEntry.name.endsWith(".json")) continue;
            const rp = join(taskDir, runEntry.name);
            try {
              const runData = JSON.parse(await readFile(rp, "utf8"));
              if (runData.run_id) {
                const hb = runData.last_heartbeat_at || runData.created_at;
                if (!latestRun || (hb && new Date(hb).getTime() > new Date(latestRun.last_heartbeat_at || latestRun.created_at).getTime())) {
                  latestRun = runData;
                  latestRunPath = rp;
                }
              }
            } catch {}
          }

          if (latestRun) {
            const hb = latestRun.last_heartbeat_at || latestRun.created_at;
            runAgeMs = now - new Date(hb).getTime();

            // Check process alive
            if (latestRun.codex_child_pid && typeof latestRun.codex_child_pid === "number" && latestRun.codex_child_pid > 0) {
              try {
                process.kill(latestRun.codex_child_pid, 0);
                runProcessAlive = true;
              } catch {
                // dead
              }
            }

            // Check if run has a terminal phase
            if (latestRun.phase === "completed" || latestRun.phase === "finished" || latestRun.phase === "failed") {
              runStale = true;
              reasons.push(`run metadata phase="${latestRun.phase}" indicates Codex process finished`);
            }

            if (!runProcessAlive && runAgeMs > stallThresholdMs) {
              runStale = true;
              reasons.push(`heartbeat stale (age=${Math.round(runAgeMs / 1000)}s, threshold=${stallThresholdMs / 1000}s, no active Codex process)`);
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    // Check for released repo lock
    let lockReleased = false;
    if (workspaceRoot) {
      const lockDir = getLocksDir(workspaceRoot);
      if (existsSync(lockDir)) {
        try {
          const entries = await readdir(lockDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const lp = join(lockDir, entry.name);
            try {
              const ld = JSON.parse(await readFile(lp, "utf8"));
              if (ld.task_id === taskId && ld.status === "released") {
                lockReleased = true;
                reasons.push("repo lock released while task still marked running");
              }
            } catch {}
          }
        } catch {}
      }
    }

    // Check for existing terminal result in task.result
    const taskResult = task.result || {};
    if (taskResult.reconciled_at) {
      // Task has been reconciled before but is still running — terminal anomaly
      if (taskResult.status === "completed" || taskResult.status === "failed" || taskResult.kind?.startsWith("stale_") || taskResult.kind?.startsWith("codex_stalled")) {
        runStale = true;
        reasons.push(`task already reconciled with kind="${taskResult.kind || taskResult.status}" but status remains running`);
      }
    }

    // If the closure decision already says completed but task is running
    if (taskResult.closure_decision?.status === "auto_completed_clean" || taskResult.finalizer_decision?.status === "completed") {
      runStale = true;
      reasons.push(`task result has terminal closure (${taskResult.closure_decision?.status || taskResult.finalizer_decision?.status}) but status remains running`);
    }

    if (runStale || resultJsonTerminal || lockReleased) {
      let recommendedStatus;
      if (resultJsonStatus === "completed" || taskResult.status === "completed") {
        recommendedStatus = "completed";
      } else if (resultJsonStatus === "failed" || resultJsonStatus === "timed_out" || isFailedTerminalStatus(taskResult.status)) {
        recommendedStatus = "failed";
      } else if (lockReleased) {
        recommendedStatus = "waiting_for_review";
      } else {
        recommendedStatus = "waiting_for_review";
      }

      findings.push({
        task_id: taskId,
        goal_id: goalId,
        status: "running",
        recommended_status: recommendedStatus,
        reasons,
        run_age_ms: runAgeMs,
        process_alive: runProcessAlive,
        has_terminal_result_json: resultJsonTerminal,
        lock_released: lockReleased,
        detected_at: new Date().toISOString(),
        diagnostic_level: "blocker",
        recovery: {
          action: "mark_task_terminal",
          safety: recommendedStatus === "completed" ? "safe" : "needs_review",
          description: `Mark task ${taskId} as ${recommendedStatus} — ${reasons.join("; ")}`,
        },
      });
    }
  }

  return {
    terminal_tasks_running: findings,
    summary: {
      total_running: tasks.filter(t => t.status === "running").length,
      terminal_tasks_running: findings.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Domain 3: Queue items blocked by stale state
// ---------------------------------------------------------------------------

/**
 * Detect queue items in "blocked" status whose blocking condition has
 * resolved but the item was not updated.
 *
 * Integrates with existing queue-reconciler's detectStaleBlockers and
 * adds lock-aware stale detection: queue items blocked by repo locks
 * where the lock is now released or stale.
 *
 * @param {object} state — Full state object with goal_queue[]
 * @param {object} lockDiagnostics — Result from detectStaleLocks()
 * @param {object} [options]
 * @returns {object} { stale_queue_blockers: Array<object>, summary: object }
 */
export async function detectStaleQueueBlockers(state, lockDiagnostics = { stale_locks: [], summary: { stale: 0 } }) {
  const items = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const staleLocksByTask = new Map();

  for (const sl of (lockDiagnostics.stale_locks || [])) {
    if (sl.task_id) staleLocksByTask.set(sl.task_id, sl);
  }

  const findings = [];

  for (const item of items) {
    if (item.status !== "blocked") continue;

    const reasons = [];
    let isStale = false;

    // Check if item was blocked due to a repo lock that is now stale/released
    const blockedReason = (item.blocked_reason || "").toLowerCase();
    if (blockedReason.includes("lock") || blockedReason.includes("repo")) {
      // Try to find the repo_id from the queue item or its task
      if (item.repo_id) {
        // Check if there are any stale locks for this item's referenced tasks
        // If the lock has been released or marked stale, the queue item is stale
        if (staleLocksByTask.size > 0) {
          // If the blockage was about an active lock and now that lock is stale,
          // unblock the item
          isStale = true;
          reasons.push("blocked by repo lock condition that is now stale/resolved");
        }
      }

      // Check if there are zero active locks (all locks are released/stale)
      // — if so, the repo lock concern has resolved
      if (!isStale && lockDiagnostics.summary) {
        const activeCount = lockDiagnostics.summary.active || 0;
        if (activeCount === 0) {
          isStale = true;
          reasons.push("no active repo locks remaining — lock concern has resolved");
        }
      }
    }

    // Integrate with queue-reconciler's stale detection
    const { detectStaleBlockers } = await importLazy("./queue-reconciler.mjs");
    const reconcilerStale = detectStaleBlockers(state);
    const itemStale = reconcilerStale.find(s => s.queue_id === item.queue_id);
    if (itemStale && itemStale.stale_type === "dependency_resolved") {
      isStale = true;
      reasons.push(`dependency resolved: ${itemStale.detail}`);
    }

    if (isStale) {
      findings.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        position: item.position,
        current_status: item.status,
        blocked_reason: item.blocked_reason || "(no reason)",
        stale_reasons: reasons,
        detected_at: new Date().toISOString(),
        diagnostic_level: "info",
        recovery: {
          action: "unblock_queue_item",
          safety: "safe",
          description: `Unblock queue item ${item.queue_id} for goal ${item.goal_id} — ${reasons.join("; ")}`,
        },
      });
    }
  }

  return {
    stale_queue_blockers: findings,
    summary: {
      total_blocked: items.filter(i => i.status === "blocked").length,
      stale_blockers: findings.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

async function importLazy(modulePath) {
  try {
    return await import(modulePath);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Full runtime watch diagnostics
// ---------------------------------------------------------------------------

/**
 * Run all three domain diagnostics (locks, tasks, queue) and produce a
 * comprehensive runtime health report.
 *
 * @param {object} options
 * @param {object} options.store — State store
 * @param {string} options.workspaceRoot — Workspace root path
 * @param {object} [options.config] — Runtime config (passed to domain diagnostics)
 * @param {boolean} [options.dryRun=true] — When true, no state mutation
 * @returns {Promise<object>} Comprehensive diagnostic report
 */
export async function runWatchDiagnostics({ store, workspaceRoot, config = {}, dryRun = true } = {}) {
  const state = await store.load();

  // Domain 1: Repo locks
  const lockResult = await detectStaleLocks(workspaceRoot, store, { dryRun });

  // Domain 2: Terminal tasks left running
  const taskResult = await detectTerminalTasksRunning(state, workspaceRoot);

  // Domain 3: Queue items blocked by stale state
  const queueResult = await detectStaleQueueBlockers(state, lockResult);

  // Aggregate findings and build recovery actions
  const allFindings = [
    ...lockResult.stale_locks.map(f => ({ ...f, domain: "lock" })),
    ...taskResult.terminal_tasks_running.map(f => ({ ...f, domain: "task" })),
    ...queueResult.stale_queue_blockers.map(f => ({ ...f, domain: "queue" })),
  ];

  const recoveryActions = allFindings
    .filter(f => f.recovery)
    .map(f => ({
      ...f.recovery,
      target: { domain: f.domain, id: f.task_id || f.queue_id || f.safe_repo_id || f.lock_path },
      is_dry_run: dryRun,
    }));

  const summary = {
    timestamp: new Date().toISOString(),
    dry_run: dryRun,
    total_findings: allFindings.length,
    domains: {
      locks: lockResult.summary,
      tasks: taskResult.summary,
      queue: queueResult.summary,
    },
    total_recovery_actions: recoveryActions.length,
    safe_actions: recoveryActions.filter(a => a.safety === "safe").length,
    needs_review: recoveryActions.filter(a => a.safety === "needs_review").length,
  };

  return {
    summary,
    findings: {
      stale_locks: lockResult.stale_locks,
      terminal_tasks_running: taskResult.terminal_tasks_running,
      stale_queue_blockers: queueResult.stale_queue_blockers,
    },
    recovery_actions: recoveryActions,
  };
}

// ---------------------------------------------------------------------------
// Safe recovery actions (state-mutating)
// ---------------------------------------------------------------------------

/**
 * Execute safe recovery actions based on diagnostic findings.
 *
 * Currently supports these safe actions:
 *   - release_lock          → mark repo lock as stale (safe, non-destructive)
 *   - mark_task_terminal    → update task status to terminal if safe
 *   - unblock_queue_item    → move queue item from blocked to waiting/ready
 *
 * @param {object} store — State store
 * @param {string} workspaceRoot — Workspace root
 * @param {Array<object>} recoveryActions — Actions to apply (typically from runWatchDiagnostics)
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] — When true, only report what would be done
 * @returns {Promise<object>} { applied_actions: Array, errors: Array, summary: object }
 */
export async function applyRecoveryActions(store, workspaceRoot, recoveryActions = [], { dryRun = true } = {}) {
  const applied = [];
  const errors = [];

  for (const action of recoveryActions) {
    try {
      switch (action.action) {
        case "release_lock": {
          const lockPath = action.target?.id;
          if (!lockPath) {
            errors.push({ action: action.action, target: action.target, error: "no lock path in target" });
            continue;
          }
          if (!dryRun) {
            // Read current lock data to preserve structure, then mark stale
            try {
              const lockData = JSON.parse(await readFile(lockPath, "utf8"));
              lockData.status = "stale";
              lockData.stale_reason = action.description || "Released by runtime-watch recovery";
              lockData.stale_at = new Date().toISOString();
              const { writeFile } = await import("node:fs/promises");
              await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");
            } catch (fileErr) {
              errors.push({ action: "release_lock", target: action.target, error: fileErr.message });
              continue;
            }
          }
          applied.push({
            action: "release_lock",
            target: action.target,
            description: action.description,
            is_dry_run: dryRun,
          });
          break;
        }

        case "mark_task_terminal": {
          const taskId = action.target?.id;
          if (!taskId) {
            errors.push({ action: "mark_task_terminal", target: action.target, error: "no task id in target" });
            continue;
          }

          if (!dryRun) {
            await store.mutate(state => {
              const task = (state.tasks || []).find(t => t && t.id === taskId);
              if (!task) {
                errors.push({ action: "mark_task_terminal", target: action.target, error: `task ${taskId} not found in state` });
                return state;
              }

              // Determine terminal status from the recovery description
              let terminalStatus = "waiting_for_review";
              if (action.description?.includes("completed") || action.description?.includes("terminal")) {
                // Find the recommended_status from the finding
                const finding = (action.target?.domain === "task") ? null : null;
                // Default safe terminal: if result.json says completed, use that
                terminalStatus = task.result?.status === "completed" ? "completed"
                  : task.result?.status === "failed" ? "failed"
                  : "waiting_for_review";
              }

              const prevStatus = task.status;
              task.status = terminalStatus;
              task.updated_at = new Date().toISOString();
              task.result = task.result || {};
              task.result.terminal_at = task.updated_at;
              task.result.watch_reconciled = true;
              task.logs = task.logs || [];
              task.logs.push({
                time: task.updated_at,
                message: `[runtime-watch] recovery: status ${prevStatus} → ${terminalStatus} — ${action.description}`,
              });
              return state;
            });
          }

          applied.push({
            action: "mark_task_terminal",
            target: action.target,
            description: action.description,
            is_dry_run: dryRun,
          });
          break;
        }

        case "unblock_queue_item": {
          const queueId = action.target?.id;
          if (!queueId) {
            errors.push({ action: "unblock_queue_item", target: action.target, error: "no queue id in target" });
            continue;
          }

          if (!dryRun) {
            await store.mutate(state => {
              const item = Array.isArray(state.goal_queue)
                ? state.goal_queue.find(qi => qi.queue_id === queueId)
                : null;
              if (!item) {
                errors.push({ action: "unblock_queue_item", target: action.target, error: `queue item ${queueId} not found in state` });
                return state;
              }
              const prevStatus = item.status;
              item.status = "waiting";
              item.blocked_reason = null;
              item.updated_at = new Date().toISOString();
              return state;
            });
          }

          applied.push({
            action: "unblock_queue_item",
            target: action.target,
            description: action.description,
            is_dry_run: dryRun,
          });
          break;
        }

        default:
          errors.push({ action: action.action, target: action.target, error: `unknown action type: ${action.action}` });
          break;
      }
    } catch (err) {
      errors.push({ action: action.action, target: action.target, error: err.message });
    }
  }

  return {
    applied_actions: applied,
    errors,
    summary: {
      total_actions: recoveryActions.length,
      applied: applied.length,
      errors: errors.length,
      dry_run: dryRun,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format runtime watch diagnostics as a human-readable card string.
 *
 * @param {object} report — Result from runWatchDiagnostics()
 * @returns {string} Formatted card content
 */
export function formatWatchDiagnosticsCard(report) {
  if (!report) return "  No runtime watch data.";

  const lines = [];
  const s = report.summary || {};

  lines.push("  Runtime Watch Diagnostics:");
  lines.push(`    dry_run:         ${s.dry_run ? "yes" : "no"}`);
  lines.push(`    total_findings:  ${s.total_findings}`);
  lines.push(`    safe_actions:    ${s.safe_actions}`);
  lines.push(`    needs_review:    ${s.needs_review}`);
  lines.push("");

  // Domain: Locks
  const locks = s.domains?.locks || {};
  lines.push("  Repo Locks:");
  lines.push(`    total:   ${locks.total_locks || 0}`);
  lines.push(`    active:  ${locks.active || 0}`);
  lines.push(`    stale:   ${locks.stale || 0}`);
  const staleLocks = report.findings?.stale_locks || [];
  for (const sl of staleLocks.slice(0, 5)) {
    lines.push(`    - stale lock ${sl.safe_repo_id}: ${sl.stale_reasons?.join("; ") || "unknown"}`);
    if (sl.recovery) lines.push(`      → ${sl.recovery.action}: ${sl.recovery.description}`);
  }
  if (staleLocks.length > 5) {
    lines.push(`    ... and ${staleLocks.length - 5} more stale lock(s)`);
  }
  lines.push("");

  // Domain: Tasks
  const tasks = s.domains?.tasks || {};
  lines.push("  Running Tasks:");
  lines.push(`    total running:        ${tasks.total_running || 0}`);
  lines.push(`    terminal tasks left:  ${tasks.terminal_tasks_running || 0}`);
  const termTasks = report.findings?.terminal_tasks_running || [];
  for (const tt of termTasks.slice(0, 5)) {
    lines.push(`    - task ${tt.task_id}: ${tt.reasons?.join("; ") || "unknown"}`);
    lines.push(`      → recommended: ${tt.recommended_status}`);
    if (tt.recovery) lines.push(`      → ${tt.recovery.action}: ${tt.recovery.description}`);
  }
  if (termTasks.length > 5) {
    lines.push(`    ... and ${termTasks.length - 5} more terminal task(s)`);
  }
  lines.push("");

  // Domain: Queue
  const queue = s.domains?.queue || {};
  lines.push("  Queue Items:");
  lines.push(`    total blocked:    ${queue.total_blocked || 0}`);
  lines.push(`    stale blockers:   ${queue.stale_blockers || 0}`);
  const staleQueue = report.findings?.stale_queue_blockers || [];
  for (const sq of staleQueue.slice(0, 5)) {
    lines.push(`    - queue ${sq.queue_id} (goal ${sq.goal_id}): ${sq.stale_reasons?.join("; ") || "unknown"}`);
    if (sq.recovery) lines.push(`      → ${sq.recovery.action}: ${sq.recovery.description}`);
  }
  if (staleQueue.length > 5) {
    lines.push(`    ... and ${staleQueue.length - 5} more stale blocker(s)`);
  }
  lines.push("");

  // Recovery summary
  const actions = report.recovery_actions || [];
  if (actions.length > 0) {
    lines.push("  Recovery Actions:");
    for (const ra of actions.slice(0, 10)) {
      lines.push(`    ${ra.is_dry_run ? "[DRY] " : ""}[${ra.safety}] ${ra.action} — ${ra.description}`);
    }
    if (actions.length > 10) {
      lines.push(`    ... and ${actions.length - 10} more action(s)`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Convenience: run diagnostics with optional recovery
// ---------------------------------------------------------------------------

/**
 * Run diagnostic watch then optionally apply safe recovery actions.
 *
 * This is the primary entry point for the runtime watch subsystem, intended
 * to be called from the worker loop, reconciler, or CLI.
 *
 * When dryRun is true (default), no state mutation occurs.
 * When dryRun is false, safe recovery actions are applied automatically.
 *
 * @param {object} options
 * @param {object} options.store — State store
 * @param {string} options.workspaceRoot — Workspace root path
 * @param {object} [options.config] — Runtime config
 * @param {boolean} [options.dryRun=true] — When true, no mutation
 * @returns {Promise<object>} { diagnostics, recovery, summary }
 */
export async function runWatchWithRecovery({ store, workspaceRoot, config = {}, dryRun = true } = {}) {
  // Step 1: Run diagnostics (always non-mutating)
  const diagnostics = await runWatchDiagnostics({ store, workspaceRoot, config, dryRun: true });

  // Step 2: Apply recovery (respects dryRun)
  const recovery = await applyRecoveryActions(store, workspaceRoot, diagnostics.recovery_actions, { dryRun });

  // Reload state if recovery was applied
  let stateSummary = null;
  if (!dryRun) {
    const state = await store.load();
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
    stateSummary = {
      running_tasks: tasks.filter(t => t.status === "running").length,
      blocked_queue: queue.filter(i => i.status === "blocked").length,
      terminal_tasks: tasks.filter(t => t.status === "completed" || t.status === "failed").length,
    };
  }

  return {
    diagnostics,
    recovery,
    summary: {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      findings: diagnostics.summary.total_findings,
      actions_applied: recovery.summary.applied,
      actions_errors: recovery.summary.errors,
      state_after_recovery: stateSummary,
    },
  };
}
