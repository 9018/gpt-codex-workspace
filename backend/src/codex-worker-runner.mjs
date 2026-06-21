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

export async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4 } = {}, context = defaultTokenContext("system"), { processGeneralTask } = {}) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  const state = await store.load();
  await normalizeLegacyModes(store, state);

  // Use indexed query from StateStore instead of full scan on state.tasks.
  // The index is O(1) per status and was rebuilt after load().
  const candidates = store.getCodexActiveQueueCandidates(
    ["assigned", "queued", "waiting_for_lock"],
    maxTasks
  ).filter((task) =>
    canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
  );

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
      return await processGeneralTask(store, config, task, context, github);
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

// ---------------------------------------------------------------------------
// Generic concurrent map helper
// ---------------------------------------------------------------------------
