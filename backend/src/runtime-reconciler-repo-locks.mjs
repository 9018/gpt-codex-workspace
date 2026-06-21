import { appendFileSync } from "node:fs";
import { reconcileRepoLocks } from "./repo-lock.mjs";

export async function reconcileRuntimeRepoLocks({ config, logPath }) {
  // Phase B: Reconcile stale repo locks
  try {
    const _lockRec = await reconcileRepoLocks(config.defaultWorkspaceRoot);
    if (_lockRec.reconciled > 0) {
      if (logPath) appendFileSync(logPath, `[gptwork-worker] repo lock reconciliation: ${_lockRec.reconciled} stale lock(s) marked stale\n`);
      for (const _d of _lockRec.details) {
        if (logPath) appendFileSync(logPath, `[gptwork-worker]   lock ${_d.safe_repo_id} (task ${_d.task_id}): ${_d.reason}\n`);
      }
    }
  } catch (_lockRecErr) {
    if (logPath) appendFileSync(logPath, `[gptwork-worker] repo lock reconciliation error: ${_lockRecErr.message}\n`);
  }
}
