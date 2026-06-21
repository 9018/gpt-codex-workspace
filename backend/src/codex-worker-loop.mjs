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
