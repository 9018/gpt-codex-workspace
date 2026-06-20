// == GPTWork runtime reconciler ==============================================
// Handles stale task detection, result.json recovery, repo lock reconciliation,
// and restart-marker verification on service startup.
//
// Extracted from gptwork-server.mjs (P2.4 refactoring) — zero behavioral change.
// ============================================================================

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTokenContext } from "./auth-context.mjs";
import {
  loadRestartMarker,
  scanPendingRestartMarkers,
  updateRestartMarkerStatus,
  verifyRestartMarker,
  scanMisplacedMarkersSync,
  migrateMisplacedMarker,
  removeMisplacedMarker,
} from "./safe-restart.mjs";
import { getLatestRun, getRunFilePath, fireHeartbeat } from "./codex-run-metadata.mjs";
import { reconcileRepoLocks, releaseLockForTask } from "./repo-lock.mjs";
import { parseResultJson, buildTaskResult, validateAutonomyResult } from "./codex-result-parser.mjs";
import { updateGoalStatus } from "./task-lifecycle.mjs";

export function createReconciler({ store, config, github, notifyTerminalTaskIfNeeded }) {
  return {
    async reconcileStaleTasks(context = defaultTokenContext("worker")) {
      try {
        const state = await store.load();
        const now = Date.now();
        const _lp = process.env.GPTWORK_LOG_PATH;
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

        // Phase B: Reconcile stale repo locks
        try {
          const _lockRec = await reconcileRepoLocks(config.defaultWorkspaceRoot);
          if (_lockRec.reconciled > 0) {
            if (_lp) appendFileSync(_lp, `[gptwork-worker] repo lock reconciliation: ${_lockRec.reconciled} stale lock(s) marked stale\n`);
            for (const _d of _lockRec.details) {
              if (_lp) appendFileSync(_lp, `[gptwork-worker]   lock ${_d.safe_repo_id} (task ${_d.task_id}): ${_d.reason}\n`);
            }
          }
        } catch (_lockRecErr) {
          if (_lp) appendFileSync(_lp, `[gptwork-worker] repo lock reconciliation error: ${_lockRecErr.message}\n`);
        }

        // Phase C: Scan pending restart markers and verify after service startup
        const restartVerifications = [];
        try {
          try {
            const _misplacedRepoPaths = [config.defaultRepoPath].filter(Boolean);
            if (_misplacedRepoPaths.length > 0) {
              const _misplaced = scanMisplacedMarkersSync(_misplacedRepoPaths);
              for (const _mp of _misplaced) {
                const _canonicalMarker = await loadRestartMarker(config.defaultWorkspaceRoot, _mp.taskId);
                if (!_canonicalMarker) {
                  const _migrateResult = await migrateMisplacedMarker(config.defaultWorkspaceRoot, _mp.repoPath, _mp.taskId);
                  if (_migrateResult.migrated) {
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: migrated misplaced restart marker for task ${_mp.taskId} from ${_mp.repoPath}/.gptwork/pending-restarts to canonical path\n`);
                  } else {
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: ${_migrateResult.diagnostic}\n`);
                  }
                } else {
                  await removeMisplacedMarker(_mp.repoPath, _mp.taskId);
                  if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: removed duplicate misplaced restart marker for task ${_mp.taskId}\n`);
                }
              }
            }
          } catch (_misplacedErr) {
            if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C misplaced marker scan error: ${_misplacedErr.message}\n`);
          }
          const markers = await scanPendingRestartMarkers(config.defaultWorkspaceRoot);
          for (const marker of markers) {
            if (marker.status === "scheduled" || marker.status === "restarted") {
              const { verified, diagnostics } = await verifyRestartMarker(marker, {
                defaultRepoPath: config.defaultRepoPath,
                defaultRemote: config.defaultRemote,
                defaultBranch: config.defaultBranch,
              });
              if (verified) {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "verified", {
                  verified_at: new Date().toISOString(),
                  running_commit: diagnostics.running_commit,
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  const goalId = taskObj.goal_id;
                  let resultJsonPath = null;
                  if (goalId) resultJsonPath = join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "result.json");
                  let resultData = null;
                  if (resultJsonPath) { try { resultData = await parseResultJson(resultJsonPath); } catch {} }
                  if (resultData && resultData.status === "completed") {
                    let autonomyValidation = { valid: true };
                    if (goalId) {
                      try {
                        const contextJsonPath = join(config.defaultWorkspaceRoot, ".gptwork/goals", goalId, "context.json");
                        if (existsSync(contextJsonPath)) {
                          const contextData = JSON.parse(readFileSync(contextJsonPath, "utf8"));
                          const goal = contextData.goal || null;
                          autonomyValidation = validateAutonomyResult(resultData, goal);
                        }
                      } catch {}
                    }
                    if (autonomyValidation.valid) {
                      taskObj.status = "completed";
                      taskObj.result = taskObj.result || {};
                      taskObj.result.kind = "codex_executed";
                      taskObj.result.summary = resultData.summary || "Restart verified: deployment successful";
                      taskObj.result.restart_state = "verified";
                      taskObj.result.restart_verified_at = new Date().toISOString();
                      taskObj.result.tests = resultData.tests;
                      taskObj.result.commit = resultData.commit;
                      taskObj.result.remote_head = resultData.remote_head;
                      taskObj.result.changed_files = resultData.changed_files;
                      taskObj.result.warnings = resultData.warnings;
                      taskObj.logs = taskObj.logs || [];
                      taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Restart verified and task finalized via Phase C startup verification. Running commit: ${diagnostics.running_commit || "unknown"}` });
                      await notifyTerminalTaskIfNeeded(taskObj);
                      taskObj.updated_at = new Date().toISOString();
                      try { await github.syncTask(taskObj); } catch {}
                      restartVerifications.push({ task_id: marker.task_id, status: "completed", verified: true });
                      await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                      if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} completed after restart verification\n`);
                    } else {
                      taskObj.status = "waiting_for_review";
                      taskObj.result = taskObj.result || {};
                      taskObj.result.kind = "codex_executed";
                      taskObj.result.summary = resultData.summary || "Autonomy validation failed after restart";
                      taskObj.result.warnings = taskObj.result.warnings || [];
                      taskObj.result.warnings.push("Autonomy policy validation failed after restart: " + autonomyValidation.reason);
                      taskObj.result.restart_state = "verified";
                      taskObj.result.restart_verified_at = new Date().toISOString();
                      taskObj.result.commit = resultData.commit;
                      taskObj.result.remote_head = resultData.remote_head;
                      taskObj.logs = taskObj.logs || [];
                      taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Autonomy validation failed after restart: " + autonomyValidation.reason });
                      await notifyTerminalTaskIfNeeded(taskObj);
                      taskObj.updated_at = new Date().toISOString();
                      restartVerifications.push({ task_id: marker.task_id, status: "waiting_for_review", verified: true });
                      await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                      if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} autonomy validation failed after restart: ${autonomyValidation.reason}\n`);
                    }
                  } else {
                    taskObj.result = taskObj.result || {};
                    taskObj.result.restart_state = "verified";
                    taskObj.result.restart_comment = "Restart marker verified but no result.json found";
                    taskObj.logs = taskObj.logs || [];
                    taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Restart marker verified via Phase C startup verification (no result.json)" });
                    taskObj.updated_at = new Date().toISOString();
                    restartVerifications.push({ task_id: marker.task_id, status: "marker_verified", verified: true });
                    await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: marker ${marker.task_id} verified\n`);
                  }
                }
              } else {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "failed", {
                  failed_at: new Date().toISOString(),
                  failure_reason: (diagnostics.failures || []).join("; ") || diagnostics.error || "unknown",
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.status = "waiting_for_review";
                  taskObj.result = taskObj.result || {};
                  taskObj.result.kind = "restart_failed";
                  taskObj.result.restart_state = "failed";
                  taskObj.result.restart_failure = diagnostics.failures || diagnostics.error || "verification failed";
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: "[safe-restart] Restart verification failed: " + (((diagnostics.failures || []).join("; ")) || diagnostics.error || "unknown") });
                  await notifyTerminalTaskIfNeeded(taskObj);
                  taskObj.updated_at = new Date().toISOString();
                    await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                  restartVerifications.push({ task_id: marker.task_id, status: "failed", verified: false });
                  if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} restart verification failed\n`);
                }
              }
            } else if (marker.status === "pending") {
              const { verified, diagnostics } = await verifyRestartMarker(marker, {
                defaultRepoPath: config.defaultRepoPath,
                defaultRemote: config.defaultRemote,
                defaultBranch: config.defaultBranch,
              });
              if (verified) {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "verified", {
                  verified_at: new Date().toISOString(),
                  running_commit: diagnostics.running_commit,
                  pre_verified_pending: true,
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Pending restart marker pre-verified: expected_commit ${marker.expected_commit} matches running commit ${diagnostics.running_commit || "unknown"}` });
                  taskObj.updated_at = new Date().toISOString();
                }
                await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                restartVerifications.push({ task_id: marker.task_id, status: "verified", verified: true, pre_verified_pending: true });
                if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: pending marker ${marker.task_id} pre-verified (expected_commit matches running commit)\n`);
              } else {
                await updateRestartMarkerStatus(config.defaultWorkspaceRoot, marker.task_id, "failed", {
                  failed_at: new Date().toISOString(),
                  failure_reason: (diagnostics.failures || []).join("; ") || diagnostics.error || "expected_commit_mismatch",
                });
                const taskObj = (state.tasks || []).find(function(t) { return t.id === marker.task_id; });
                if (taskObj) {
                  taskObj.logs = taskObj.logs || [];
                  taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Pending restart marker verification failed: expected_commit ${marker.expected_commit} mismatch ${diagnostics.running_commit ? `(running: ${diagnostics.running_commit})` : ""}` });
                  taskObj.updated_at = new Date().toISOString();
                }
                await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
                restartVerifications.push({ task_id: marker.task_id, status: "failed", verified: false, pre_verified_pending: false });
                if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: pending marker ${marker.task_id} verification failed (expected_commit mismatch)\n`);
              }
            }
          }
          if (markers.length > 0 || restartVerifications.length > 0) await store.save();
        } catch (phaseErr) {
          if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C error: ${phaseErr.message}\n`);
        }
        await store.save();
        return { ok: true, reconciled: reconciled.length, details: reconciled, restart_verifications: restartVerifications };
      } catch (error) {
        const _lp = process.env.GPTWORK_LOG_PATH;
        if (_lp) appendFileSync(_lp, `[gptwork-worker] reconciliation error: ${error.message}\n`);
        return { ok: false, error: error.message };
      }
    },
  };
}
