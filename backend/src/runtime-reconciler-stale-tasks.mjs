import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRestartMarker } from "./safe-restart.mjs";
import { getLatestRun, getRunFilePath, fireHeartbeat } from "./codex-run-metadata.mjs";
import { releaseLockForTask } from "./repo-lock.mjs";
import { parseResultJson, buildTaskResult } from "./codex-result-parser.mjs";
import { updateGoalStatus } from "./task-lifecycle.mjs";

export async function reconcileRunningTasks({ state, store, config, notifyTerminalTaskIfNeeded, logPath }) {
  const now = Date.now();
  const _lp = logPath;
  const stallThreshold = (config.codexStallThreshold || 600) * 1000;

  const reconciled = [];
  for (const task of (state.tasks || [])) {
    if (task.status !== "running") continue;
    try {
      const marker = await loadRestartMarker(config.defaultWorkspaceRoot, task.id);
      if (marker && (marker.status === "pending" || marker.status === "scheduled" || marker.status === "restarted")) continue;
    } catch {}
    let shouldMark = false;
    let message = "";
    const run = await getLatestRun(config.defaultWorkspaceRoot, task.id);
    if (!run) {
      shouldMark = true;
      message = "Startup reconciliation: task was in running state with no run metadata or restart marker. Marked as waiting_for_review/codex_stalled.";
    } else {
      const ageMs = now - new Date(run.last_heartbeat_at).getTime();
      let processAlive = false;
      if (run.codex_child_pid && typeof run.codex_child_pid === "number" && run.codex_child_pid > 0) {
        try { process.kill(run.codex_child_pid, 0); processAlive = true; } catch {}
      }
      if (!processAlive && ageMs > stallThreshold) {
        shouldMark = true;
        message = "Startup reconciliation: Codex process not found and heartbeat is stale. Marked as waiting_for_review/codex_stalled.";
      }
    }
    if (shouldMark) {
      const goalId = task.goal_id;
      const resultJsonPath = goalId
        ? join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "result.json")
        : null;
      let recovered = false;
      if (resultJsonPath && existsSync(resultJsonPath)) {
        try {
          const rawContent = readFileSync(resultJsonPath, "utf8");
          JSON.parse(rawContent);
          const parsedResult = await parseResultJson(resultJsonPath);
          if (parsedResult && parsedResult.status) {
            const taskResult = buildTaskResult(parsedResult, {});
            const recoveredStatus = parsedResult.status === "completed" ? "completed"
              : parsedResult.status === "failed" ? "failed"
              : "waiting_for_review";
            const prevRecoveryStatus = task.status;
            task.status = recoveredStatus;
            task.result = { ...(task.result || {}), ...taskResult };
            task.result.reconciled_at = new Date().toISOString();
            task.result.recovered_from_result_json = true;
            task.logs = task.logs || [];
            task.logs.push({ time: new Date().toISOString(), message: "[worker] recovered completed result from existing result.json before codex_stalled" });
            try { await updateGoalStatus(store, goalId, recoveredStatus, new Date().toISOString()); } catch {}
            if (run && run.run_id) {
              try {
                const runFp = getRunFilePath(config.defaultWorkspaceRoot, task.id, run.run_id);
                if (existsSync(runFp)) {
                  fireHeartbeat(runFp, "completed", { result_json_path: resultJsonPath, phase: "completed" });
                }
              } catch {}
            }
            try { await releaseLockForTask(config.defaultWorkspaceRoot, task.id); } catch {}
            try { await notifyTerminalTaskIfNeeded(task); } catch {}
            reconciled.push({ task_id: task.id, previous_status: prevRecoveryStatus, new_status: recoveredStatus, message: "Recovered from existing result.json" });
            if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} recovered from result.json -> ${recoveredStatus}\n`);
            recovered = true;
          } else {
            throw new Error("result.json at " + resultJsonPath + " exists but does not match expected contract (missing or invalid status field)");
          }
        } catch (parseErr) {
          const prevParseStatus = task.status;
          task.status = "waiting_for_review";
          task.result = task.result || {};
          task.result.kind = "result_json_parse_failed";
          task.result.reconciliation_message = "result.json found at " + resultJsonPath + " but parse failed: " + parseErr.message;
          task.result.reconciled_at = new Date().toISOString();
          task.logs = task.logs || [];
          task.logs.push({ time: new Date().toISOString(), message: "[worker] result.json parse failed for reconciliation: " + parseErr.message });
          try { await releaseLockForTask(config.defaultWorkspaceRoot, task.id); } catch {}
          try { await notifyTerminalTaskIfNeeded(task); } catch {}
          reconciled.push({ task_id: task.id, previous_status: prevParseStatus, new_status: "waiting_for_review", message: "result.json parse failed: " + parseErr.message });
          if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} result.json parse failed -> waiting_for_review\n`);
          recovered = true;
        }
      }
      if (!recovered) {
        const prevStatus = task.status;
        task.status = "waiting_for_review";
        task.result = task.result || {};
        task.result.kind = "codex_stalled";
        task.result.reconciliation_message = message;
        task.result.reconciled_at = new Date().toISOString();
        task.logs = task.logs || [];
        task.logs.push({ time: new Date().toISOString(), message });
        reconciled.push({ task_id: task.id, previous_status: prevStatus, new_status: "waiting_for_review", message });
        if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${task.id} -> waiting_for_review (${message})\n`);
      }
    }
  }
  if (reconciled.length > 0) {
    await store.save();
    if (_lp) appendFileSync(_lp, `[gptwork-worker] startup reconciliation: ${reconciled.length} stale tasks marked waiting_for_review\n`);
  }
  return reconciled;
}
