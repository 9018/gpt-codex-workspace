import { rm } from "node:fs/promises";
import { selectWorkspace } from "./auth-context.mjs";
import { goalWorkspaceFiles } from "./goal-files.mjs";
import { acquireRepoLock, releaseLockForTask } from "./repo-lock.mjs";
import { buildTaskResult } from "./codex-result-parser.mjs";
import { prepareCodexTaskRun } from "./task-run-setup.mjs";
import { executeCodexTaskRun } from "./task-codex-execution.mjs";
import { finalizeCodexTaskRun } from "./task-final-writeback.mjs";
import { applyAutonomyValidation, applyRuntimeCodeChangeGuard, deriveTaskStatusFromTaskResult, isP0TaskTitle, validateResultContract, DIAGNOSIS_CODES } from "./task-result-status.mjs";
import { updateTask } from "./task-lifecycle.mjs";
import { appendGoalMessage, ensureTaskGoal } from "./goal-task-lifecycle.mjs";
import { resolveTaskRepository } from "./task-repo-resolution.mjs";
import { buildReviewerDecision } from "./acceptance-policy.mjs";

export async function processGeneralTask(store, config, task, context, github) {
  const now = new Date().toISOString();
  await updateTask(store, task.id, (item) => {
    delete item.lock_blocked_at;
    delete item.lock_blocked_by;
    item.logs.push({ time: now, message: `[worker] started: ${task.title}` });
  });

  // Ensure goal early so we can append transcript messages for non-hosted workspaces
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: true });
  const goal = linked.goal;
  const workspaceFiles = linked.workspace_files || (goal ? goalWorkspaceFiles(goal) : { dir: '.gptwork/goals/unknown' });

  const workspace = await selectWorkspace(store, task.workspace_id, context);
  if (workspace.type !== "hosted") {
    const msg = `[worker] paused: unsupported workspace type "${workspace.type}" — moving to waiting_for_review. This workspace type does not support builder/deploy/admin execution.`;
    await updateTask(store, task.id, (item) => {
      item.status = "waiting_for_review";
      item.logs.push({ time: new Date().toISOString(), message: msg });
    });
    if (goal) {
      await appendGoalMessage(store, config, {
        goal_id: goal.id,
        role: "codex",
        content: msg
      }, context);
    }
    return { task_id: task.id, status: "waiting_for_review", skipped: true, transitioned: true, progressed: true, reason: `unsupported workspace type: ${workspace.type}` };
  }

  if (goal) {
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Starting Codex execution for task ${task.id}. Reading ${workspaceFiles.goal_md}.`
    }, context);
  }
  const resolvedRepo = await resolveTaskRepository({ task, goal, config, registry: config.registry || null });
  const repoLockPath = resolvedRepo.lock_repo_path || config.defaultRepoPath;
  const executionCwd = resolvedRepo.worktree_lifecycle?.ok === true
    ? resolvedRepo.task_worktree_path
    : workspace.root;
  if (resolvedRepo.worktree_lifecycle?.ok === false) {
    const failMsg = `[worker] failed to prepare task worktree: ${resolvedRepo.worktree_lifecycle.error || "unknown worktree error"}`;
    await updateTask(store, task.id, (item) => {
      item.status = "failed";
      item.result = { kind: "worktree_error", summary: failMsg, completed_at: new Date().toISOString() };
      item.logs.push({ time: new Date().toISOString(), message: failMsg });
    });
    return { task_id: task.id, status: "failed", kind: "worktree_error", reason: failMsg };
  }
  if (repoLockPath) {
    const lockResult = await acquireRepoLock(config.defaultWorkspaceRoot, repoLockPath, {
      taskId: task.id,
      runId: null,
      mode: task.mode || "builder"
    });
    if (!lockResult.acquired) {
      const lockMsg = "[worker] repo locked by task " + lockResult.heldByTask + ", retry after completion. Skipping.";
      await updateTask(store, task.id, (item) => {
        item.status = "waiting_for_lock";
        item.lock_blocked_at = new Date().toISOString();
        item.lock_blocked_by = lockResult.heldByTask;
        item.logs.push({ time: new Date().toISOString(), message: lockMsg });
      });
      if (goal) {
        await appendGoalMessage(store, config, {
          goal_id: goal.id,
          role: "codex",
          content: lockMsg
        }, context);
      }
      return { task_id: task.id, status: "waiting_for_lock", skipped: true, reason: lockMsg };
    }
  }
  await updateTask(store, task.id, (item) => {
    item.status = "running";
    item.logs.push({ time: new Date().toISOString(), message: "[worker] codex exec started" });
  });

  // ---------------------------------------------------------------------------
  // Prepare prompt file — this may fail with ENOSPC or other operational errors
  // ---------------------------------------------------------------------------
  let promptFile = null;
  let runFilePath = null;
  let runId = null;
  try {
    const prepResult = await prepareCodexTaskRun({
      task,
      goal,
      workspaceFiles,
      workspaceRoot: workspace.root,
      config,
      repoLockPath,
    });
    promptFile = prepResult.promptFile;
    runFilePath = prepResult.runFilePath;
    runId = prepResult.runId;
  } catch (prepErr) {
    // If prepareCodexTaskRun fails (e.g. ENOSPC), release the lock and mark
    // the task as failed so it doesn't remain in "running" state with the lock held.
    const failMsg = `[worker] failed during prompt preparation: ${prepErr.message}`;
    if (repoLockPath) {
      try { await releaseLockForTask(config.defaultWorkspaceRoot, task.id); } catch {}
    }
    await updateTask(store, task.id, (item) => {
      item.status = "failed";
      item.result = {
        kind: "operational_error",
        summary: failMsg,
        completed_at: new Date().toISOString(),
        error_code: prepErr.code || null,
      };
      item.logs.push({ time: new Date().toISOString(), message: failMsg });
    });
    if (goal) {
      try {
        await appendGoalMessage(store, config, {
          goal_id: goal.id,
          role: "codex",
          content: failMsg,
        }, context);
      } catch {}
    }
    return { task_id: task.id, status: "failed", kind: "operational_error", reason: failMsg };
  }

  const mode = task.mode || "builder";
  let summary = "";
  let parsedResult = null;
  let cr = null;

  try {
    ({ cr, parsedResult, summary } = await executeCodexTaskRun({
      config,
      workspaceRoot: workspace.root,
      task,
      goal,
      promptFile,
      runFilePath,
      runId,
      repoLockPath,
      executionCwd,
    }));
  } catch (e) {
    summary = "[ERROR] " + e.message;
  } finally {
    try { await rm(promptFile, { force: true }); } catch {}
  }
  if (!summary) summary = "Task completed (no output captured)";

  const timedOut = cr?.timed_out || false;
  if (parsedResult && parsedResult.structured && parsedResult.status === "completed" && cr && cr.returncode !== 0) {
    parsedResult.status = "failed";
  }
  const taskResult = parsedResult
    ? buildTaskResult(parsedResult, { timedOut, timeoutSeconds: config.codexExecTimeout, returnCode: cr?.returncode ?? 0, cr })
    : {
        kind: cr?.no_first_output_timeout ? "no_first_output_timeout" : timedOut ? "codex_timeout" : "codex_failed",
        summary: cr?.no_first_output_timeout ? "Codex produced no stdout/stderr before the first-output timeout." : summary,
        completed_at: new Date().toISOString(),
        stdout_bytes: cr?.stdout_bytes ?? 0,
        stderr_bytes: cr?.stderr_bytes ?? 0,
        first_stdout_at: cr?.first_stdout_at || null,
        first_stderr_at: cr?.first_stderr_at || null,
        first_output_delay_ms: cr?.first_output_delay_ms ?? null,
        no_first_output_timeout: cr?.no_first_output_timeout || false,
        ...(timedOut ? { timed_out: true, timeout_seconds: cr?.no_first_output_timeout ? cr?.first_output_timeout_seconds : config.codexExecTimeout } : { timed_out: false })
      };

  taskResult.repo_resolution = {
    repo_id: resolvedRepo.repo_id,
    canonical_repo_path: resolvedRepo.canonical_repo_path,
    lock_repo_path: resolvedRepo.lock_repo_path,
    task_worktree_path: resolvedRepo.task_worktree_path,
    uses_default_fallback: resolvedRepo.uses_default_fallback,
    worktree_lifecycle: resolvedRepo.worktree_lifecycle,
  };

  const doneAt = new Date().toISOString();
  let taskStatus = deriveTaskStatusFromTaskResult(taskResult);
  taskStatus = applyAutonomyValidation(taskStatus, taskResult, goal, parsedResult);
  taskStatus = await applyRuntimeCodeChangeGuard({
    taskStatus,
    taskResult,
    mode,
    parsedResult,
    workspaceRoot: config.defaultWorkspaceRoot,
    taskId: task.id,
    isP0Task: isP0TaskTitle(task.title),
  });

  // P0: result contract validation — escalate to review on contract violation
  const acceptanceFindings = Array.isArray(parsedResult?.acceptance_findings) ? [...parsedResult.acceptance_findings] : [];
  if (taskStatus === "completed" && parsedResult) {
    const contractValidation = validateResultContract(parsedResult, { repoPath: resolvedRepo.canonical_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot });
    if (!contractValidation.valid) {
      taskStatus = "waiting_for_review";
      const diagnosisMsg = "Contract violation: " + contractValidation.diagnosis_codes.join(", ");
      taskResult.warnings = taskResult.warnings || [];
      taskResult.warnings.push(diagnosisMsg);
      for (const code of contractValidation.diagnosis_codes) {
        acceptanceFindings.push({ severity: "major", code, message: diagnosisMsg, source: "result_contract" });
      }
    }
  }

  if (resolvedRepo.worktree_lifecycle?.mode !== "git_worktree" || resolvedRepo.worktree_lifecycle?.ok !== true) {
    acceptanceFindings.push({
      severity: "followup",
      code: "git_worktree_lifecycle_metadata_only",
      message: "Task repo resolution records a future worktree path, but git worktree add/remove lifecycle is not enabled yet.",
      source: "worktree_reliability_policy",
    });
  }

  if (taskStatus === "failed" || taskStatus === "timed_out") {
    acceptanceFindings.push({
      severity: "blocker",
      code: `codex_${taskStatus}`,
      message: taskResult.summary || `Codex task ended with status ${taskStatus}`,
      source: "acceptance_agent",
    });
  }

  const reviewer = buildReviewerDecision({
    result: { status: taskStatus, summary: taskResult.summary },
    findings: acceptanceFindings,
    needs_gpt_review: taskStatus === "waiting_for_review",
    review_reason: taskStatus === "waiting_for_review" ? "result_contract_or_operational_guard" : null,
  });
  taskResult.reviewer_decision = parsedResult?.reviewer_decision || reviewer.decision;
  taskResult.acceptance_findings = acceptanceFindings;
  taskResult.next_tasks = Array.isArray(parsedResult?.next_tasks) && parsedResult.next_tasks.length > 0
    ? parsedResult.next_tasks
    : reviewer.next_tasks;
  if (reviewer.decision.repair_proposals.length > 0) {
    taskResult.repair_proposals = reviewer.decision.repair_proposals;
  }

  return finalizeCodexTaskRun({
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
    resolvedRepo,
    github,
    appendGoalMessageFn: appendGoalMessage,
  });
}
