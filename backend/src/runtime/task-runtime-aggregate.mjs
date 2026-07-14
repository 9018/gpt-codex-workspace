/**
 * task-runtime-aggregate.mjs — Single-source-of-truth view of task runtime state.
 *
 * Reads from ALL state sources (task, session, process, lock, worktree, evidence)
 * and produces a unified aggregate with a single recommended_action.
 *
 * This is the canonical entry point for all runtime decisions.
 * No caller should read task/session/lock/evidence separately and guess.
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Health classification
// ---------------------------------------------------------------------------

const HEALTH = Object.freeze({
  HEALTHY: "healthy",
  STALLED: "stalled",
  ORPHANED: "orphaned",
  INCONSISTENT: "inconsistent",
  TERMINAL: "terminal",
});

const RECOMMENDED_ACTION = Object.freeze({
  CONTINUE: "continue",
  WAKE: "wake",
  STOP_RETRY: "stop_retry",
  COLLECT: "collect",
  ACCEPT: "accept",
  INTEGRATE: "integrate",
  COMPLETE: "complete",
  FAIL: "fail",
  ASK: "ask",
});

// ---------------------------------------------------------------------------
// PID / process helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid) {
  return isProcessAlive(pid);
}

// ---------------------------------------------------------------------------
// Evidence inspection
// ---------------------------------------------------------------------------

function fileExists(path) {
  if (!path) return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Check what evidence files exist for a task's goal.
 */
function inspectEvidence(options = {}) {
  const { goalId, workspaceRoot, cwd } = options;
  const result = {
    progress_json: false,
    result_json: false,
    verification: false,
    commit: null,
    changed_files: [],
  };

  if (!goalId && !cwd) return result;

  // Check canonical goal dir first, then worktree local
  const roots = [];
  if (workspaceRoot) roots.push(join(workspaceRoot, ".gptwork", "goals", goalId));
  if (cwd) roots.push(join(cwd, ".gptwork", "goals", goalId));

  for (const goalDir of roots) {
    const rjPath = join(goalDir, "result.json");
    const rmPath = join(goalDir, "result.md");
    const vPath = join(goalDir, "verification.json");
    const pPath = join(goalDir, "progress.json");

    if (fileExists(rjPath)) {
      result.result_json = true;
      try {
        const raw = requireFsReadSync(rjPath);
        const parsed = JSON.parse(raw);
        result.commit = parsed.commit || null;
        result.changed_files = Array.isArray(parsed.changed_files) ? parsed.changed_files : [];
      } catch { /* ignore parse errors */ }
    }
    if (fileExists(vPath)) result.verification = true;
    if (fileExists(pPath)) result.progress_json = true;

    // If we found result.json in this root, don't check further
    if (result.result_json) break;
  }

  return result;
}

function requireFsReadSync(path) {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Age helpers
// ---------------------------------------------------------------------------

function ageMs(dateStr, now = Date.now()) {
  if (!dateStr) return Infinity;
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return now - ts;
}

// ---------------------------------------------------------------------------
// Main aggregate builder
// ---------------------------------------------------------------------------

/**
 * Build a TaskRuntimeAggregate from all available state sources.
 *
 * @param {object} options
 * @param {object}   options.task         - Task object from state
 * @param {object}   [options.goal]       - Goal object
 * @param {object}   [options.session]    - Session record
 * @param {object}   [options.lock]       - Lock record
 * @param {object}   [options.worktree]   - Worktree info { path, exists, clean, head, changed_files }
 * @param {string}   [options.workspaceRoot] - Workspace root path
 * @param {number}   [options.now]        - Current timestamp override
 * @param {object}   [options.config]     - Config { noProgressTimeoutMs, wakeGraceMs }
 * @returns {object} TaskRuntimeAggregate
 */
export async function buildTaskRuntimeAggregate(options = {}) {
  const {
    task,
    goal,
    session,
    lock,
    worktree,
    evidence: evidenceOverride,
    workspaceRoot,
    now = Date.now(),
    config = {},
  } = options;

  if (!task) throw new Error("task is required for runtime aggregate");

  const taskId = task.id;
  const goalId = task.goal_id || goal?.id || null;
  const state = task.status || "created";
  const attempt = task.attempt || task.repair_attempt || 0;
  const contract = task.acceptance_contract || goal?.acceptance_contract || {};

  const noProgressTimeoutMs = contract.retry_policy?.no_progress_timeout_ms || config.noProgressTimeoutMs || 180000;
  const wakeGraceMs = contract.retry_policy?.wake_grace_ms || config.wakeGraceMs || 30000;

  // --- Process ---
  const pid = session?.pty_pid || null;
  const processAlive = pid ? processExists(pid) : null;
  const processInfo = {
    pid,
    exists: processAlive,
    last_heartbeat_at: session?.last_process_heartbeat_at || session?.started_at || null,
  };

  // --- Session ---
  const sessionInfo = {
    session_id: session?.id || null,
    exists: Boolean(session && (session.status === "running" || session.status === "created")),
    status: session?.status || null,
    last_output_at: session?.last_output_at || session?.started_at || null,
    last_meaningful_progress_at: session?.last_meaningful_progress_at || session?.started_at || null,
  };

  // --- Lock ---
  const lockInfo = {
    exists: Boolean(lock && lock.status === "acquired"),
    owned_by_task: lock?.task_id === taskId,
    last_heartbeat_at: lock?.last_heartbeat_at || null,
  };

  // --- Worktree ---
  const worktreeInfo = {
    path: worktree?.path || null,
    exists: worktree?.exists === true,
    clean: worktree?.clean !== false,
    head: worktree?.head || null,
    changed_files: Array.isArray(worktree?.changed_files) ? worktree.changed_files : [],
  };

  // --- Evidence ---
  const evidence = evidenceOverride || inspectEvidence({
    goalId,
    workspaceRoot,
    cwd: worktree?.path || session?.cwd,
  });

  // --- Acceptance ---
  const acceptanceInfo = {
    verdict: task.result?.acceptance_verdict || task.result?.unified_decision?.status || null,
    findings: Array.isArray(task.result?.acceptance_findings) ? task.result.acceptance_findings : [],
  };

  // --- Determine health ---
  const health = classifyHealth({ state, processInfo, sessionInfo, lockInfo, evidence, now, config: { noProgressTimeoutMs } });

  // --- Determine recommended action ---
  const recommendedAction = recommendAction({
    state,
    health,
    processInfo,
    sessionInfo,
    evidence,
    acceptanceInfo,
    lockInfo,
    now,
    noProgressTimeoutMs,
    wakeGraceMs,
  });

  return {
    task,
    task_id: taskId,
    goal_id: goalId,
    root_task_id: task.root_task_id || taskId,
    attempt,
    mode: "full",
    state,
    health,
    process: processInfo,
    session: sessionInfo,
    lock: lockInfo,
    worktree: worktreeInfo,
    evidence,
    acceptance: acceptanceInfo,
    recommended_action: recommendedAction,
    aggregated_at: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Health classification
// ---------------------------------------------------------------------------

function classifyHealth({ state, processInfo, sessionInfo, lockInfo, evidence, now, config = {} }) {
  // Terminal states
  if (["completed", "failed", "cancelled"].includes(state)) return HEALTH.TERMINAL;

  // Orphaned: no process, no session, but task thinks it's running
  if (["running", "starting", "collecting", "accepting"].includes(state)) {
    if (processInfo.exists === false && !sessionInfo.exists) return HEALTH.ORPHANED;
  }

  // Stalled: running but no meaningful progress for too long
  if (state === "running" && sessionInfo.last_meaningful_progress_at) {
    const quietTime = ageMs(sessionInfo.last_meaningful_progress_at, now);
    const threshold = Number(config?.noProgressTimeoutMs || 180000);
    if (quietTime > threshold) return HEALTH.STALLED;
  }

  // Inconsistent: task running but lock not owned or process dead
  if (state === "running" && processInfo.exists === false && sessionInfo.exists) return HEALTH.INCONSISTENT;
  if (state === "running" && !lockInfo.owned_by_task && lockInfo.exists) return HEALTH.INCONSISTENT;

  return HEALTH.HEALTHY;
}

// ---------------------------------------------------------------------------
// Action recommendation
// ---------------------------------------------------------------------------

function recommendAction({
  state, health, processInfo, sessionInfo, evidence, acceptanceInfo, lockInfo,
  now, noProgressTimeoutMs, wakeGraceMs,
}) {
  // Terminal states: no action
  if (["completed", "failed", "cancelled"].includes(state)) return RECOMMENDED_ACTION.CONTINUE;

  // Orphaned/inconsistent running tasks: stop and retry
  if (health === HEALTH.ORPHANED || health === HEALTH.INCONSISTENT) {
    return RECOMMENDED_ACTION.STOP_RETRY;
  }

  // Stalled: try wake first, then stop+retry
  if (health === HEALTH.STALLED && state === "running") {
    const quietTime = ageMs(sessionInfo.last_meaningful_progress_at, now);
    if (quietTime > noProgressTimeoutMs + wakeGraceMs) {
      return RECOMMENDED_ACTION.STOP_RETRY;
    }
    if (quietTime > noProgressTimeoutMs) {
      return RECOMMENDED_ACTION.WAKE;
    }
  }

  // Running with result.json ready: collect
  if (state === "running" && evidence.result_json) {
    return RECOMMENDED_ACTION.COLLECT;
  }

  // Collecting with evidence ready: accept
  if (state === "collecting" && evidence.result_json) {
    return RECOMMENDED_ACTION.ACCEPT;
  }

  // Accepting with verdict: integrate or retry
  if (state === "accepting" && acceptanceInfo.verdict) {
    if (acceptanceInfo.verdict === "pass") return RECOMMENDED_ACTION.INTEGRATE;
    if (acceptanceInfo.verdict === "repairable") return RECOMMENDED_ACTION.STOP_RETRY;
    if (acceptanceInfo.verdict === "terminal_fail") return RECOMMENDED_ACTION.FAIL;
    if (acceptanceInfo.verdict === "needs_decision") return RECOMMENDED_ACTION.ASK;
  }

  // Integrating done: complete
  if (state === "integrating" && evidence.verification && evidence.commit) {
    return RECOMMENDED_ACTION.COMPLETE;
  }

  // Default: continue monitoring
  return RECOMMENDED_ACTION.CONTINUE;
}

export { HEALTH, RECOMMENDED_ACTION };
