/**
 * goal-queue.mjs — Goal/task execution queue with dependency management,
 * repo concurrency guards, and autostart hooks.
 *
 * Queue items are stored in state.json under the "goal_queue" key as an array.
 *
 * State transitions:
 *   waiting → ready → running → completed|failed
 *   waiting → blocked (when dependency not met or repo locked)
 *   blocked → ready (when dependency resolves)
 *   running → completed|failed
 *
 * Only items with status "waiting" or "ready" are eligible for start-next.
 * Items marked auto_start=true are automatically picked up by
 * autoStartNextOnTaskCompleted when the previous task completes.
 */

import { randomUUID } from "node:crypto";
import { resolveTaskRepositoryPlan } from "./task-repo-resolution.mjs";

// ---------------------------------------------------------------------------
// Queue item status constants
// ---------------------------------------------------------------------------

export const QUEUE_STATUS_WAITING = "waiting";
export const QUEUE_STATUS_READY = "ready";
export const QUEUE_STATUS_RUNNING = "running";
export const QUEUE_STATUS_BLOCKED = "blocked";
export const QUEUE_STATUS_COMPLETED = "completed";
export const QUEUE_STATUS_FAILED = "failed";
export const QUEUE_STATUS_CANCELLED = "cancelled";

/** Ordered set of statuses that are eligible for start-next. */
const ELIGIBLE_STATUSES = new Set([QUEUE_STATUS_WAITING, QUEUE_STATUS_READY]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function randomId() {
  return "queue_" + randomUUID().slice(0, 12).replace(/-/g, "");
}

function ensureQueueArray(state) {
  if (!Array.isArray(state.goal_queue)) {
    state.goal_queue = [];
  }
  return state.goal_queue;
}

/** Calculate the next position number for the queue. */
function nextPosition(state) {
  const items = ensureQueueArray(state);
  if (items.length === 0) return 1;
  const maxPos = items.reduce((max, item) => Math.max(max, item.position || 0), 0);
  return maxPos + 1;
}

function findItem(state, queueId) {
  const items = ensureQueueArray(state);
  return items.find((item) => item.queue_id === queueId) || null;
}

function findDependentItems(state, completedGoalId, completedTaskId) {
  const items = ensureQueueArray(state);
  return items.filter((item) => {
    const dep = item.depends_on_goal_id || item.depends_on_task_id;
    if (!dep) return false;
    return dep === completedGoalId || dep === completedTaskId;
  });
}

// ---------------------------------------------------------------------------
// Repo lock / worktree checks
// ---------------------------------------------------------------------------

// NOTE: Repo lock and worktree dirty checks have been moved to
// processGeneralTask (during execution phase). The queue only
// performs dependency and capacity checks; all git mutation and
// lock acquisition happens during execution on per-task worktree paths.

// ---------------------------------------------------------------------------
// Goal status check helpers
// ---------------------------------------------------------------------------

function getGoalStatus(state, goalId) {
  const goal = Array.isArray(state.goals)
    ? state.goals.find((g) => g.id === goalId)
    : null;
  return goal ? goal.status : null;
}

function getTaskStatus(state, taskId) {
  const task = Array.isArray(state.tasks)
    ? state.tasks.find((t) => t.id === taskId)
    : null;
  return task ? task.status : null;
}

function isDependencySatisfied(state, item) {
  const policy = item.dependency_policy || "completed_only";
  if (item.depends_on_goal_id) {
    const status = getGoalStatus(state, item.depends_on_goal_id);
    if (status === "completed") return { satisfied: true };
    if (policy === "terminal_any" && (status === "failed" || status === "timed_out")) {
      return { satisfied: true, reason: `policy=${policy} allows ${item.depends_on_goal_id} status=${status}` };
    }
    return { satisfied: false, reason: `depends_on_goal ${item.depends_on_goal_id} status=${status || "not found"}` };
  }
  if (item.depends_on_task_id) {
    const status = getTaskStatus(state, item.depends_on_task_id);
    if (status === "completed") return { satisfied: true };
    if (policy === "terminal_any" && (status === "failed" || status === "timed_out")) {
      return { satisfied: true, reason: `policy=${policy} allows ${item.depends_on_task_id} status=${status}` };
    }
    return { satisfied: false, reason: `depends_on_task ${item.depends_on_task_id} status=${status || "not found"}` };
  }
  return { satisfied: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a goal to the execution queue.
 */
export async function enqueueGoal(store, goalId, opts = {}) {
  const state = await store.load();
  ensureQueueArray(state);

  // Validate goal exists
  const goal = Array.isArray(state.goals)
    ? state.goals.find((g) => g.id === goalId)
    : null;
  if (!goal) {
    return { ok: false, item: null, warnings: [`Goal not found: ${goalId}`] };
  }

  // Check if already queued
  const already = ensureQueueArray(state).find(
    (item) => item.goal_id === goalId && item.status !== QUEUE_STATUS_CANCELLED
  );
  if (already) {
    return { ok: false, item: already, warnings: [`Goal ${goalId} is already queued (id=${already.queue_id}, status=${already.status})`] };
  }

  const timestamp = now();
  const position = nextPosition(state);

  const item = {
    queue_id: randomId(),
    goal_id: goalId,
    task_id: null,
    workspace_id: opts.workspace_id || goal.workspace_id || "hosted-default",
    repo_id: opts.repo_id || "",
    position,
    status: QUEUE_STATUS_WAITING,
    depends_on_goal_id: opts.depends_on_goal_id || null,
    depends_on_task_id: opts.depends_on_task_id || null,
    dependency_policy: opts.dependency_policy || "completed_only",
    blocked_reason: null,
    auto_start: opts.auto_start !== false,
    created_at: timestamp,
    updated_at: timestamp,
  };

  ensureQueueArray(state).push(item);
  await store.save();

  return { ok: true, item, warnings: [] };
}

/**
 * List queue items with optional filtering and sorting.
 */
export async function listGoalQueue(store, opts = {}) {
  const state = await store.load();
  let items = [...(ensureQueueArray(state) || [])];

  if (opts.status) {
    items = items.filter((item) => item.status === opts.status);
  }
  if (opts.workspace_id) {
    items = items.filter((item) => item.workspace_id === opts.workspace_id);
  }
  if (opts.repo_id) {
    items = items.filter((item) => item.repo_id === opts.repo_id);
  }

  // Sort by position ascending
  items.sort((a, b) => (a.position || 0) - (b.position || 0));

  const total = items.length;
  if (opts.limit && opts.limit > 0) {
    items = items.slice(0, opts.limit);
  }

  // Attach goal title for convenience
  for (const item of items) {
    const goal = Array.isArray(state.goals)
      ? state.goals.find((g) => g.id === item.goal_id)
      : null;
    item.goal_title = goal ? goal.title || goal.description?.slice(0, 80) || "" : "";
  }

  return { items, total };
}

/**
 * Get a single queue item by queue_id.
 */
export async function getGoalQueueItem(store, queueId) {
  const state = await store.load();
  const item = findItem(state, queueId);
  if (!item) return null;

  // Attach goal title
  const goal = Array.isArray(state.goals)
    ? state.goals.find((g) => g.id === item.goal_id)
    : null;
  if (goal) {
    item.goal_title = goal.title || goal.description?.slice(0, 80) || "";
  }

  return item;
}

/**
 * Start the next eligible queued goal.
 *
 * Scans queue items by position for the first item in "waiting" or "ready"
 * status whose dependency is satisfied, repo is not locked for a different
 * task, and worktree is clean.
 */
export 
/**
 * Re-check transiently blocked items (repo lock, dirty worktree) and
 * move them back to waiting if conditions have resolved.
 * Items blocked by dependency unmet are NOT auto-recovered.
 */
async function resolveQueueItemRepository(item, config) {
  if (typeof config.repoResolver === "function") {
    const resolved = await config.repoResolver({
      id: item.task_id || item.goal_id,
      task_id: item.task_id,
      goal_id: item.goal_id,
      repo_id: item.repo_id || "",
    });
    return {
      repo_id: resolved.repo_id || item.repo_id || "default",
      canonical_repo_path: resolved.canonical_repo_path || resolved.lock_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot,
      lock_repo_path: resolved.lock_repo_path || resolved.canonical_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot,
      task_worktree_path: resolved.task_worktree_path || null,
      uses_default_fallback: resolved.uses_default_fallback === true,
      worktree_lifecycle: resolved.worktree_lifecycle || null,
    };
  }
  return resolveTaskRepositoryPlan({
    task: { id: item.task_id || item.goal_id, repo_id: item.repo_id || "" },
    goal: { id: item.goal_id, repo_id: item.repo_id || "" },
    config,
    registry: config.registry || null,
  });
}

async function recheckTransientBlockedItems(state, config, workspaceRoot) {
  const items = ensureQueueArray(state);
  const TRANSIENT_PATTERNS = ["repo lock", "repo locked", "worktree dirty", "dirty worktree", "worktree status unknown", "git status failed"];
  let changed = 0;

  for (const item of items) {
    if (item.status !== QUEUE_STATUS_BLOCKED) continue;
    if (!item.blocked_reason) continue;

    const isTransient = TRANSIENT_PATTERNS.some(
      (p) => item.blocked_reason.toLowerCase().includes(p)
    );
    if (!isTransient) continue;

    // Re-check dependency (should still be satisfied)
    const depResult = isDependencySatisfied(state, item);
    if (!depResult.satisfied) continue;

    // Transient conditions (repo lock, worktree dirty) are now handled during
    // execution — the queue only performs dependency and capacity checks.
    // Move back to waiting so startNextQueuedGoal can re-evaluate eligibility.
    item.status = QUEUE_STATUS_WAITING;
    item.blocked_reason = null;
    item.updated_at = now();
    changed++;
  }

  return changed;
}


export async function startNextQueuedGoal(store, config, opts = {}) {
  const dryRun = opts.dry_run === true;
  const state = await store.load();
  const workspaceRoot = config.defaultWorkspaceRoot;
  // Re-check transiently blocked items before scanning eligible items
  await recheckTransientBlockedItems(state, config, workspaceRoot);
  const items = ensureQueueArray(state);

  // Sort by position
  const sorted = [...items]
    .filter((item) => ELIGIBLE_STATUSES.has(item.status))
    .sort((a, b) => (a.position || 0) - (b.position || 0));

 if (sorted.length === 0) {
   return { started: false, item: null, task: null, reason: "No eligible queue items (status=waiting|ready)", checks: [] };
 }

  /** Collect items blocked during scanning so startQueuedGoals can report them. */
  const blockedItems = [];

 for (const candidate of sorted) {
   const checks = [];

    // 1. Dependency check
    const depResult = isDependencySatisfied(state, candidate);
    checks.push({ check: "dependency", passed: depResult.satisfied, detail: depResult.reason || "no dependency" });
    if (!depResult.satisfied) {
      if (!dryRun) {
        candidate.status = QUEUE_STATUS_BLOCKED;
        candidate.blocked_reason = depResult.reason;
        candidate.updated_at = now();
        await store.save();
      }
      continue;
    }

    const resolvedRepo = await resolveQueueItemRepository(candidate, config);
    const repoPath = resolvedRepo.lock_repo_path || resolvedRepo.canonical_repo_path;
    checks.push({
      check: "repo_resolution",
      passed: Boolean(repoPath) && resolvedRepo.worktree_lifecycle?.ok !== false,
      repo_id: resolvedRepo.repo_id,
      repo_path: repoPath,
      worktree_path: resolvedRepo.task_worktree_path || null,
      worktree_lifecycle: resolvedRepo.worktree_lifecycle || null,
      detail: resolvedRepo.worktree_lifecycle?.ok === false
        ? `worktree error: ${resolvedRepo.worktree_lifecycle.error || "unknown"}`
        : resolvedRepo.uses_default_fallback ? "default repo fallback" : "resolved repo",
    });
   if (resolvedRepo.worktree_lifecycle?.ok === false) {
     candidate.blocked_reason = `Worktree status unknown: ${resolvedRepo.worktree_lifecycle.error || "worktree preparation failed"}`;
      checks[checks.length - 1].passed = false;
     candidate.status = QUEUE_STATUS_BLOCKED;
     candidate.updated_at = now();
      blockedItems.push({ queue_id: candidate.queue_id, goal_id: candidate.goal_id, reason: candidate.blocked_reason });
      if (!dryRun) await store.save();
      continue;
   }

        // 2. No repo lock or worktree dirty checks at queue time.
    //    Locks are acquired during execution on per-task worktree paths.
    //    The worktree does not exist yet, so dirty checks are irrelevant.
    checks.push({
      check: "execution_guards_deferred",
      passed: true,
      detail: "repo lock and worktree dirty checks deferred to processGeneralTask",
    });

// All checks passed — this item is eligible
    if (dryRun) {
      return {
        started: false,
        item: candidate,
        task: null,
        reason: `Dry run: would start goal ${candidate.goal_id}`,
        checks,
      };
    }

    // Create task for this goal
   try {
     const { createGoalTask } = await import("./goal-task-task-factory.mjs");

      // Preserve the goal's own mode; fallback to "builder" if missing
      const goalObj = Array.isArray(state.goals)
        ? state.goals.find((g) => g.id === candidate.goal_id)
        : null;
     const task = await createGoalTask(store, config, candidate.goal_id, {
       assignee: "codex",
       status: "assigned",
        mode: goalObj?.mode || "builder",
     });
      if (candidate.repo_id) {
        task.repo_id = candidate.repo_id;
        const goal = Array.isArray(state.goals) ? state.goals.find((item) => item.id === candidate.goal_id) : null;
        if (goal) goal.repo_id = candidate.repo_id;
      }

      // Update queue item
      candidate.status = QUEUE_STATUS_RUNNING;
      candidate.task_id = task.id;
      candidate.blocked_reason = null;
      candidate.updated_at = now();
      await store.save();

      return {
        started: true,
        item: candidate,
        task,
        reason: `Started task ${task.id} for goal ${candidate.goal_id}`,
        checks,
      };
    } catch (err) {
      return {
        started: false,
        item: candidate,
        task: null,
        reason: `Failed to create task: ${err.message}`,
        checks,
      };
    }
  }

 return {
   started: false,
   item: null,
   task: null,
    blocked_items: blockedItems,
    reason: blockedItems.length > 0
      ? `${blockedItems.length} item(s) blocked, no eligible candidates`
      : "No eligible queue items after checking all candidates",
   checks: [],
 };
}

export async function startQueuedGoals(store, config, opts = {}) {
  const maxStart = Math.max(1, Math.min(Number(opts.max_start || opts.maxStart || 1) || 1, 50));
  const dryRun = opts.dry_run === true;
  const results = [];
  const blocked = [];

  for (let i = 0; i < maxStart; i++) {
    const result = await startNextQueuedGoal(store, config, { ...opts, dry_run: dryRun });
    if (dryRun) {
      results.push(result);
      break;
    }
   if (result.started) {
     results.push(result);
     continue;
   }
    // Collect blocked items from the scan even when none started
    if (Array.isArray(result.blocked_items)) {
      for (const bi of result.blocked_items) {
        blocked.push(bi);
      }
    }
    // If no item was found, all candidates exhausted — stop
    if (!result.item) break;
    // A specific item was tried and failed (task creation error) — stop
    if (result.reason) {
      blocked.push({ queue_id: result.item.queue_id, reason: result.reason });
    }
    break;
  }

  const startedResults = results.filter((result) => result.started);
  return {
    started: startedResults.length,
    started_count: startedResults.length,
    any_started: startedResults.length > 0,
    results,
    blocked,
    reason: startedResults.length > 0
      ? `Started ${startedResults.length} queued goal(s)`
      : (results[0]?.reason || "No eligible queue items"),
  };
}

/**
 * Update a queue item by queue_id.
 */
export async function updateGoalQueueItem(store, queueId, updater = {}) {
  const state = await store.load();
  const item = findItem(state, queueId);
  if (!item) return { ok: false, item: null };

  const allowedKeys = new Set([
    "status", "blocked_reason", "auto_start", "position",
    "depends_on_goal_id", "depends_on_task_id", "dependency_policy", "repo_id",
  ]);

  for (const [key, value] of Object.entries(updater)) {
    if (allowedKeys.has(key)) {
      item[key] = value;
    }
  }

  item.updated_at = now();
  await store.save();

  return { ok: true, item };
}

/**
 * Cancel a queue item.
 */
export async function cancelGoalQueueItem(store, queueId) {
  const state = await store.load();
  const item = findItem(state, queueId);
  if (!item) return { ok: false, item: null, warnings: [`Queue item not found: ${queueId}`] };

  if (item.status === QUEUE_STATUS_RUNNING) {
    return {
      ok: false,
      item,
      warnings: [`Queue item ${queueId} is ${item.status}. Cancel the task first, or use force.`],
    };
  }

  item.status = QUEUE_STATUS_CANCELLED;
  item.updated_at = now();
  await store.save();

  return { ok: true, item, warnings: [] };
}

/**
 * Called when a task completes. Checks for dependent queue items
 * and tries to auto-start the next eligible one.
 */
export async function autoStartNextOnTaskCompleted(store, config, completedTask) {
  const state = await store.load();
  const details = [];

  // Find queue items that depend on this task or its goal
  const taskId = completedTask.id;
  const goalId = completedTask.goal_id || "";

  const dependents = [];
  const allItems = ensureQueueArray(state);
  for (const item of allItems) {
    if (item.depends_on_task_id === taskId || item.depends_on_goal_id === goalId) {
      if (ELIGIBLE_STATUSES.has(item.status) && item.auto_start) {
        dependents.push(item);
      }
    }
  }

  // If no direct dependents, try start_next anyway (next in line)
  if (dependents.length === 0) {
    const result = await startNextQueuedGoal(store, config);
    details.push({
      type: "auto_start_next",
      started: result.started,
      reason: result.reason,
      queue_id: result.item?.queue_id || null,
    });
    return { auto_started: result.started, details };
  }

  // Try to start each dependent
  for (const dep of dependents) {
    dep.status = QUEUE_STATUS_READY;
    await store.save();

    const result = await startNextQueuedGoal(store, config);
    details.push({
      type: "dependent_auto_start",
      queue_id: dep.queue_id,
      goal_id: dep.goal_id,
      started: result.started,
      started_task_id: result.task?.id || null,
      reason: result.reason,
    });
  }

  return { auto_started: details.some((d) => d.started), details };
}
