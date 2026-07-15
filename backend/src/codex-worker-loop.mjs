import { appendFileSync } from "node:fs";
import { runIdleMaintenance } from "./worker-maintenance.mjs";
import { runHistoricalConvergence } from "./stale-state-sweeper.mjs";
import {
  createWorkerState,
  markWorkerStarted,
  markWorkerTickStarted,
  recordWorkerTickSuccess,
  recordWorkerTickError,
  markWorkerTickFinished,
  markWorkerNextTickScheduled,
} from "./codex-worker-state.mjs";
import { persistWorkerRuntimeStatus } from "./worker-runtime-status.mjs";

export function getWorkerProgressCount(result = {}) {
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  // Use explicit progressed when available (including 0) to avoid double-counting
  const progressed = Number(result.progressed);
  if (Number.isFinite(progressed)) return progressed;

  // Fallback: use max() instead of sum() so a task that is both transitioned
  // and completed does not get counted twice in the same tick.
  const explicit = Math.max(
    Number(result.transitioned || 0),
    Number(result.completed || 0),
    Number(result.failed || 0)
  );
  if (explicit > 0) return explicit;
  return tasks.filter((task) =>
    task && (
      task.progressed ||
      task.transitioned ||
      task.status === "completed" ||
      task.status === "failed"
    )
  ).length;
}

function nextRetryTimestamp(now, intervalMs, retryMs) {
  const boundedRetry = Math.max(0, Math.min(Number(retryMs) || 0, Math.max(0, Number(intervalMs) || 0)));
  return now - Math.max(0, intervalMs - boundedRetry);
}

export function startCodexWorker(server, {
  intervalMs = Number(process.env.GPTWORK_CODEX_WORKER_INTERVAL_MS || 5000),
  limit = Number(process.env.GPTWORK_CODEX_WORKER_LIMIT || 10),
  githubSyncLimit = Number(process.env.GPTWORK_GITHUB_SYNC_LIMIT || 20),
  concurrency = Number(process.env.GPTWORK_CODEX_WORKER_CONCURRENCY || 4),
  workerState = createWorkerState(),
  backoffMaxMs = Number(process.env.GPTWORK_CODEX_WORKER_BACKOFF_MAX_MS || 60000),
  backoffFactor = Number(process.env.GPTWORK_CODEX_WORKER_BACKOFF_FACTOR || 2),
  githubSyncIntervalMs = Number(process.env.GPTWORK_GITHUB_SYNC_INTERVAL_MS || 30000),
  githubSyncFailureRetryMs = Number(process.env.GPTWORK_GITHUB_SYNC_FAILURE_RETRY_MS || 5000),
  maintenanceIntervalMs = Number(process.env.GPTWORK_MAINTENANCE_INTERVAL_MS || 21600000),
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;
  let consecutiveIdleTicks = 0;
  let lastGithubSyncTime = 0;
  let lastMaintenanceTime = 0;

  // Initialize module-level worker state tracking
  markWorkerStarted(workerState, { intervalMs, limit, concurrency });
  persistWorkerRuntimeStatus(workerState, { workspaceRoot: process.env.GPTWORK_WORKSPACE_ROOT });

  async function tick() {
    if (stopped || running) return;
    running = true;
    markWorkerTickStarted(workerState);
    persistWorkerRuntimeStatus(workerState, { workspaceRoot: process.env.GPTWORK_WORKSPACE_ROOT });
    try {
      // Throttled idle maintenance: goal / tmp pressure check (log-only)
      if (typeof server.getDefaultWorkspaceRoot === "function") {
        const now = Date.now();
        if (now - lastMaintenanceTime >= maintenanceIntervalMs) {
          lastMaintenanceTime = Date.now();
          try {
            const wsRoot = await server.getDefaultWorkspaceRoot();
            if (wsRoot) runIdleMaintenance(wsRoot).catch(() => {});
            // P0-MA11-R3: Periodic historical convergence alongside maintenance.
            try {
              const store = server.getStoreForTests ? server.getStoreForTests() : null;
              if (store) await runHistoricalConvergence(store);
            } catch {}
          } catch {
            // Maintenance is best-effort and should not block task execution.
          }
        }
      }

      // Throttled GitHub sync: successful syncs use the normal interval;
      // failures retry sooner so issue state does not feel stale to operators.
      let githubSync = null;
      if (typeof server.syncGithubIssuesForWorker === "function") {
        const now = Date.now();
        if (now - lastGithubSyncTime >= githubSyncIntervalMs) {
          try {
            githubSync = await server.syncGithubIssuesForWorker({ limit: githubSyncLimit });
            if (githubSync?.ok === false) {
              lastGithubSyncTime = nextRetryTimestamp(now, githubSyncIntervalMs, githubSyncFailureRetryMs);
            } else {
              lastGithubSyncTime = Date.now();
            }
          } catch (error) {
            githubSync = { ok: false, error: error.message };
            lastGithubSyncTime = nextRetryTimestamp(now, githubSyncIntervalMs, githubSyncFailureRetryMs);
          }
        }
      }

      const wr = await server.runAssignedCodexTasks({ limit, concurrency, non_blocking: true });
      if (githubSync) wr.github_sync = githubSync;
      recordWorkerTickSuccess(workerState, wr);

      // Back off only when the tick made no user-visible progress. Merely
      // inspecting a repeatedly skipped/stuck task should not keep hot polling.
      const progressCount = getWorkerProgressCount(wr);
      if (progressCount > 0) {
        consecutiveIdleTicks = 0;
      } else {
        consecutiveIdleTicks++;
      }

      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) {
        const done = wr.tasks.filter(t => t.status === "completed").length;
        const fail = wr.tasks.filter(t => t.status === "failed" || t.failed).length;
        const skip = wr.tasks.filter(t => t.skipped).length;
        appendFileSync(_lp, `[gptwork-worker] tick inspected=${wr.inspected} progressed=${progressCount} completed=${done} failed=${fail} skipped=${skip}\n`);
      }}
    } catch (error) {
      recordWorkerTickError(workerState, error);
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] ${error.message}\n`); }
    } finally {
      markWorkerTickFinished(workerState);
      persistWorkerRuntimeStatus(workerState, { workspaceRoot: process.env.GPTWORK_WORKSPACE_ROOT });
      running = false;
      if (!stopped) {
        // Apply exponential backoff when the worker is idle or repeatedly stuck.
        let effectiveInterval = intervalMs;
        if (consecutiveIdleTicks > 0) {
          const factor = Math.pow(backoffFactor, consecutiveIdleTicks);
          effectiveInterval = Math.min(intervalMs * factor, backoffMaxMs);
        }
        markWorkerNextTickScheduled(workerState, { intervalMs: effectiveInterval });
        persistWorkerRuntimeStatus(workerState, { workspaceRoot: process.env.GPTWORK_WORKSPACE_ROOT });
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
    // Run startup idle maintenance (log-only)
    try {
      const wsRoot = server.getDefaultWorkspaceRoot ? await server.getDefaultWorkspaceRoot() : null;
      if (wsRoot) {
        runIdleMaintenance(wsRoot).catch(() => {});
        lastMaintenanceTime = Date.now();
      }
      // P0-MA11-R3: Run historical convergence at startup (non-blocking).
      // The reconciler already calls it, but this is a safety net in case the
      // reconciler is bypassed or skipped. Idempotent by design.
      try {
        const store = server.getStoreForTests ? server.getStoreForTests() : null;
        if (store) await runHistoricalConvergence(store);
      } catch {}
    } catch {
      // Non-fatal
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
