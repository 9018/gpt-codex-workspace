import { appendFileSync } from "node:fs";
import { reconcileRepoLocks, releaseLockForTask } from "./repo-lock.mjs";
import { isTerminalStatus } from "./task-status-taxonomy.mjs";

export async function reconcileRuntimeRepoLocks({ state = {}, config, logPath }) {
  const workspaceRoot = config?.defaultWorkspaceRoot;
  let terminalReleased = 0;
  const terminalReleaseDetails = [];

  // A server restart can leave a fresh, process-owned lock behind after its task
  // has already reached a terminal state. Heartbeat/PID checks alone cannot
  // distinguish that lock from active work, so task state is authoritative.
  for (const task of state.tasks || []) {
    if (!task?.id || !isTerminalStatus(task.status)) continue;
    try {
      const released = await releaseLockForTask(workspaceRoot, task.id);
      if (released?.released) {
        terminalReleased += 1;
        terminalReleaseDetails.push({ task_id: task.id, status: task.status });
        if (logPath) appendFileSync(logPath, `[gptwork-worker] terminal repo lock released: task ${task.id} status=${task.status}\n`);
      }
    } catch (error) {
      if (logPath) appendFileSync(logPath, `[gptwork-worker] terminal repo lock release error for ${task.id}: ${error.message}\n`);
    }
  }

  // Phase B: Reconcile remaining stale repo locks.
  try {
    const lockRec = await reconcileRepoLocks(workspaceRoot);
    if (lockRec.reconciled > 0) {
      if (logPath) appendFileSync(logPath, `[gptwork-worker] repo lock reconciliation: ${lockRec.reconciled} stale lock(s) marked stale\n`);
      for (const detail of lockRec.details) {
        if (logPath) appendFileSync(logPath, `[gptwork-worker]   lock ${detail.safe_repo_id} (task ${detail.task_id}): ${detail.reason}\n`);
      }
    }
    return {
      ...lockRec,
      terminal_released: terminalReleased,
      terminal_release_details: terminalReleaseDetails,
    };
  } catch (error) {
    if (logPath) appendFileSync(logPath, `[gptwork-worker] repo lock reconciliation error: ${error.message}\n`);
    return {
      reconciled: 0,
      stale: 0,
      active: 0,
      details: [],
      terminal_released: terminalReleased,
      terminal_release_details: terminalReleaseDetails,
      error: error.message,
    };
  }
}
