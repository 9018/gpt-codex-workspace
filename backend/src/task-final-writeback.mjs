import { dirname, join } from "node:path";
import { mkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { fireHeartbeat } from "./codex-run-metadata.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { releaseRepoLock } from "./repo-lock.mjs";
import { removeTaskWorktree } from "./task-worktree-manager.mjs";
import { notifyTerminalTask, updateGoalStatus, updateTask } from "./task-lifecycle.mjs";
import { writeWorkspaceTextInternal } from "./workspace-service.mjs";
import { verifyTaskCompletion } from "./task-acceptance.mjs";
import { autoStartNextOnTaskCompleted } from "./goal-queue.mjs";
import { failureClassRequiresRepair } from "./task-retry.mjs";
import { sanitizeTaskBranchName } from "./task-worktree-manager.mjs";
import { runIntegrationQueue } from './integration-queue.mjs';
import { createRepairGoalFromFindings, shouldAttemptRepair } from './repair-loop.mjs';
import { createGoal } from './goal-task-goals.mjs';

function applyRepairMetadata(args = {}, repairGoal = {}) {
  for (const key of [
    "root_task_id",
    "parent_task_id",
    "repair_attempt",
    "max_attempts",
    "repair_of_goal_id",
    "repair_of_task_id",
    "repair_of_worktree",
    "repair_of_branch",
  ]) {
    if (repairGoal[key] !== undefined) args[key] = repairGoal[key];
  }
  return args;
}

function isIntegrationRepairableStatus(status) {
  return status === "conflict" || status === "check_failed" || status === "push_failed" || status === "pr_failed";
}

function taskWithRepairContext(task, resolvedRepo) {
  return {
    ...task,
    worktree_path: task.worktree_path || resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path || null,
    worktree: task.worktree || {
      path: resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path || null,
      branch: resolvedRepo?.worktree_lifecycle?.branch_name || resolvedRepo?.task_branch || null,
    },
    repo_id: task.repo_id || resolvedRepo?.repo_id || null,
    result: {
      ...(task.result || {}),
      repo_resolution: resolvedRepo || task.result?.repo_resolution || null,
      worktree_lifecycle: resolvedRepo?.worktree_lifecycle || task.result?.worktree_lifecycle || null,
    },
  };
}


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
  resultJsonPath,
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
  verifyTaskCompletionFn = verifyTaskCompletion,
  autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted,
  runIntegrationQueueFn = runIntegrationQueue,
  shouldAttemptRepairFn = shouldAttemptRepair,
  createRepairGoalFromFindingsFn = createRepairGoalFromFindings,
  createGoalFn = createGoal,
}) {
  if (runFilePath) {
    const _resolvedRjPath = resultJsonPath || (workspace.root + "/.gptwork/goals/" + (goal ? goal.id : task.id) + "/result.json");
    fireHeartbeatFn(runFilePath, taskStatus === "completed" ? "completed" : "failed", {
      result_json_path: _resolvedRjPath,
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

  // Integration queue: if task is waiting_for_integration, attempt serial integration
  if (taskStatus === "waiting_for_integration") {
    try {
      const gitPath = (resolvedRepo && resolvedRepo.task_worktree_path) || (resolvedRepo && resolvedRepo.canonical_repo_path) || null;
      if (gitPath && resolvedRepo && resolvedRepo.repo_id) {
        const integrationResult = await runIntegrationQueueFn({
          repoId: resolvedRepo.repo_id,
          targetBranch: config.defaultBranch || "main",
          worktreePath: gitPath,
          canonicalRepoPath: (resolvedRepo && resolvedRepo.canonical_repo_path) || null,
          taskBranch: (resolvedRepo && resolvedRepo.worktree_lifecycle && resolvedRepo.worktree_lifecycle.branch_name) || sanitizeTaskBranchName(task.id),
          integrationMode: config.integrationMode || "push_branch",
          checkCommands: config.integrationCheckCommands,
          locksBasePath: config.defaultWorkspaceRoot,
          taskId: task.id,
        });

        if (integrationResult.ok) {
          taskStatus = "completed";
          taskResult.integration = { status: "completed", ...integrationResult };
        } else if (isIntegrationRepairableStatus(integrationResult.status)) {
          // Integration failed — create repair or escalate
          const intCanRepair = shouldAttemptRepairFn({ task, tasks: store.state?.tasks || [], maxAttempts: config.maxRepairAttempts || task.max_attempts || 2 });
          if (intCanRepair.should_repair) {
            const intRepairGoal = createRepairGoalFromFindingsFn({
              task: taskWithRepairContext(task, resolvedRepo),
              goal,
              findings: [{ severity: "blocker", code: "integration_" + integrationResult.status, message: integrationResult.error || "Integration " + integrationResult.status, source: "integration_queue" }],
              repairProposals: [{ title: "Resolve integration failure", proposed_action: "Fix integration " + integrationResult.status + " and rerun integration." }],
            });
            taskStatus = "waiting_for_repair";
            taskResult.repair_goal = intRepairGoal;
            taskResult.repair_attempt = intRepairGoal.repair_attempt;
            taskResult.integration = { status: integrationResult.status, error: integrationResult.error, conflict_files: integrationResult.conflict_files };
            // Attempt to create repair goal
            try {
              const created = await createGoalFn(store, config, applyRepairMetadata({
                user_request: intRepairGoal.user_request,
                goal_prompt: intRepairGoal.goal_prompt,
                title: "Repair: " + task.title + " (integration conflict)",
                project_id: task.project_id || (goal ? goal.project_id : "default"),
                workspace_id: intRepairGoal.workspace_id || task.workspace_id || (goal ? goal.workspace_id : "hosted-default"),
                mode: intRepairGoal.mode || "builder",
                assign_to_codex: true,
                skip_created_notification: false,
              }, intRepairGoal));
              taskResult.repair_goal_id = created.goal?.id || null;
              taskResult.repair_task_id = created.task?.id || null;
            } catch {}
          } else {
            taskStatus = "waiting_for_review";
            taskResult.repair_denied_reason = intCanRepair.reason;
            taskResult.integration = { status: integrationResult.status, error: integrationResult.error, conflict_files: integrationResult.conflict_files };
          }
        } else {
          taskResult.integration = { status: integrationResult.status, error: integrationResult.error };
        }
      }
    } catch (integrationErr) {
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push("Integration queue execution failed: " + integrationErr.message);
    }
  }

  const verifierRepoPath = taskResult?.execution_cwd
    || resolvedRepo?.task_worktree_path
    || resolvedRepo?.canonical_repo_path
    || workspace?.root
    || config.defaultRepoPath
    || config.defaultWorkspaceRoot;

  if (taskStatus === "completed") {
    const resultJsonForVerification = buildFallbackResultJson({ taskStatus, taskResult, summary });
    let verification = null;
    try {
      verification = await verifyTaskCompletionFn({
        task,
        goal,
        repoPath: verifierRepoPath,
        resultJson: resultJsonForVerification,
        resultJsonPath,
        config,
      });
    } catch (err) {
      verification = {
        passed: false,
        status: "waiting_for_review",
        commands: [],
        changed_files: [],
        reason_no_tests: null,
        failure_class: "verifier_error",
        requires_review: true,
        findings: [{ severity: "blocker", code: "verifier_error", message: err?.message || String(err), source: "task_final_writeback" }],
      };
    }

    taskResult.verification = verification;
    taskResult.acceptance_findings = Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [];
    for (const finding of verification.findings || []) {
      const duplicate = taskResult.acceptance_findings.some((existing) => existing.code === finding.code && existing.message === finding.message);
      if (!duplicate) taskResult.acceptance_findings.push(finding);
    }
    taskResult.failure_class = verification.failure_class || taskResult.failure_class || null;

    if (resultJsonPath) {
      const verificationPath = join(dirname(resultJsonPath), "verification.json");
      await mkdir(dirname(verificationPath), { recursive: true }).catch(() => {});
      await writeFileFn(verificationPath, JSON.stringify(verification, null, 2) + "\n", "utf8").catch(() => {});
    }
    if (verification.passed !== true) {
      const repairDecision = shouldAttemptRepairFn({ task, tasks: store.state?.tasks || [], maxAttempts: config.maxRepairAttempts || task.max_attempts || 2 });
      if (repairDecision.should_repair && failureClassRequiresRepairCompat(verification.failure_class)) {
        const repairGoal = createRepairGoalFromFindingsFn({
          task: taskWithRepairContext(task, resolvedRepo),
          goal,
          findings: verification.findings || [],
          repairProposals: [{ title: `Repair ${verification.failure_class || "verification"}`, proposed_action: "Fix verification failure and rerun verifier." }],
        });
        taskStatus = "waiting_for_repair";
        taskResult.repair_goal = repairGoal;
        taskResult.repair_attempt = repairGoal.repair_attempt;
        taskResult.reason = `verification_failed: ${repairDecision.reason}`;
        try {
          const created = await createGoalFn(store, config, applyRepairMetadata({
            user_request: repairGoal.user_request,
            goal_prompt: repairGoal.goal_prompt,
            title: `Repair: ${task.title || task.id} (attempt ${repairGoal.repair_attempt})`,
            project_id: task.project_id || goal?.project_id || "default",
            workspace_id: repairGoal.workspace_id || task.workspace_id || goal?.workspace_id || "hosted-default",
            mode: repairGoal.mode || "builder",
            assign_to_codex: true,
            skip_created_notification: false,
          }, repairGoal));
          taskResult.repair_goal_id = created.goal?.id || null;
          taskResult.repair_task_id = created.task?.id || null;
        } catch (err) {
          taskStatus = "waiting_for_review";
          taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
          taskResult.warnings.push("Repair goal creation failed: " + (err?.message || String(err)));
        }
      } else {
        taskStatus = "waiting_for_review";
        taskResult.repair_denied_reason = repairDecision.reason;
      }
      taskResult.kind = taskResult.kind || "verification_failed";
      taskResult.requires_review = true;
      taskResult.summary = taskResult.summary || summary || "Task requires review after verification failed.";
    }
  }

  // Cleanup policy: remove_on_success_retain_on_failure.
  // Only remove worktree when task completed successfully.
  // For failed/timed_out/waiting_for_review/waiting_for_repair/waiting_for_integration,
  // retain the worktree to allow debugging, review, or repair.
  let cleanup = null;
  if (taskStatus === "completed") {
    cleanup = await cleanupTaskWorktree({
      task,
      config,
      resolvedRepo,
      removeTaskWorktreeFn,
    });
  } else {
    // Retain worktree for non-completed / non-terminal states
    if (resolvedRepo?.worktree_lifecycle?.mode === "git_worktree" && resolvedRepo?.task_worktree_path) {
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push("Worktree retained: " + resolvedRepo.task_worktree_path + " (status=" + taskStatus + ")");
    }
  }
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
      taskResult.warnings.push("Task worktree cleanup failed: " + (cleanup.error || "unknown error"));
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
      "waiting_for_integration": "Waiting for integration",
      "waiting_for_repair": "Waiting for repair",
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
    const _rjPath = resultJsonPath || (workspace.root + "/.gptwork/goals/" + goal.id + "/result.json");
    try {
      const _rjData = buildFallbackResultJson({ taskStatus, taskResult, summary });
      await writeFileFn(_rjPath, JSON.stringify(_rjData, null, 2) + "\n", "utf8");
    } catch {}
  }

  let autoStartResult = null;
  if (taskStatus === "completed") {
    try {
      autoStartResult = await autoStartNextOnTaskCompletedFn(store, config, result.task);
    } catch (err) {
      autoStartResult = { auto_started: false, error: err?.message || String(err), details: [] };
    }
  }

  try { await github.syncTask(result.task); } catch {}
  return { task_id: result.task.id, status: taskStatus, kind: taskResult.kind, auto_start: autoStartResult };
}

function buildFallbackResultJson({ taskStatus, taskResult = {}, summary = "" }) {
  return {
    status: taskStatus,
    summary: taskResult.summary || summary || "",
    changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
    tests: taskResult.tests || null,
    commit: taskResult.commit || null,
    remote_head: taskResult.remote_head || null,
    warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
    followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
    verification: taskResult.verification || null,
    failure_class: taskResult.failure_class || null,
    repo_resolution: taskResult.repo_resolution || null,
    worktree_lifecycle: taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null,
    worktree_lifecycle_proof: taskResult.worktree_lifecycle_proof || buildWorktreeLifecycleProof(taskResult),
    execution_cwd: taskResult.execution_cwd || null,
    execution_cwd_proof: taskResult.execution_cwd_proof || buildExecutionCwdProof(taskResult),
    queue_autostart_fix: taskResult.queue_autostart_fix || null,
    evidence_paths: taskResult.evidence_paths || null,
    reviewer_decision: taskResult.reviewer_decision || null,
    acceptance_findings: Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [],
    next_tasks: Array.isArray(taskResult.next_tasks) ? taskResult.next_tasks : [],
  };
}

function failureClassRequiresRepairCompat(failureClass) {
  return failureClassRequiresRepair(failureClass) || failureClass === "verification_failed" || failureClass === "unknown";
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
  item.execution_mode = deriveExecutionMode(taskResult, item);
  item.worktree = deriveSpecWorktreeRecord(taskResult, item.worktree);
  item.attempt = Number.isInteger(item.attempt) ? item.attempt : 0;
  item.max_attempts = Number.isInteger(item.max_attempts) ? item.max_attempts : 2;
  item.result = { ...taskResult, completed_at: doneAt };
  item.logs.push({ time: doneAt, message: taskResult.kind === "no_first_output_timeout"
    ? "[worker] timed out waiting for first Codex output after " + (cr?.first_output_timeout_seconds || config.codexFirstOutputTimeout || 180) + "s"
    : taskResult.kind === "codex_timeout"
      ? "[worker] timed out after " + config.codexExecTimeout + "s"
      : "[worker] completed: task processed by Codex CLI" });
  if (taskResult.failure_class || taskResult.repair_attempt !== undefined) {
    item.logs.push({
      time: doneAt,
      message: `[worker] failure_class=${taskResult.failure_class || "none"} attempt=${item.attempt} repair_of_attempt=${taskResult.repair_attempt ?? "none"}`,
    });
  }
}

function deriveExecutionMode(taskResult = {}, existingTask = {}) {
  if (taskResult.repo_resolution?.worktree_lifecycle?.mode === "git_worktree" || taskResult.worktree_lifecycle?.mode === "git_worktree") {
    return "worktree";
  }
  return existingTask.execution_mode || "canonical";
}

function deriveSpecWorktreeRecord(taskResult = {}, existingWorktree = null) {
  const lifecycle = taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null;
  const path = taskResult.repo_resolution?.task_worktree_path || lifecycle?.worktree_path || existingWorktree?.path || null;
  if (!lifecycle && !path && !existingWorktree) return undefined;
  const cleanupStatus = lifecycle?.cleanup
    ? lifecycle.cleanup.ok === true ? "removed" : "cleanup_failed"
    : null;
  const status = cleanupStatus
    || lifecycle?.status
    || (lifecycle?.ok === true ? (taskResult.status === "running" ? "running" : "completed") : "cleanup_failed");
  return {
    enabled: lifecycle?.mode === "git_worktree" || existingWorktree?.enabled === true,
    path,
    branch: lifecycle?.branch_name || existingWorktree?.branch || null,
    base_ref: lifecycle?.base_ref || existingWorktree?.base_ref || null,
    base_sha: lifecycle?.base_sha || existingWorktree?.base_sha || null,
    head_sha: lifecycle?.head_sha || existingWorktree?.head_sha || null,
    status,
  };
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

    if (Array.isArray(state.goal_queue)) {
      const queueItem = state.goal_queue.find((candidate) => candidate.task_id === task.id || (goal && candidate.goal_id === goal.id && candidate.status === "running"));
      if (queueItem) {
        queueItem.status = taskStatus;
        queueItem.failure_class = taskResult.failure_class || taskResult.verification?.failure_class || null;
        queueItem.completed_task_id = task.id;
        queueItem.updated_at = doneAt;
        if (taskStatus !== "completed") {
          queueItem.blocked_reason = taskResult.reason || taskResult.repair_denied_reason || taskResult.summary || null;
        } else {
          queueItem.blocked_reason = null;
        }
      }
    }
    return { task: item };
  });
}
