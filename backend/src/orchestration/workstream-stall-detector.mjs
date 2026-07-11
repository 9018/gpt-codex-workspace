/**
 * workstream-stall-detector.mjs — Detects workstream stall conditions
 * such as dead TUI sessions, stale worker/lock, and terminal task/queue
 * mismatch.
 *
 * Stall conditions detected:
 *   1. dead_tui       — TUI session is dead (no heartbeat, no output)
 *   2. stale_worker   — Codex worker assigned but not progressing
 *   3. stale_lock     — Lock held for too long without progress
 *   4. terminal_mismatch — Task queue has terminal tasks not reconciled
 *
 * Idempotent: Same state always returns same stall detection results.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STALL_TYPE = Object.freeze({
  DEAD_TUI: "dead_tui",
  STALE_WORKER: "stale_worker",
  STALE_LOCK: "stale_lock",
  TERMINAL_MISMATCH: "terminal_mismatch",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hoursAgo(isoString, now = Date.now()) {
  if (!isoString) return Infinity;
  const ts = new Date(isoString).getTime();
  if (Number.isNaN(ts)) return Infinity;
  return (now - ts) / (1000 * 60 * 60);
}

function minutesAgo(isoString, now = Date.now()) {
  return hoursAgo(isoString, now) * 60;
}

// ---------------------------------------------------------------------------
// Stall checks
// ---------------------------------------------------------------------------

/**
 * Check for dead TUI session — TUI has no heartbeat or no recent output.
 *
 * @param {object} options
 * @param {object} [options.tuiSession={}] - TUI session object with metadata
 * @param {number} [options.maxHeartbeatAgeMinutes=10] - Max age of last heartbeat
 * @param {number} [options.maxOutputIdleMinutes=30] - Max idle time since last output
 * @returns {{ stalled: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectDeadTuiStall({
  tuiSession = {},
  maxHeartbeatAgeMinutes = 10,
  maxOutputIdleMinutes = 30,
} = {}) {
  if (!tuiSession.session_id && !tuiSession.id) {
    // No TUI session exists — cannot be dead
    return { stalled: false, type: null, code: "no_tui_session", message: "No TUI session exists.", detail: null };
  }

  const now = Date.now();
  const lastHeartbeat = tuiSession.last_heartbeat_at || tuiSession.last_seen_at || null;
  const lastOutput = tuiSession.last_output_at || tuiSession.updated_at || null;
  const sessionId = tuiSession.session_id || tuiSession.id;

  if (lastHeartbeat) {
    const minutesSinceHeartbeat = minutesAgo(lastHeartbeat, now);
    if (minutesSinceHeartbeat > maxHeartbeatAgeMinutes) {
      return {
        stalled: true,
        type: STALL_TYPE.DEAD_TUI,
        code: "tui_heartbeat_stale",
        message: `TUI session ${sessionId} heartbeat is ${minutesSinceHeartbeat.toFixed(0)} minutes old (threshold: ${maxHeartbeatAgeMinutes}m).`,
        detail: {
          session_id: sessionId,
          last_heartbeat_iso: lastHeartbeat,
          minutes_since_heartbeat: Math.round(minutesSinceHeartbeat * 10) / 10,
          max_heartbeat_threshold_minutes: maxHeartbeatAgeMinutes,
          status: tuiSession.status || "unknown",
        },
      };
    }
  }

  if (lastOutput) {
    const minutesSinceOutput = minutesAgo(lastOutput, now);
    if (minutesSinceOutput > maxOutputIdleMinutes) {
      return {
        stalled: true,
        type: STALL_TYPE.DEAD_TUI,
        code: "tui_output_stale",
        message: `TUI session ${sessionId} last output was ${minutesSinceOutput.toFixed(0)} minutes ago (threshold: ${maxOutputIdleMinutes}m).`,
        detail: {
          session_id: sessionId,
          last_output_iso: lastOutput,
          minutes_since_output: Math.round(minutesSinceOutput * 10) / 10,
          max_idle_threshold_minutes: maxOutputIdleMinutes,
          status: tuiSession.status || "unknown",
        },
      };
    }
  }

  // No heartbeat and no output tracked — treat as stall if session is supposed to be active
  if (!lastHeartbeat && !lastOutput && tuiSession.status === "active") {
    return {
      stalled: true,
      type: STALL_TYPE.DEAD_TUI,
      code: "tui_no_activity_tracking",
      message: `TUI session ${sessionId} is active but has no heartbeat or output tracking.`,
      detail: { session_id: sessionId, status: tuiSession.status },
    };
  }

  return { stalled: false, type: null, code: "tui_alive", message: null, detail: null };
}

/**
 * Check for stale worker — Codex worker assigned but not making progress.
 *
 * @param {object} options
 * @param {object} options.task - Task assigned to worker
 * @param {number} [options.maxWorkerIdleMinutes=15] - Max worker idle time
 * @returns {{ stalled: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectStaleWorkerStall({
  task = {},
  maxWorkerIdleMinutes = 15,
} = {}) {
  if (!task.id) {
    return { stalled: false, type: null, code: "no_task", message: "No task to check.", detail: null };
  }
  if (task.assignee !== "codex" && task.assignee !== "worker") {
    return { stalled: false, type: null, code: "not_worker_assigned", message: "Task is not assigned to a Codex worker.", detail: null };
  }

  const activeStatuses = new Set(["assigned", "queued", "running", "waiting_for_lock", "waiting_for_repair", "waiting_for_integration"]);
  if (!activeStatuses.has(task.status)) {
    return { stalled: false, type: null, code: "task_not_active", message: `Task status "${task.status}" is not an active execution status.`, detail: null };
  }

  const now = Date.now();
  const lastUpdate = task.updated_at || task.created_at || null;
  if (!lastUpdate) {
    return { stalled: false, type: null, code: "no_timestamps", message: "Task has no timestamps to evaluate worker stall.", detail: null };
  }

  const minutesSinceUpdate = minutesAgo(lastUpdate, now);
  if (minutesSinceUpdate > maxWorkerIdleMinutes) {
    return {
      stalled: true,
      type: STALL_TYPE.STALE_WORKER,
      code: "worker_idle",
      message: `Worker assigned to task "${task.id}" has been idle for ${minutesSinceUpdate.toFixed(0)} minutes (threshold: ${maxWorkerIdleMinutes}m).`,
      detail: {
        task_id: task.id,
        task_status: task.status,
        assignee: task.assignee,
        last_update_iso: lastUpdate,
        minutes_since_update: Math.round(minutesSinceUpdate * 10) / 10,
        max_idle_threshold_minutes: maxWorkerIdleMinutes,
      },
    };
  }

  return { stalled: false, type: null, code: "worker_active", message: null, detail: null };
}

/**
 * Check for stale lock — a repo or workstream lock held for too long.
 *
 * @param {object} options
 * @param {object} [options.lock={}] - Lock object with acquired_at
 * @param {number} [options.maxLockAgeMinutes=60] - Max lock age before stale
 * @returns {{ stalled: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectStaleLockStall({
  lock = {},
  maxLockAgeMinutes = 60,
} = {}) {
  if (!lock.lock_id && !lock.id) {
    return { stalled: false, type: null, code: "no_lock", message: "No lock exists.", detail: null };
  }

  const lockId = lock.lock_id || lock.id;
  const now = Date.now();
  const acquiredAt = lock.acquired_at || lock.created_at || null;

  if (!acquiredAt) {
    return { stalled: false, type: null, code: "lock_no_timestamp", message: "Lock has no acquisition timestamp.", detail: null };
  }

  const minutesSinceAcquired = minutesAgo(acquiredAt, now);
  if (minutesSinceAcquired > maxLockAgeMinutes) {
    return {
      stalled: true,
      type: STALL_TYPE.STALE_LOCK,
      code: "lock_stale",
      message: `Lock "${lockId}" acquired ${minutesSinceAcquired.toFixed(0)} minutes ago (threshold: ${maxLockAgeMinutes}m).`,
      detail: {
        lock_id: lockId,
        acquired_at_iso: acquiredAt,
        minutes_since_acquired: Math.round(minutesSinceAcquired * 10) / 10,
        max_age_threshold_minutes: maxLockAgeMinutes,
        holder: lock.holder || lock.held_by || null,
        lock_path: lock.path || lock.lock_path || null,
      },
    };
  }

  return { stalled: false, type: null, code: "lock_fresh", message: null, detail: null };
}

/**
 * Check for terminal mismatch — terminal tasks exist but neither the
 * parent task nor the queue has been reconciled.
 *
 * @param {object} options
 * @param {object[]} options.tasks - List of tasks to check
 * @param {object} options.parentTask - Parent task or workstream goal
 * @returns {{ stalled: boolean, type: string, code: string, message: string, detail: object|null }}
 */
export function detectTerminalMismatchStall({ tasks = [], parentTask = {} } = {}) {
  const terminalStatuses = new Set(["completed", "failed", "timed_out", "cancelled"]);
  const checkTasks = asArray(tasks).filter((t) => t.id && t.id !== parentTask?.id);

  const terminalTasks = checkTasks.filter((t) => terminalStatuses.has(t.status));
  if (terminalTasks.length === 0) {
    return { stalled: false, type: null, code: "no_terminal_tasks", message: "No terminal tasks found.", detail: null };
  }

  // Check if parent is also terminal or if there are pending non-terminal siblings
  const isParentTerminal = terminalStatuses.has(parentTask?.status) || parentTask?.status === "closed";
  const nonTerminalSiblings = checkTasks.filter((t) => !terminalStatuses.has(t.status) && t.id !== parentTask?.id);

  if (!isParentTerminal && nonTerminalSiblings.length > 0) {
    return {
      stalled: true,
      type: STALL_TYPE.TERMINAL_MISMATCH,
      code: "terminal_tasks_with_pending_siblings",
      message: `${terminalTasks.length} task(s) terminal but ${nonTerminalSiblings.length} sibling(s) still pending. Parent not terminal.`,
      detail: {
        terminal_task_count: terminalTasks.length,
        terminal_task_ids: terminalTasks.map((t) => t.id),
        pending_sibling_count: nonTerminalSiblings.length,
        pending_sibling_ids: nonTerminalSiblings.map((t) => t.id),
        parent_status: parentTask?.status || null,
      },
    };
  }

  return { stalled: false, type: null, code: "queue_consistent", message: null, detail: null };
}

// ---------------------------------------------------------------------------
// Composite stall check
// ---------------------------------------------------------------------------

/**
 * Run all stall checks and return composite result.
 *
 * @param {object} options
 * @param {object} [options.task={}]
 * @param {object} [options.tuiSession={}]
 * @param {object} [options.lock={}]
 * @param {object} [options.parentTask={}]
 * @param {object[]} [options.siblingTasks=[]]
 * @param {number} [options.maxHeartbeatAgeMinutes=10]
 * @param {number} [options.maxOutputIdleMinutes=30]
 * @param {number} [options.maxWorkerIdleMinutes=15]
 * @param {number} [options.maxLockAgeMinutes=60]
 * @returns {{
 *   stalled: boolean,
 *   findings: object[],
 *   stall_count: number,
 *   idempotency_key: string,
 *   summary: string
 * }}
 */
export function detectStall({
  task = {},
  tuiSession = {},
  lock = {},
  parentTask = {},
  siblingTasks = [],
  maxHeartbeatAgeMinutes = 10,
  maxOutputIdleMinutes = 30,
  maxWorkerIdleMinutes = 15,
  maxLockAgeMinutes = 60,
} = {}) {
  const findings = [];

  const tuiCheck = detectDeadTuiStall({ tuiSession, maxHeartbeatAgeMinutes, maxOutputIdleMinutes });
  if (tuiCheck.stalled) findings.push({ ...tuiCheck, detail: tuiCheck.detail });

  const workerCheck = detectStaleWorkerStall({ task, maxWorkerIdleMinutes });
  if (workerCheck.stalled) findings.push({ ...workerCheck, detail: workerCheck.detail });

  const lockCheck = detectStaleLockStall({ lock, maxLockAgeMinutes });
  if (lockCheck.stalled) findings.push({ ...lockCheck, detail: lockCheck.detail });

  const mismatchCheck = detectTerminalMismatchStall({ tasks: siblingTasks, parentTask });
  if (mismatchCheck.stalled) findings.push({ ...mismatchCheck, detail: mismatchCheck.detail });

  const codeParts = findings.map((f) => f.code).sort().join("|");
  const idempotencyKey = findings.length > 0 ? `stall:${codeParts}` : "stall:none";

  return {
    stalled: findings.length > 0,
    findings,
    stall_count: findings.length,
    idempotency_key: idempotencyKey,
    summary: findings.length > 0
      ? `${findings.length} stall condition(s) detected: ${findings.map((f) => f.code).join(", ")}.`
      : "No stall detected.",
  };
}

export default {
  detectStall,
  detectDeadTuiStall,
  detectStaleWorkerStall,
  detectStaleLockStall,
  detectTerminalMismatchStall,
  STALL_TYPE,
};
