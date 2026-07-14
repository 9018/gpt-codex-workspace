// == GPTWork runtime reconciler ==============================================
// Orchestrates stale task detection, repo lock reconciliation,
// restart-marker verification, MA11-R6 blocker-manifest generation,
// and notification recovery for missed lifecycle events.
// ============================================================================

import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { defaultTokenContext } from "./auth-context.mjs";
import { resolve, dirname } from "node:path";
import { reconcileRunningTasks } from "./runtime-reconciler-stale-tasks.mjs";
import { reconcileRuntimeRepoLocks } from "./runtime-reconciler-repo-locks.mjs";
import { reconcileRestartMarkers } from "./runtime-reconciler-restart-markers.mjs";
import { runHistoricalConvergence } from "./stale-state-sweeper.mjs";

export function createReconciler({ store, config, github, notifyTerminalTaskIfNeeded, recoverMissedNotifications }) {
  return {
    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      try {
        const state = await store.load();
        const logPath = process.env.GPTWORK_LOG_PATH;
        const reconciled = await reconcileRunningTasks({ state, store, config, notifyTerminalTaskIfNeeded, logPath });

        // ── P0: Notification recovery for missed lifecycle events ──
        // When the worker was enabled_but_not_running (e.g., after a restart),
        // tasks may have completed without triggering lifecycle Bark notifications.
        // This step replays missed notifications so notification_status reflects
        // last_attempt, last_success, last_task_id, and last_task_event.
        if (typeof recoverMissedNotifications === "function") {
          try {
            const recoveryResult = await recoverMissedNotifications(state.tasks || []);
            if (recoveryResult.replayed.length > 0) {
              if (logPath) {
                for (const r of recoveryResult.replayed) {
                  appendFileSync(logPath, `[gptwork-worker] notification recovery: ${r}\n`);
                }
              }
            }
            if (recoveryResult.errors.length > 0) {
              if (logPath) {
                for (const e of recoveryResult.errors) {
                  appendFileSync(logPath, `[gptwork-worker] notification recovery error: ${e}\n`);
                }
              }
            }
          } catch (recoveryErr) {
            if (logPath) appendFileSync(logPath, `[gptwork-worker] notification recovery error: ${recoveryErr.message}\n`);
          }
        }

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


        // ── AFC-10: Runtime Watch Diagnostics (non-mutating) ──
        try {
          const { runWatchWithRecovery } = await import("./runtime-watch-diagnostics.mjs");
          const workspaceRoot = config.defaultWorkspaceRoot;
          const watchResult = await runWatchWithRecovery({
            store,
            workspaceRoot,
            config,
            dryRun: true, // Always diagnostic-only in the reconciler; recovery is explicit
          });

          if (watchResult.diagnostics.summary.total_findings > 0) {
            if (logPath) {
              appendFileSync(logPath, `[gptwork-worker] AFC-10 runtime watch: ${watchResult.diagnostics.summary.total_findings} finding(s)
`);
              for (const action of watchResult.diagnostics.recovery_actions.slice(0, 5)) {
                appendFileSync(logPath, `[gptwork-worker]   [${action.safety}] ${action.action} — ${action.description}
`);
              }
              if (watchResult.diagnostics.recovery_actions.length > 5) {
                appendFileSync(logPath, `[gptwork-worker]   ... and ${watchResult.diagnostics.recovery_actions.length - 5} more action(s)
`);
              }
            }
          }
        } catch (watchErr) {
          if (logPath) appendFileSync(logPath, `[gptwork-worker] AFC-10 runtime watch error (non-fatal): ${watchErr.message}
`);
        }
        // ── AFC-10: Runtime Patrol Loop (diagnostic-only; never mutates) ──
        try {
          const { runPatrolLoop } = await import("./runtime-patrol-loop.mjs");
          const workspaceRoot = config.defaultWorkspaceRoot;
          const patrolResult = await runPatrolLoop({
            store,
            canonicalRepoPath: config.canonicalRepoPath || workspaceRoot,
            config,
            dryRun: true,
          });

          if (patrolResult.summary.total_findings > 0) {
            if (logPath) {
              appendFileSync(logPath, `[gptwork-worker] AFC-10 patrol loop: ${patrolResult.summary.total_findings} finding(s)
`);
              for (const [cat, count] of Object.entries(patrolResult.summary.categories || {})) {
                appendFileSync(logPath, `[gptwork-worker]   ${cat}: ${count}
`);
              }
              appendFileSync(logPath, `[gptwork-worker]   safe_actions: ${patrolResult.summary.safe_actions}, needs_review: ${patrolResult.summary.needs_review}
`);
              for (const action of patrolResult.recovery_actions.slice(0, 5)) {
                appendFileSync(logPath, `[gptwork-worker]   [${action.safety}] ${action.action} — ${action.description}
`);
              }
              if (patrolResult.recovery_actions.length > 5) {
                appendFileSync(logPath, `[gptwork-worker]   ... and ${patrolResult.recovery_actions.length - 5} more action(s)
`);
              }
            }
          }
        } catch (patrolErr) {
          if (logPath) appendFileSync(logPath, `[gptwork-worker] AFC-10 patrol loop error (non-fatal): ${patrolErr.message}
`);
        }


        await reconcileRuntimeRepoLocks({ state, config, logPath });
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
