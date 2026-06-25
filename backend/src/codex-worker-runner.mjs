import {
  requireScope,
  canAccessProject,
  canAccessWorkspace,
  defaultTokenContext,
} from "./auth-context.mjs";
import { normalizeLegacyModes, updateTask } from "./task-lifecycle.mjs";
import { isCodexSessionInventoryTask } from "./task-status.mjs";
import { completeCodexSessionInventoryTask } from "./tool-groups/session-inventory-tools-group.mjs";
import { mapConcurrent } from "./codex-worker-concurrency.mjs";
import { startQueuedGoals } from "./goal-queue.mjs";

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error || "unknown error");
}

async function transitionTaskForWorker(store, task, status, message, extra = {}) {
  const updated = await updateTask(store, task.id, (t) => {
    t.status = status;
    t.logs ||= [];
    t.logs.push({ time: new Date().toISOString(), message });
    if (extra.result) {
      t.result = { ...(t.result || {}), ...extra.result };
    }
  });
  return updated.task;
}

async function markTaskFailed(store, task, error, reason = "worker task failed") {
  const message = errorMessage(error);
  try {
    await transitionTaskForWorker(
      store,
      task,
      "failed",
      `[worker] ${reason}: ${message}`,
      { result: { worker_error: message } }
    );
  } catch {
    // If state update itself fails, still return a per-task failure so one bad
    // task never rejects the whole worker tick.
  }
  return { task_id: task.id, status: "failed", failed: true, progressed: true, error: message };
}

async function markTaskWaitingForReview(store, task, reason) {
  try {
    await transitionTaskForWorker(store, task, "waiting_for_review", `[worker] ${reason}`);
  } catch (error) {
    return markTaskFailed(store, task, error, "failed to park unsupported task");
  }
  return { task_id: task.id, status: "waiting_for_review", skipped: true, transitioned: true, progressed: true, reason };
}

function normalizeWorkerResult(task, result, extra = {}) {
  const item = result && typeof result === "object" ? result : { task_id: task.id, status: task.status, result };
  return {
    task_id: item.task_id || task.id,
    ...item,
    ...extra,
    progressed: Boolean(
      item.progressed ||
      extra.progressed ||
      extra.transitioned ||
      item.transitioned ||
      item.status === "completed" ||
      item.status === "failed"
    ),
  };
}

async function runSingleCodexTask(store, config, github, task, context, processGeneralTask) {
  let transitioned = false;
  try {
    // Auto-promote queued tasks to assigned.
    if (task.status === "queued") {
      await updateTask(store, task.id, (t) => {
        t.status = "assigned";
        if (!t.assignee) t.assignee = "codex";
        t.logs ||= [];
        t.logs.push({ time: new Date().toISOString(), message: "[worker] auto-assigned from queued" });
      });
      task.status = "assigned";
      transitioned = true;
    }

    if (isCodexSessionInventoryTask(task)) {
      const completed = await completeCodexSessionInventoryTask(store, config, github, task, context);
      return normalizeWorkerResult(task, {
        task_id: completed.task.id,
        status: completed.task.status,
        kind: completed.task.result?.kind || "unknown",
        count: completed.task.result?.sessions?.count ?? 0,
      }, { transitioned });
    }

    if (task.mode === "builder" || task.mode === "deploy" || task.mode === "admin") {
      if (typeof processGeneralTask !== "function") {
        return markTaskWaitingForReview(store, task, "no general task processor is configured for this worker");
      }
      const result = await processGeneralTask(store, config, task, context, github);
      return normalizeWorkerResult(task, result, { transitioned });
    }

    return markTaskWaitingForReview(store, task, `unsupported worker mode '${task.mode || "unknown"}'`);
  } catch (error) {
    return markTaskFailed(store, task, error);
  }
}

export async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4 } = {}, context = defaultTokenContext("system"), { processGeneralTask } = {}) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  const state = await store.load();
  await normalizeLegacyModes(store, state);

  // Use indexed query from StateStore instead of full scan on state.tasks.
  // The query is fair across status buckets so large assigned backlogs do not
  // starve queued or waiting_for_lock tasks.
  let candidates = store.getCodexActiveQueueCandidates(
    ["assigned", "queued", "waiting_for_lock"],
    maxTasks
  ).filter((task) =>
    canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
  );

  let queueAutostart = null;
  const desiredActiveCandidates = Math.min(maxConcurrency, maxTasks);
  const availableQueueSlots = Math.max(0, desiredActiveCandidates - candidates.length);
  if (availableQueueSlots > 0) {
    const batchAutostart = await startQueuedGoals(store, config, { max_start: availableQueueSlots }).catch((error) => ({
      started_count: 0,
      any_started: false,
      results: [],
      reason: `queue autostart failed: ${errorMessage(error)}`,
    }));
    queueAutostart = {
      ...batchAutostart,
      started: Boolean(batchAutostart.any_started || batchAutostart.started_count > 0),
    };
    if (queueAutostart.started) {
      candidates = store.getCodexActiveQueueCandidates(
        ["assigned", "queued", "waiting_for_lock"],
        maxTasks
      ).filter((task) =>
        canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
      );
    }
  }

  const results = await mapConcurrent(candidates, maxConcurrency, (task) =>
    runSingleCodexTask(store, config, github, task, context, processGeneralTask)
  );

  const completed = results.filter((item) => item.status === "completed").length;
  const failed = results.filter((item) => item.failed || item.status === "failed").length;
  const skipped = results.filter((item) => item.skipped).length;
  const transitioned = results.filter((item) => item.transitioned).length;
  const progressed = results.filter((item) => item.progressed).length;

  return {
    ok: true,
    inspected: candidates.length,
    concurrency: maxConcurrency,
    queue_autostart: queueAutostart,
    completed,
    failed,
    skipped,
    transitioned,
    progressed,
    tasks: results
  };
}

// ---------------------------------------------------------------------------
// Generic concurrent map helper
// ---------------------------------------------------------------------------
