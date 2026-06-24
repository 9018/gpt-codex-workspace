import { writeFile as nodeWriteFile } from "node:fs/promises";
import { fireHeartbeat } from "./codex-run-metadata.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { releaseRepoLock } from "./repo-lock.mjs";
import { removeTaskWorktree } from "./task-worktree-manager.mjs";
import { notifyTerminalTask, updateGoalStatus, updateTask } from "./task-lifecycle.mjs";
import { writeWorkspaceTextInternal } from "./workspace-service.mjs";

const ACTIVE_RESTART_MARKER_STATUSES = new Set(["pending", "scheduled", "restarted"]);

export async function finalizeCodexTaskRun({
  store,
  config,
  task,
  taskStatus,
  taskResult,
  doneAt,
  cr,
  workspace,
  goal,
  workspaceFiles,
  summary,
  context,
  runFilePath,
  repoLockPath,
  resolvedRepo = null,
  github,
  appendGoalMessageFn,
  fireHeartbeatFn = fireHeartbeat,
  updateTaskFn = updateTask,
  loadRestartMarkerFn = loadRestartMarker,
  releaseRepoLockFn = releaseRepoLock,
  updateGoalStatusFn = updateGoalStatus,
  writeWorkspaceTextInternalFn = writeWorkspaceTextInternal,
  removeTaskWorktreeFn = removeTaskWorktree,
  writeFileFn = nodeWriteFile,
}) {
  if (runFilePath) {
    const resultJsonPath = workspace.root + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json";
    fireHeartbeatFn(runFilePath, taskStatus === "completed" ? "completed" : "failed", {
      result_json_path: resultJsonPath,
      exit_code: cr?.returncode ?? -1,
      timed_out: cr?.timed_out || false,
      no_first_output_timeout: cr?.no_first_output_timeout || false,
      first_output_timeout_seconds: cr?.first_output_timeout_seconds,
      stdout_bytes: cr?.stdout_bytes,
      stderr_bytes: cr?.stderr_bytes,
      first_stdout_at: cr?.first_stdout_at,
      first_stderr_at: cr?.first_stderr_at,
      first_output_delay_ms: cr?.first_output_delay_ms,
    });
  }

  const cleanup = await cleanupTaskWorktree({
    task,
    config,
    resolvedRepo,
    removeTaskWorktreeFn,
  });
  if (cleanup) {
    const updatedLifecycle = {
      ...(taskResult.worktree_lifecycle || resolvedRepo?.worktree_lifecycle || {}),
      cleanup_supported: true,
      cleanup,
    };
    taskResult.worktree_lifecycle = updatedLifecycle;
    if (taskResult.repo_resolution && typeof taskResult.repo_resolution === "object") {
      taskResult.repo_resolution = {
        ...taskResult.repo_resolution,
        worktree_lifecycle: updatedLifecycle,
      };
    }
    if (cleanup.ok === false) {
      taskStatus = "failed";
      taskResult.kind = taskResult.kind || "worktree_cleanup_failed";
      taskResult.summary = taskResult.summary || "Task worktree cleanup failed.";
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push(`Task worktree cleanup failed: ${cleanup.error || "unknown error"}`);
      taskResult.acceptance_findings = Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [];
      taskResult.acceptance_findings.push({
        severity: "blocker",
        code: "git_worktree_cleanup_failed",
        message: cleanup.error || "git worktree remove failed",
        source: "worktree_lifecycle",
      });
    }
  }

  const result = typeof store.mutate === "function"
    ? await mutateFinalTaskState({ store, task, taskStatus, taskResult, doneAt, cr, config, goal, notifyTerminalTaskFn: notifyTerminalTask })
    : await updateTaskFn(store, task.id, (item) => {
      applyTaskFinalState(item, { taskStatus, taskResult, doneAt, cr, config });
    });

  if (repoLockPath) {
    let keptForRestart = false;
    try {
      const marker = await loadRestartMarkerFn(config.defaultWorkspaceRoot, task.id);
      if (marker && ACTIVE_RESTART_MARKER_STATUSES.has(marker.status)) {
        await releaseRepoLockFn(config.defaultWorkspaceRoot, repoLockPath, task.id, {
          restartState: "scheduled",
        });
        keptForRestart = true;
      }
    } catch {}
    if (!keptForRestart) {
      await releaseRepoLockFn(config.defaultWorkspaceRoot, repoLockPath, task.id);
    }
  }

  if (goal) {
    const goalStatus = taskStatus === "timed_out" ? "failed" : taskStatus;
    if (typeof store.mutate !== "function") {
      await updateGoalStatusFn(store, goal.id, goalStatus, doneAt);
    }
    const statusLabels = {
      "completed": "Completed",
      "failed": "Failed",
      "timed_out": "Timed out",
      "waiting_for_review": "Waiting for review",
    };
    const statusLabel = statusLabels[taskStatus] || taskStatus;
    await writeWorkspaceTextInternalFn(store, config, goal.workspace_id, workspaceFiles.result_md,
      "# Result\n\n" + summary + "\n\n" + statusLabel + " at: " + doneAt + "\n", context);
    await appendGoalMessageFn(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: "[worker] " + statusLabel + " task " + task.id + ".\n\n" + summary,
      memory_key: "codex_last_result",
      memory_value: summary.slice(0, 4000),
    }, context);

    // Write fallback result.json so it always exists for subsequent parses.
    const _rjPath = workspace.root + "/.gptwork/goals/" + goal.id + "/result.json";
    try {
      const _rjData = {
        status: taskStatus,
        summary: taskResult.summary || summary || "",
        changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
        tests: taskResult.tests || null,
        commit: taskResult.commit || null,
        remote_head: taskResult.remote_head || null,
        warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
        followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
        repo_resolution: taskResult.repo_resolution || null,
        worktree_lifecycle: taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null,
        worktree_lifecycle_proof: taskResult.worktree_lifecycle_proof || buildWorktreeLifecycleProof(taskResult),
        execution_cwd: taskResult.execution_cwd || null,
        execution_cwd_proof: taskResult.execution_cwd_proof || buildExecutionCwdProof(taskResult),
        queue_autostart_fix: taskResult.queue_autostart_fix || null,
        reviewer_decision: taskResult.reviewer_decision || null,
        acceptance_findings: Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [],
        next_tasks: Array.isArray(taskResult.next_tasks) ? taskResult.next_tasks : [],
      };
      await writeFileFn(_rjPath, JSON.stringify(_rjData, null, 2) + "\n", "utf8");
    } catch {}
  }

  try { await github.syncTask(result.task); } catch {}
  return { task_id: result.task.id, status: taskStatus, kind: taskResult.kind };
}

function buildWorktreeLifecycleProof(taskResult = {}) {
  const lifecycle = taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null;
  if (!lifecycle) return null;
  return {
    mode: lifecycle.mode || null,
    ok: lifecycle.ok === true,
    git_worktree_created: lifecycle.git_worktree_created === true,
    existing: lifecycle.existing === true,
    cleanup_supported: lifecycle.cleanup_supported === true,
    cleanup_ok: lifecycle.cleanup ? lifecycle.cleanup.ok === true : null,
    task_worktree_path: taskResult.repo_resolution?.task_worktree_path || lifecycle.worktree_path || null,
    created_during_run: lifecycle.created_during_run === true || lifecycle.git_worktree_created === true,
  };
}

function buildExecutionCwdProof(taskResult = {}) {
  const cwd = taskResult.execution_cwd || taskResult.execution_cwd_proof?.cwd || null;
  const taskWorktreePath = taskResult.repo_resolution?.task_worktree_path || taskResult.execution_cwd_proof?.task_worktree_path || null;
  const canonicalRepoPath = taskResult.repo_resolution?.canonical_repo_path || taskResult.execution_cwd_proof?.canonical_repo_path || null;
  if (!cwd && !taskWorktreePath && !canonicalRepoPath) return null;
  return {
    cwd,
    task_worktree_path: taskWorktreePath,
    canonical_repo_path: canonicalRepoPath,
    used_task_worktree_path: Boolean(cwd && taskWorktreePath && cwd === taskWorktreePath),
  };
}

async function cleanupTaskWorktree({ task, config, resolvedRepo, removeTaskWorktreeFn }) {
  if (resolvedRepo?.worktree_lifecycle?.mode !== "git_worktree" || !resolvedRepo?.task_worktree_path) return null;
  try {
    return await removeTaskWorktreeFn(task.id, {
      workspaceRoot: config.defaultWorkspaceRoot,
      repoId: resolvedRepo.repo_id,
      canonicalRepoPath: resolvedRepo.canonical_repo_path,
      worktreePath: resolvedRepo.task_worktree_path,
    });
  } catch (error) {
    return {
      ok: false,
      removed: false,
      error: error?.message || String(error || "git worktree remove failed"),
      worktree_path: resolvedRepo.task_worktree_path,
    };
  }
}

function applyTaskFinalState(item, { taskStatus, taskResult, doneAt, cr, config }) {
  item.status = taskStatus;
  item.result = { ...taskResult, completed_at: doneAt };
  item.logs.push({ time: doneAt, message: taskResult.kind === "no_first_output_timeout"
    ? "[worker] timed out waiting for first Codex output after " + (cr?.first_output_timeout_seconds || config.codexFirstOutputTimeout || 180) + "s"
    : taskResult.kind === "codex_timeout"
      ? "[worker] timed out after " + config.codexExecTimeout + "s"
      : "[worker] completed: task processed by Codex CLI" });
}

async function mutateFinalTaskState({ store, task, taskStatus, taskResult, doneAt, cr, config, goal, notifyTerminalTaskFn }) {
  return store.mutate(async (state) => {
    state.tasks ||= [];
    state.goals ||= [];
    state.activities ||= [];
    const item = state.tasks.find((candidate) => candidate.id === task.id);
    if (!item) throw new Error(`task not found: ${task.id}`);
    applyTaskFinalState(item, { taskStatus, taskResult, doneAt, cr, config });
    item.updated_at = new Date().toISOString();
    state.activities.push({ time: item.updated_at, type: "task.updated", task_id: task.id, status: item.status });
    await notifyTerminalTaskFn(item);

    if (goal) {
      const goalItem = state.goals.find((candidate) => candidate.id === goal.id);
      if (goalItem) {
        const goalStatus = taskStatus === "timed_out" ? "failed" : taskStatus;
        goalItem.status = goalStatus;
        goalItem.updated_at = doneAt;
        state.activities.push({ time: doneAt, type: `goal.${goalStatus}`, goal_id: goalItem.id, title: goalItem.title });
      }
    }
    return { task: item };
  });
}
