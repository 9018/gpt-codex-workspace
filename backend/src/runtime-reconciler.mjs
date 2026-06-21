// == GPTWork runtime reconciler ==============================================
// Orchestrates stale task detection, repo lock reconciliation, and
// restart-marker verification on service startup.
// ============================================================================

import { appendFileSync } from "node:fs";
import { defaultTokenContext } from "./auth-context.mjs";
import { reconcileRunningTasks } from "./runtime-reconciler-stale-tasks.mjs";
import { reconcileRuntimeRepoLocks } from "./runtime-reconciler-repo-locks.mjs";
import { reconcileRestartMarkers } from "./runtime-reconciler-restart-markers.mjs";

export function createReconciler({ store, config, github, notifyTerminalTaskIfNeeded }) {
  return {
    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      try {
        const state = await store.load();
        const logPath = process.env.GPTWORK_LOG_PATH;
        const reconciled = await reconcileRunningTasks({ state, store, config, notifyTerminalTaskIfNeeded, logPath });
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
