import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadRestartMarker,
  scanPendingRestartMarkers,
  updateRestartMarkerStatus,
  verifyRestartMarker,
  scanMisplacedMarkersSync,
  migrateMisplacedMarker,
  removeMisplacedMarker,
} from "./safe-restart.mjs";
import { releaseLockForTask } from "./repo-lock.mjs";
import { parseResultJson, validateAutonomyResult } from "./codex-result-parser.mjs";

export async function reconcileRestartMarkers({ state, store, config, github, notifyTerminalTaskIfNeeded, logPath }) {
  // Phase C: Scan pending restart markers and verify after service startup
  const _lp = logPath;
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
  return restartVerifications;
}
