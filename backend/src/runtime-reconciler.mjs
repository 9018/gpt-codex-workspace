// == GPTWork runtime reconciler ==============================================
// Orchestrates stale task detection, repo lock reconciliation, and
// restart-marker verification on service startup.
// ============================================================================

import { appendFileSync } from "node:fs";
import { defaultTokenContext } from "./auth-context.mjs";
import { reconcileRunningTasks } from "./runtime-reconciler-stale-tasks.mjs";
import { reconcileRuntimeRepoLocks } from "./runtime-reconciler-repo-locks.mjs";
import { reconcileRestartMarkers } from "./runtime-reconciler-restart-markers.mjs";
import { runHistoricalConvergence } from "./stale-state-sweeper.mjs";

export function createReconciler({ store, config, github, notifyTerminalTaskIfNeeded }) {
  return {
    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      try {
        const state = await store.load();
        const logPath = process.env.GPTWORK_LOG_PATH;
        const reconciled = await reconcileRunningTasks({ state, store, config, notifyTerminalTaskIfNeeded, logPath });

        // P0-MA11-R3: Run historical convergence after startup reconciliation.
        // This persists sweep actions (e.g. waiting_for_repair → completed) and
        // completes queued agent_runs for tasks with result evidence.
        // Idempotent: uses internal lock guard to prevent concurrent runs.
        try {
          const convResult = await runHistoricalConvergence(store);
          if (convResult.applied > 0 || convResult.agentRunCompletions.length > 0) {
            if (logPath) appendFileSync(logPath, `[gptwork-worker] historical convergence: ${convResult.applied} sweep actions applied, ${convResult.agentRunCompletions.length} agent_run completions\n`);
          }
        } catch (convErr) {
          if (logPath) appendFileSync(logPath, `[gptwork-worker] historical convergence error (non-fatal): ${convErr.message}\n`);
        }

        await reconcileRuntimeRepoLocks({ config, logPath });
        const restartVerifications = await reconcileRestartMarkers({ state, store, config, github, notifyTerminalTaskIfNeeded, logPath });
        await store.save();
        return { ok: true, reconciled: reconciled.length, details: reconciled, restart_verifications: restartVerifications };
      } catch (error) {
        const logPath = process.env.GPTWORK_LOG_PATH;
        if (logPath) appendFileSync(logPath, `[gptwork-worker] reconciliation error: ${error.message}\n`);
        return { ok: false, error: error.message };
      }
    },
  };
}
