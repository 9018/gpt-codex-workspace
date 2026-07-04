// == GPTWork runtime reconciler ==============================================
// Orchestrates stale task detection, repo lock reconciliation,
// restart-marker verification, and MA11-R6 blocker-manifest generation.
// ============================================================================

import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { defaultTokenContext } from "./auth-context.mjs";
import { resolve, dirname } from "node:path";
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

        // ── P0-MA11-R6: Blocker manifest + deterministic convergence ──
        try {
          const { generateBlockerManifest, applyDeterministicConvergence } = await import("./blocker-manifest.mjs");

          const manifestResult = await generateBlockerManifest(store);
          const totalBlockers = manifestResult.manifest.length;

          // Write manifest to a persistent path for inspection
          const statePath = store.statePath || ".";
          const manifestDir = resolve(dirname(statePath), "../r6-manifest");
          if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
          writeFileSync(resolve(manifestDir, "blocker-manifest.json"), JSON.stringify(manifestResult, null, 2));

          // Apply deterministic convergence
          const convResult = await applyDeterministicConvergence(store, { dryRun: false });
          writeFileSync(resolve(manifestDir, "convergence-result.json"), JSON.stringify(convResult, null, 2));

          if (totalBlockers > 0 || (convResult.converged && convResult.converged.length > 0)) {
            const before = manifestResult.beforeCounts?.current_blockers || 0;
            const after = convResult.afterCounts?.current_blockers || 0;
            const delta = before - after;
            const msg = `[gptwork-worker] MA11-R6: blockers=${totalBlockers} cats=${JSON.stringify(manifestResult.categories)} converged=${convResult.converged?.length || 0} delta=Δ${delta >= 0 ? "-" : "+"}${Math.abs(delta)}`;
            if (logPath) appendFileSync(logPath, msg + "\n");
          }
        } catch (r6Err) {
          if (logPath) appendFileSync(logPath, `[gptwork-worker] MA11-R6 error (non-fatal): ${r6Err.message}\n`);
        }

        // ── P0-MA11-R3: Historical convergence (stale-state sweeper) ──
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
