/**
 * Task lifecycle mutation and query helpers.
 *
 * This module contains task/goal mutation functions, state lookups, and
 * lifecycle notification primitives used by the server and worker.
 *
 * Functions that require Codex worker execution, safe restart, goal-files,
 * prompt builder, workspace IO, or public tool schemas are intentionally
 * kept in gptwork-server.mjs.
 */

import { isCodexSessionInventoryTaskKind } from "./task-status.mjs";
import { isTerminalStatus } from "./task-status-taxonomy.mjs";
import { WORKSTREAM_IDENTITY_FIELDS } from "./workstream/workstream-model.mjs";

// ---------------------------------------------------------------------------
// State guard
// ---------------------------------------------------------------------------

export function ensureGoalState(state) {
  state.goals ||= [];
  state.conversations ||= [];
  state.memories ||= [];
  state.tasks ||= [];
  state.activities ||= [];
}

// ---------------------------------------------------------------------------
// Goal lookup
// ---------------------------------------------------------------------------

export function findGoalInState(state, { goal_id, task_id } = {}) {
  const goal = goal_id
    ? state.goals.find((item) => item.id === goal_id)
    : state.goals.find((item) => item.task_id === task_id);
  if (!goal) throw new Error(`goal not found: ${goal_id || task_id || "missing id"}`);
  return goal;
}

// ---------------------------------------------------------------------------
// Task → goal payload conversion
// ---------------------------------------------------------------------------

export function taskPayloadFromTask(task) {
  const payload = {
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
    mode: "full",
    messages: [
      { role: "user", content: task.description || task.title },
      { role: "chatgpt", content: `Created compatibility goal from task ${task.id}.` }
    ],
    memories: []
  };
  const metadata = task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
    ? task.metadata
    : {};
  const explicitContract = task.acceptance_contract || metadata.acceptance_contract;
  if (explicitContract && typeof explicitContract === "object" && !Array.isArray(explicitContract)) {
    payload.acceptance_contract = structuredClone(explicitContract);
  }
  for (const key of ["operation_kind", "mutation_scope"]) {
    const value = task[key] ?? metadata[key];
    if (value !== undefined) payload[key] = value;
  }
  for (const key of WORKSTREAM_IDENTITY_FIELDS) {
    if (task[key] !== undefined) payload[key] = task[key];
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Progress emit
// ---------------------------------------------------------------------------

export function emitTaskProgress(context, task, phase, message) {
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

// ---------------------------------------------------------------------------
// Legacy mode normalization
// ---------------------------------------------------------------------------

export async function normalizeLegacyModes(store, state) {
  let changed = false;
  for (const task of state.tasks || []) {
    if (task.mode !== "full") {
      task.legacy_mode = task.legacy_mode || task.mode || null;
      task.mode = "full";
      task.updated_at = task.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  for (const goal of state.goals || []) {
    if (goal.mode !== "full") {
      goal.legacy_mode = goal.legacy_mode || goal.mode || null;
      goal.mode = "full";
      goal.updated_at = goal.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  if (changed && typeof store.save === "function") await store.save();
}

// ---------------------------------------------------------------------------
// Task find
// ---------------------------------------------------------------------------

export async function findTask(store, task_id) {
  const state = await store.load();
  const task = typeof store.findTaskById === "function"
    ? await store.findTaskById(task_id)
    : state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  return task.mode === "full"
    ? task
    : { ...task, legacy_mode: task.legacy_mode || task.mode || null, mode: "full" };
}

// ---------------------------------------------------------------------------
// Terminal notifier setter
// (called by gptwork-server.mjs during startup to wire in Bark notification)
// ---------------------------------------------------------------------------

let _terminalNotifier = null;

export function setTerminalNotifier(fn) {
  _terminalNotifier = fn;
}

export async function notifyTerminalTask(task) {
  if (_terminalNotifier) await _terminalNotifier(task);
}

// ---------------------------------------------------------------------------
// Task update — emits lifecycle events on status transitions
// ---------------------------------------------------------------------------

/**
 * Emit a specific lifecycle event safely (non-critical).
 */
async function _emitLifecycleEventSafe(emitter, event, task, prevStatus, nextStatus) {
  if (!emitter) return;
  try {
    await emitter({
      task,
      event,
      previousStatus: prevStatus,
      nextStatus: nextStatus,
    });
  } catch (leErr) {
    /* Non-fatal */
  }
}

export let legacyDirectWriteCount = 0;

export async function updateTask(store, task_id, updater, options = {}) {
  // Route through canonical transition service if transition_command is provided
  if (options.transition_command) {
    if (typeof options.transition_service?.transitionTask !== 'function') {
      throw new Error('updateTask: transition_service required when transition_command is provided');
    }
    return options.transition_service.transitionTask(options.transition_command);
  }
  const state = await store.load();
  const task = typeof store.findTaskById === "function"
    ? await store.findTaskById(task_id)
    : state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  const prevStatus = task.status;

  // Legacy direct write tracking and terminal regression guard
  if (isTerminalStatus(prevStatus)) {
    const proxy = Object.assign({}, task);
    const proxyUpdater = (t) => updater(t);
    try { proxyUpdater(proxy); } catch {}
    if (proxy.status && proxy.status !== prevStatus && !isTerminalStatus(proxy.status)) {
      throw new Error(
        `[state-boundary] Cannot regress terminal task ${task_id} from ${prevStatus} to ${proxy.status}. Use transitionTask with reconciliation_correction instead.`
      );
    }
  }

  // Track legacy direct writes
  task.metadata = task.metadata || {};
  task.metadata.legacy_direct_status_write_count = (task.metadata.legacy_direct_status_write_count || 0) + 1;
  legacyDirectWriteCount++;

  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.warn('[state-boundary] legacy direct task status mutation in task-lifecycle.updateTask: ' +
      task_id + ' ' + prevStatus + ' → ' + (proxy?.status || task.status));
  }
  updater(task);
  task.updated_at = new Date().toISOString();
  state.activities ||= [];
  state.activities.push({ time: task.updated_at, type: "task.updated", task_id, status: task.status });

  // Use shared notification helper for terminal task states (deduplicated per task/status/channel)
  await notifyTerminalTask(task);

  // Emit lifecycle events for status transitions
  if (_lifecycleEventEmitter && prevStatus !== task.status) {
    // Always emit the generic event matching the new status
    await _emitLifecycleEventSafe(_lifecycleEventEmitter, "task_" + task.status, task, prevStatus, task.status);

    // Emit specific events for key transitions
    if (task.status === "running") {
      // Emit task_started when transitioning to running for the first time
      if (prevStatus === "assigned" || prevStatus === "queued") {
        await _emitLifecycleEventSafe(_lifecycleEventEmitter, "task_started", task, prevStatus, task.status);
      }
    }
  }

  await store.save();
  return { task };
}

// ---------------------------------------------------------------------------
// Goal status update
// ---------------------------------------------------------------------------

export async function updateGoalStatus(store, goalId, status, updatedAt = new Date().toISOString()) {
  const state = await store.load();
  ensureGoalState(state);
  const goal = typeof store.findGoalById === "function"
    ? await store.findGoalById(goalId)
    : state.goals.find((item) => item.id === goalId);
  if (!goal) return null;
  goal.status = status;
  goal.updated_at = updatedAt;
  state.activities.push({ time: updatedAt, type: `goal.${status}`, goal_id: goal.id, title: goal.title });
  await store.save();
  return goal;
}

// ---------------------------------------------------------------------------
// Lifecycle event emitter setter
// (called by gptwork-server.mjs during startup to wire in Bark lifecycle events)
// ---------------------------------------------------------------------------

let _lifecycleEventEmitter = null;

export function setLifecycleEventEmitter(fn) {
  _lifecycleEventEmitter = fn;
}
