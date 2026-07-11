// @ts-check
/**
 * execution-capacity.mjs — Capacity-aware execution limits for workstreams.
 *
 * Enforces limits at multiple levels:
 *   1. Global: Total parallel executions across all workstreams
 *   2. Per-repo: Maximum parallel tasks per repository
 *   3. Per-workstream: Maximum parallel tasks within one workstream
 *   4. Per-TUI: Maximum concurrent TUI sessions
 *
 * Limits are configurable at the workstream level (in execution_policy)
 * and are enforced by the queue auto-advance logic and capacity checks.
 */

// ---------------------------------------------------------------------------
// Default Limits
// ---------------------------------------------------------------------------

export const DEFAULT_CAPACITY_LIMITS = Object.freeze({
  /** Global maximum parallel task executions */
  global_max_parallel: 10,
  /** Maximum parallel tasks per repository */
  repo_max_parallel: 3,
  /** Maximum parallel tasks per workstream */
  workstream_max_parallel: 5,
  /** Maximum TUI sessions per workstream */
  workstream_max_tui: 3,
  /** Maximum TUI sessions globally */
  global_max_tui: 20,
});

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Read capacity state from store.
 */
function getCapacityState(state) {
  if (!state.execution_capacity) {
    state.execution_capacity = {
      active_executions: {},
      active_per_workstream: {},
      active_per_repo: {},
      active_tui_sessions: {},
      tui_per_workstream: {},
    };
  }
  return state.execution_capacity;
}

// ---------------------------------------------------------------------------
// Capacity counting
// ---------------------------------------------------------------------------

/**
 * Count active running tasks across the entire system.
 *
 * @param {object} state - Full state object
 * @returns {number}
 */
export function countActiveExecutions(state) {
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  return queue.filter((item) => item.status === "running").length;
}

/**
 * Count active running tasks for a specific repo.
 *
 * @param {object} state
 * @param {string} repoId
 * @returns {number}
 */
export function countActiveRepoExecutions(state, repoId) {
  if (!repoId) return 0;
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  return queue.filter(
    (item) => item.status === "running" && item.repo_id === repoId
  ).length;
}

/**
 * Count active running tasks for a specific workstream.
 *
 * @param {object} state
 * @param {string} workstreamId
 * @returns {number}
 */
export function countActiveWorkstreamExecutions(state, workstreamId) {
  if (!workstreamId) return 0;
  // Count queue items linked to workstream DAG nodes
  const dag = state.workstream_dag;
  if (!dag || !dag.nodes) return 0;
  const workstreamNodeIds = new Set(
    Object.values(dag.nodes)
      .filter((n) => n.workstream_id === workstreamId && n.status === "running")
      .map((n) => n.id)
  );
  // Also check in queue items
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const queueRunning = queue.filter(
    (item) => item.status === "running" && item.workstream_id === workstreamId
  ).length;

  return workstreamNodeIds.size + queueRunning;
}

/**
 * Count active TUI sessions (global or per-workstream).
 *
 * @param {object} state
 * @param {string} [workstreamId] - Optional workstream filter
 * @returns {number}
 */
export function countActiveTuiSessions(state, workstreamId) {
  const tuiSessions = Array.isArray(state.tui_sessions) ? state.tui_sessions : [];
  const active = tuiSessions.filter((s) => s.status === "running" || s.status === "active");
  if (workstreamId) {
    return active.filter((s) => s.workstream_id === workstreamId).length;
  }
  return active.length;
}

// ---------------------------------------------------------------------------
// Capacity checks
// ---------------------------------------------------------------------------

/**
 * Check whether a new execution can be started given current capacity.
 *
 * @param {object} state - Full state
 * @param {object} options
 * @param {string} [options.repo_id] - Repository ID
 * @param {string} [options.workstream_id] - Workstream ID
 * @param {object} [options.limits] - Custom limits (overrides defaults)
 * @returns {{ allowed: boolean, reason: string, counts: object }}
 */
export function checkExecutionCapacity(state, options = {}) {
  const limits = { ...DEFAULT_CAPACITY_LIMITS, ...(options.limits || {}) };

  const globalActive = countActiveExecutions(state);
  const repoActive = options.repo_id ? countActiveRepoExecutions(state, options.repo_id) : 0;
  const wsActive = options.workstream_id
    ? countActiveWorkstreamExecutions(state, options.workstream_id)
    : 0;

  const counts = {
    global_active: globalActive,
    global_max: limits.global_max_parallel,
    repo_active: repoActive,
    repo_max: limits.repo_max_parallel,
    workstream_active: wsActive,
    workstream_max: limits.workstream_max_parallel,
  };

  if (globalActive >= limits.global_max_parallel) {
    return {
      allowed: false,
      reason: `Global execution capacity reached: ${globalActive}/${limits.global_max_parallel}`,
      counts,
    };
  }

  if (options.repo_id && repoActive >= limits.repo_max_parallel) {
    return {
      allowed: false,
      reason: `Repo execution capacity reached for ${options.repo_id}: ${repoActive}/${limits.repo_max_parallel}`,
      counts,
    };
  }

  if (options.workstream_id && wsActive >= limits.workstream_max_parallel) {
    return {
      allowed: false,
      reason: `Workstream execution capacity reached for ${options.workstream_id}: ${wsActive}/${limits.workstream_max_parallel}`,
      counts,
    };
  }

  return { allowed: true, reason: "Capacity available", counts };
}

/**
 * Check TUI session capacity.
 *
 * @param {object} state
 * @param {object} options
 * @param {string} [options.workstream_id] - Workstream ID
 * @param {object} [options.limits] - Custom limits
 * @returns {{ allowed: boolean, reason: string, counts: object }}
 */
export function checkTuiCapacity(state, options = {}) {
  const limits = { ...DEFAULT_CAPACITY_LIMITS, ...(options.limits || {}) };

  const globalActive = countActiveTuiSessions(state);
  const wsActive = options.workstream_id
    ? countActiveTuiSessions(state, options.workstream_id)
    : 0;

  const counts = {
    global_tui_active: globalActive,
    global_tui_max: limits.global_max_tui,
    workstream_tui_active: wsActive,
    workstream_tui_max: limits.workstream_max_tui,
  };

  if (globalActive >= limits.global_max_tui) {
    return {
      allowed: false,
      reason: `Global TUI capacity reached: ${globalActive}/${limits.global_max_tui}`,
      counts,
    };
  }

  if (options.workstream_id && wsActive >= limits.workstream_max_tui) {
    return {
      allowed: false,
      reason: `Workstream TUI capacity reached for ${options.workstream_id}: ${wsActive}/${limits.workstream_max_tui}`,
      counts,
    };
  }

  return { allowed: true, reason: "TUI capacity available", counts };
}

/**
 * Get combined capacity status for all levels.
 *
 * @param {object} state
 * @param {object} [options]
 * @returns {object}
 */
export function getCapacityStatus(state, options = {}) {
  const limits = { ...DEFAULT_CAPACITY_LIMITS, ...(options.limits || {}) };

  const globalActive = countActiveExecutions(state);
  const globalTuiActive = countActiveTuiSessions(state);

  // Collect per-repo and per-workstream stats
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const runningItems = queue.filter((item) => item.status === "running");

  const perRepo = {};
  const perWorkstream = {};
  for (const item of runningItems) {
    if (item.repo_id) {
      perRepo[item.repo_id] = (perRepo[item.repo_id] || 0) + 1;
    }
    if (item.workstream_id) {
      perWorkstream[item.workstream_id] = (perWorkstream[item.workstream_id] || 0) + 1;
    }
  }

  // Workstream DAG running nodes
  const dag = state.workstream_dag;
  if (dag && dag.nodes) {
    for (const node of Object.values(dag.nodes)) {
      if (node.status === "running" && node.workstream_id) {
        perWorkstream[node.workstream_id] = (perWorkstream[node.workstream_id] || 0) + 1;
      }
    }
  }

  return {
    global: {
      active: globalActive,
      max: limits.global_max_parallel,
      available: Math.max(0, limits.global_max_parallel - globalActive),
    },
    tui: {
      active: globalTuiActive,
      max: limits.global_max_tui,
      available: Math.max(0, limits.global_max_tui - globalTuiActive),
    },
    per_repo: Object.fromEntries(
      Object.entries(perRepo).map(([repo, count]) => [
        repo,
        { active: count, max: limits.repo_max_parallel },
      ])
    ),
    per_workstream: Object.fromEntries(
      Object.entries(perWorkstream).map(([ws, count]) => [
        ws,
        { active: count, max: limits.workstream_max_parallel },
      ])
    ),
  };
}
