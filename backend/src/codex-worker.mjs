// @ts-check
/**
 * Codex worker execution orchestration.
 * Extracted from gptwork-server.mjs to reduce its complexity.
 *
 * Exports:
 *   startCodexWorker        - Main worker loop (tick-based)
 *   runAssignedCodexTasks   - Process assigned tasks with concurrency
 *   mapConcurrent           - Generic concurrent map helper
 *
 * processGeneralTask remains in gptwork-server.mjs and is passed
 * as a dependency to runAssignedCodexTasks.
 */

import { appendFileSync } from "node:fs";
import {
  createWorkerState,
  markWorkerStarted,
  markWorkerTickStarted,
  recordWorkerTickSuccess,
  recordWorkerTickError,
  markWorkerTickFinished,
  markWorkerNextTickScheduled,
} from "./codex-worker-state.mjs";
import {
  requireScope,
  canAccessProject,
  canAccessWorkspace,
  defaultTokenContext,
} from "./auth-context.mjs";
import { normalizeLegacyModes, updateTask } from "./task-lifecycle.mjs";
import { isCodexSessionInventoryTask } from "./task-status.mjs";
import { completeCodexSessionInventoryTask } from "./tool-groups/session-inventory-tools-group.mjs";

// ---------------------------------------------------------------------------
// Main worker loop
// ---------------------------------------------------------------------------

export function startCodexWorker(server, {
  intervalMs = Number(process.env.GPTWORK_CODEX_WORKER_INTERVAL_MS || 5000),
  limit = Number(process.env.GPTWORK_CODEX_WORKER_LIMIT || 10),
  githubSyncLimit = Number(process.env.GPTWORK_GITHUB_SYNC_LIMIT || 20),
  concurrency = Number(process.env.GPTWORK_CODEX_WORKER_CONCURRENCY || 4),
  workerState = createWorkerState(),
  backoffMaxMs = Number(process.env.GPTWORK_CODEX_WORKER_BACKOFF_MAX_MS || 60000),
  backoffFactor = Number(process.env.GPTWORK_CODEX_WORKER_BACKOFF_FACTOR || 2),
  githubSyncIntervalMs = Number(process.env.GPTWORK_GITHUB_SYNC_INTERVAL_MS || 30000),
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;
  let consecutiveEmptyTicks = 0;
  let lastGithubSyncTime = 0;

  // Initialize module-level worker state tracking
  markWorkerStarted(workerState, { intervalMs, limit, concurrency });

  async function tick() {
    if (stopped || running) return;
    running = true;
    markWorkerTickStarted(workerState);
    try {
      // Throttled GitHub sync: only run if enough time has passed
      let githubSync = null;
      if (typeof server.syncGithubIssuesForWorker === "function") {
        const now = Date.now();
        if (now - lastGithubSyncTime >= githubSyncIntervalMs) {
          lastGithubSyncTime = now;
          try {
            githubSync = await server.syncGithubIssuesForWorker({ limit: githubSyncLimit });
          } catch (error) {
            githubSync = { ok: false, error: error.message };
          }
        }
      }

      const wr = await server.runAssignedCodexTasks({ limit, concurrency });
      if (githubSync) wr.github_sync = githubSync;
      recordWorkerTickSuccess(workerState, wr);

      // Empty-queue backoff: if no candidates found, increase interval
      if (wr.inspected > 0) {
        consecutiveEmptyTicks = 0;
      } else {
        consecutiveEmptyTicks++;
      }

      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) {
        const done = wr.tasks.filter(t => t.status === "completed").length;
        const skip = wr.tasks.filter(t => t.skipped).length;
        appendFileSync(_lp, `[gptwork-worker] tick inspected=${wr.inspected} completed=${done} skipped=${skip}\n`);
      }}
    } catch (error) {
      recordWorkerTickError(workerState, error);
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] ${error.message}\n`); }
    } finally {
      markWorkerTickFinished(workerState);
      running = false;
      if (!stopped) {
        // Apply exponential backoff when queue is consistently empty
        let effectiveInterval = intervalMs;
        if (consecutiveEmptyTicks > 0) {
          const factor = Math.pow(backoffFactor, consecutiveEmptyTicks);
          effectiveInterval = Math.min(intervalMs * factor, backoffMaxMs);
        }
        markWorkerNextTickScheduled(workerState, { intervalMs: effectiveInterval });
        timer = setTimeout(tick, effectiveInterval);
      }
    }
  }

  // Run startup reconciliation once before the first tick
  (async () => {
    try {
      const result = await server.reconcileStaleTasks();
      if (result.ok && result.reconciled > 0) {
        const _lp = process.env.GPTWORK_LOG_PATH;
        if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciled ${result.reconciled} stale tasks\n`);
      }
    } catch (e) {
      // Non-fatal: reconciliation errors should not prevent normal operation
    }
    // Start regular tick cycle
    if (!stopped) tick();
  })();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Task execution orchestration
// ---------------------------------------------------------------------------

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

export async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
