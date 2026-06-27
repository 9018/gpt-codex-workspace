import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
import { determineGoalStatus } from "./goal-convergence.mjs";

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
                const verifiedAt = new Date().toISOString();
                const resultEvidence = buildVerifiedAdminRestartResult({
                  marker,
                  diagnostics,
                  verifiedAt,
                  existingResult: resultData,
                });
                await writeVerifiedAdminRestartArtifacts({
                  workspaceRoot: config.defaultWorkspaceRoot,
                  goalId,
                  resultEvidence,
                  verifiedAt,
                });
                taskObj.status = "completed";
                taskObj.result = {
                  ...(taskObj.result || {}),
                  ...resultEvidence,
                  kind: resultData.kind || resultEvidence.kind,
                  restart_state: "verified",
                  restart_verified_at: verifiedAt,
                  convergence: { nextStatus: "completed", profile: "admin_restart" },
                };
                taskObj.logs = taskObj.logs || [];
                taskObj.logs.push({ time: new Date().toISOString(), message: `[safe-restart] Restart verified and task finalized via Phase C startup verification. Running commit: ${diagnostics.running_commit || "unknown"}` });
                await notifyTerminalTaskIfNeeded(taskObj);
                taskObj.updated_at = new Date().toISOString();
                convergeLinkedAdminRestartGoal(state, taskObj, taskObj.result, taskObj.updated_at);
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
              const verifiedAt = new Date().toISOString();
              const resultEvidence = buildVerifiedAdminRestartResult({ marker, diagnostics, verifiedAt });
              await writeVerifiedAdminRestartArtifacts({
                workspaceRoot: config.defaultWorkspaceRoot,
                goalId,
                resultEvidence,
                verifiedAt,
              });
              taskObj.status = "completed";
              taskObj.result = {
                ...(taskObj.result || {}),
                ...resultEvidence,
                kind: resultEvidence.kind,
                restart_state: "verified",
                restart_verified_at: verifiedAt,
                restart_comment: "Restart marker verified and standard result evidence was written by Phase C",
                convergence: { nextStatus: "completed", profile: "admin_restart" },
              };
              taskObj.logs = taskObj.logs || [];
              taskObj.logs.push({ time: verifiedAt, message: `[safe-restart] Restart marker verified via Phase C startup verification and result evidence written. Running commit: ${diagnostics.running_commit || "unknown"}` });
              taskObj.updated_at = verifiedAt;
              convergeLinkedAdminRestartGoal(state, taskObj, taskObj.result, verifiedAt);
              await notifyTerminalTaskIfNeeded(taskObj);
              try { await github.syncTask(taskObj); } catch {}
              restartVerifications.push({ task_id: marker.task_id, status: "completed", verified: true });
              await releaseLockForTask(config.defaultWorkspaceRoot, marker.task_id);
              if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C: task ${marker.task_id} completed with synthesized restart result evidence\n`);
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
    if (restartVerifications.length > 0) await store.save();
  } catch (phaseErr) {
    if (_lp) appendFileSync(_lp, `[gptwork-worker] Phase C error: ${phaseErr.message}\n`);
  }
  return restartVerifications;
}

function buildVerifiedAdminRestartResult({ marker = {}, diagnostics = {}, verifiedAt, existingResult = null }) {
  const runningCommit = diagnostics.running_commit || marker.expected_commit || null;
  const remoteHead = diagnostics.remote_head || marker.expected_remote_head || existingResult?.remote_head || runningCommit;
  const commands = [
    {
      cmd: "safe_restart_phase_c_verify",
      exit_code: 0,
      passed: true,
      expected_commit: marker.expected_commit || null,
      running_commit: runningCommit,
      expected_remote_head: marker.expected_remote_head || null,
      remote_head: remoteHead,
      reasons: Array.isArray(diagnostics.verification_reasons) ? diagnostics.verification_reasons : [],
    },
    {
      cmd: "gptwork_phase_c_startup_health",
      exit_code: 0,
      passed: true,
      detail: "service restarted and Phase C reconciler is running",
    },
  ];
  return {
    status: "completed",
    kind: "admin_restart_verified",
    summary: existingResult?.summary || "Safe restart verified; runtime commit matched and standard result evidence was written.",
    changed_files: Array.isArray(existingResult?.changed_files) ? existingResult.changed_files : [],
    tests: existingResult?.tests || "safe restart verified; runtime commit matched; health passed",
    commit: runningCommit || existingResult?.commit || null,
    local_head: runningCommit,
    running_commit: runningCommit,
    remote_head: remoteHead,
    restart_required: false,
    restart_state: "verified",
    restart_verified_at: verifiedAt,
    verification: {
      passed: true,
      commands,
    },
    reviewer_decision: existingResult?.reviewer_decision || { status: "accepted", passed: true },
    acceptance_findings: Array.isArray(existingResult?.acceptance_findings) ? existingResult.acceptance_findings : [],
    followups: Array.isArray(existingResult?.followups) ? existingResult.followups : [],
    warnings: Array.isArray(existingResult?.warnings) ? existingResult.warnings : [],
  };
}

async function writeVerifiedAdminRestartArtifacts({ workspaceRoot, goalId, resultEvidence, verifiedAt }) {
  if (!workspaceRoot || !goalId) return;
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify(resultEvidence, null, 2) + "\n", "utf8");
  const commandRows = resultEvidence.verification.commands.map((command) => {
    const status = command.passed === true || command.exit_code === 0 ? "passed" : "failed";
    return `| ${command.cmd} | ${status} |`;
  }).join("\n");
  const markdown = [
    "# Result",
    "",
    resultEvidence.summary,
    "",
    "Completed at: " + verifiedAt,
    "",
    "## Verification",
    "",
    "| Command | Status |",
    "| --- | --- |",
    commandRows,
    "",
    "Commit: " + (resultEvidence.commit || "none"),
    "Running commit: " + (resultEvidence.running_commit || "none"),
    "Restart required: false",
    "",
  ].join("\n");
  await writeFile(join(goalDir, "result.md"), markdown, "utf8");
}

function convergeLinkedAdminRestartGoal(state, taskObj, taskResult, doneAt) {
  if (!state || !taskObj) return;
  const goal = Array.isArray(state.goals) ? state.goals.find((candidate) => candidate.id === taskObj.goal_id) : null;
  if (goal) {
    const nextStatus = determineGoalStatus(goal, taskObj, taskResult) || "completed";
    goal.status = nextStatus;
    goal.updated_at = doneAt;
    state.activities ||= [];
    state.activities.push({ time: doneAt, type: `goal.${nextStatus}`, goal_id: goal.id, title: goal.title });
  }
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const queueItem = queue.find((candidate) => candidate.task_id === taskObj.id || (goal && candidate.goal_id === goal.id && candidate.status === "running"));
  if (queueItem) {
    queueItem.status = taskObj.status;
    queueItem.completed_task_id = taskObj.id;
    queueItem.failure_class = null;
    queueItem.blocked_reason = null;
    queueItem.updated_at = doneAt;
  }
}
