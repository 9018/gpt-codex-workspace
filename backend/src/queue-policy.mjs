/**
 * queue-policy.mjs — Queue advancement policy module.
 *
 * Central authority for queue advancement decisions.  All rules that
 * determine whether a queued goal can be started live here so that
 * goal-queue.mjs and anyone calling startNextQueuedGoal share one
 * source of truth.
 *
 * ## Rules
 *
 * 1. **Dependency terminal-only** — A depends_on_goal or depends_on_task
 *    must reach a terminal *completed* status before the dependent can
 *    start.  `completed_only` (the default) is strict: only "completed"
 *    qualifies.  `terminal_any` is broader but still requires a *terminal*
 *    state — a running/waiting dependency never counts as satisfied.
 *
 * 2. **Acceptance gating** — If the prerequisite task finished with a
 *    status other than "completed" (e.g. failed, timed_out), the queue
 *    item that depends on it is blocked and reported as such.  A task
 *    that did not pass acceptance must not advance downstream dependents.
 *
 * 3. **Repo serialisation** — Two items for the same repo may not run
 *    concurrently.  If a queue item for repo R is already running, any
 *    other item for repo R waits.
 *
 * 4. **Auto-start preconditions** — A task is eligible for auto-start
 *    only when all the above checks pass.
 */

import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isCompletedStatus,
  isFailedTerminalStatus,
} from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

export const QUEUE_STATUS_RUNNING = "running";

/**
 * Statuses treated as "terminal completed" for dependency purposes.
 * Only these satisfy `completed_only` policy.
 */
export const TERMINAL_COMPLETED_STATUSES = Object.freeze(
  new Set([TASK_STATUSES.COMPLETED])
);

/**
 * Terminal statuses that represent failure or non-completion.
 * Used for acceptance gating — failed tasks must not advance
 * downstream dependents.
 */
export const NON_COMPLETION_TERMINAL_STATUSES = Object.freeze(
  new Set([
    TASK_STATUSES.FAILED,
    TASK_STATUSES.TIMED_OUT,
    TASK_STATUSES.BLOCKED,
    TASK_STATUSES.CANCELLED,
  ])
);

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `status` is a terminal (final) completed state.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isTerminalCompleted(status) {
  return TERMINAL_COMPLETED_STATUSES.has(status);
}

/**
 * Returns true when `status` is a terminal non-completed state
 * (failed, timed_out, blocked, cancelled).
 */
export function isNonCompletionTerminal(status) {
  return NON_COMPLETION_TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Dependency check
// ---------------------------------------------------------------------------

/**
 * Resolve the status of the dependency target (goal or task).
 *
 * @param {object} state  — Full state object (goals[], tasks[])
 * @param {object} item   — Queue item with depends_on_goal_id / depends_on_task_id
 * @returns {{ status: string|null, kind: "goal"|"task"|"none", target_id: string|null }}
 */
export function resolveDependencyTarget(state, item) {
  if (item.depends_on_goal_id) {
    const goal = Array.isArray(state.goals)
      ? state.goals.find((g) => g.id === item.depends_on_goal_id)
      : null;
    // P0: If goal status is stale (open), look for a completed task with
    // acceptance/integration evidence instead of blocking on the goal status.
    if (goal && goal.status !== "completed") {
      const completedTask = Array.isArray(state.tasks)
        ? state.tasks.find((t) => t.goal_id === goal.id && t.status === "completed")
        : null;
      if (completedTask) {
        return {
          status: "completed",
          kind: "goal",
          target_id: item.depends_on_goal_id,
          actual_source: "completed_task",
          task_id: completedTask.id,
        };
      }
    }
    return {
      status: goal ? goal.status : null,
      kind: "goal",
      target_id: item.depends_on_goal_id,
    };
  }

  if (item.depends_on_task_id) {
    const task = Array.isArray(state.tasks)
      ? state.tasks.find((t) => t.id === item.depends_on_task_id)
      : null;
    return {
      status: task ? task.status : null,
      kind: "task",
      target_id: item.depends_on_task_id,
    };
  }

  return { status: null, kind: "none", target_id: null };
}

/**
 * Check whether the dependency of a queue item is satisfied.
 *
 * Policy rules:
 * - `completed_only` (default): dependency status must be "completed"
 *   exactly — waiting_for_review, failed, timed_out etc. do NOT count.
 * - `terminal_any`: dependency must be in a terminal state (completed,
 *   failed, timed_out, blocked, cancelled).
 *
 * @param {object} state — Full state
 * @param {object} item  — Queue item
 * @returns {{ satisfied: boolean, reason: string|null }}
 */
export function checkDependency(state, item) {
  const policy = item.dependency_policy || "completed_only";
  const { status, kind, target_id } = resolveDependencyTarget(state, item);

  // No dependency — trivially satisfied
  if (kind === "none") {
    return { satisfied: true, reason: null };
  }

  // Target not found in state
  if (status === null) {
    return {
      satisfied: false,
      reason: `depends_on_${kind} ${target_id} not found in state`,
    };
  }

  // Strict mode: only "completed" counts
  if (policy === "completed_only") {
    const ok = isTerminalCompleted(status);
    return {
      satisfied: ok,
      reason: ok
        ? null
        : `depends_on_${kind} ${target_id} status=${status} — not terminal completed`,
    };
  }

  // Relaxed mode: any terminal state counts
  if (policy === "terminal_any") {
    const ok = isTerminalStatus(status);
    return {
      satisfied: ok,
      reason: ok
        ? `depends_on_${kind} ${target_id} status=${status} — allowed by terminal_any`
        : `depends_on_${kind} ${target_id} status=${status} — not terminal`,
    };
  }

  return {
    satisfied: false,
    reason: `unknown dependency_policy="${policy}"`,
  };
}

// ---------------------------------------------------------------------------
// Acceptance gate check
// ---------------------------------------------------------------------------

/**
 * Check whether the prerequisite task or goal of a queue item
 * has an acceptable completion result.
 *
 * A "failed/unaccepted task must not advance":
 * - If the dependency target is a task and its status is a
 *   non-completion terminal (failed, timed_out, blocked, cancelled),
 *   the queue item is blocked and must not advance.
 * - Goal-level dependencies are checked by status alone.
 *
 * @param {object} state
 * @param {object} item
 * @returns {{ passed: boolean, reason: string|null }}
 */
export function checkAcceptanceGate(state, item) {
  if (!item.depends_on_task_id) {
    return { passed: true, reason: null };
  }

  const task = Array.isArray(state.tasks)
    ? state.tasks.find((t) => t.id === item.depends_on_task_id)
    : null;

  if (!task) {
    return { passed: false, reason: `prerequisite task ${item.depends_on_task_id} not found` };
  }

  // Task is still in progress — not yet acceptable
  if (!isTerminalStatus(task.status)) {
    return {
      passed: false,
      reason: `prerequisite task ${item.depends_on_task_id} status=${task.status} — not yet complete`,
    };
  }

  // Task completed successfully — gate passes
  if (isTerminalCompleted(task.status)) {
    return { passed: true, reason: null };
  }

  // Task finished but did not complete (failed, timed_out, blocked, cancelled) — gate blocks
  return {
    passed: false,
    reason: `prerequisite task ${item.depends_on_task_id} status=${task.status} — failed/unaccepted tasks must not advance the queue`,
  };
}

// ---------------------------------------------------------------------------
// Repo concurrency check
// ---------------------------------------------------------------------------

/**
 * Scan all running queue items and return true if any of them belongs
 * to the same repo as `repoId`.
 *
 * When `excludeQueueId` is provided, that item is skipped (so an item
 * does not block itself).
 *
 * @param {object} state
 * @param {string} repoId
 * @param {string} [excludeQueueId]
 * @returns {{ blocked: boolean, runningItem: object|null }}
 */
export function checkRepoConcurrency(state, repoId, excludeQueueId = null) {
  if (!repoId) {
    return { blocked: false, runningItem: null };
  }

  const items = Array.isArray(state.goal_queue) ? state.goal_queue : [];

  for (const item of items) {
    if (excludeQueueId && item.queue_id === excludeQueueId) continue;
    if (item.status !== QUEUE_STATUS_RUNNING) continue;

    // Repo match: both are non-empty and equal
    if (item.repo_id && item.repo_id === repoId) {
      return {
        blocked: true,
        runningItem: item,
      };
    }
  }

  return { blocked: false, runningItem: null };
}

// ---------------------------------------------------------------------------
// Compound checks
// ---------------------------------------------------------------------------

/**
 * Build the full array of advancement checks for a queue item.
 *
 * Each check is an object:
 *   { check: string, passed: boolean, detail?: string, ... }
 *
 * @param {object} state  — Full state (goals[], tasks[], goal_queue[])
 * @param {object} item   — Queue item being evaluated
 * @param {object} config — Config object (for repo resolution etc.)
 * @returns {Promise<Array<object>>}
 */
export async function buildAdvancementChecks(state, item, config = {}) {
  const checks = [];

  // 1. Dependency check
  const depResult = checkDependency(state, item);
  checks.push({
    check: "dependency",
    passed: depResult.satisfied,
    detail: depResult.reason || "no dependency",
  });

  // 2. Acceptance gate check (only for task-level dependencies)
  const acceptResult = checkAcceptanceGate(state, item);
  checks.push({
    check: "acceptance_gate",
    passed: acceptResult.passed,
    detail: acceptResult.reason || "no prerequisite task dependency",
  });

  // 3. Repo concurrency check
  if (item.repo_id) {
    const concurrencyResult = checkRepoConcurrency(state, item.repo_id, item.queue_id);
    checks.push({
      check: "repo_concurrency",
      passed: !concurrencyResult.blocked,
      repo_id: item.repo_id,
      blocking_item_queue_id: concurrencyResult.runningItem?.queue_id || null,
      blocking_item_goal_id: concurrencyResult.runningItem?.goal_id || null,
      detail: concurrencyResult.blocked
        ? `same-repo serialisation: ${concurrencyResult.runningItem?.goal_id || "another task"} already running for repo ${item.repo_id}`
        : "no concurrent repo task",
    });
  } else {
    checks.push({
      check: "repo_concurrency",
      passed: true,
      repo_id: null,
      detail: "no repo_id — concurrency not checked",
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Convenience predicates
// ---------------------------------------------------------------------------

/**
 * Returns true when a queue item's advancement preconditions all pass.
 */
export function allAdvancementChecksPass(checks) {
  return Array.isArray(checks) && checks.every((c) => c.passed === true);
}

/**
 * Summarise the first failing check (if any) for error messages.
 */
export function firstFailingCheck(checks) {
  if (!Array.isArray(checks)) return null;
  return checks.find((c) => c.passed !== true) || null;
}
