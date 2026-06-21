import { rm } from "node:fs/promises";
import { selectWorkspace } from "./auth-context.mjs";
import { goalWorkspaceFiles } from "./goal-files.mjs";
import { acquireRepoLock } from "./repo-lock.mjs";
import { buildTaskResult } from "./codex-result-parser.mjs";
import { prepareCodexTaskRun } from "./task-run-setup.mjs";
import { executeCodexTaskRun } from "./task-codex-execution.mjs";
import { finalizeCodexTaskRun } from "./task-final-writeback.mjs";
import { applyAutonomyValidation, applyRuntimeCodeChangeGuard, deriveTaskStatusFromTaskResult } from "./task-result-status.mjs";
import { updateTask } from "./task-lifecycle.mjs";
import { appendGoalMessage, ensureTaskGoal } from "./goal-task-lifecycle.mjs";

export async function processGeneralTask(store, config, task, context, github) {
  const now = new Date().toISOString();
  await updateTask(store, task.id, (item) => {
    delete item.lock_blocked_at;
    delete item.lock_blocked_by;
    item.logs.push({ time: now, message: `[worker] started: ${task.title}` });
  });

  const workspace = await selectWorkspace(store, task.workspace_id, context);
  if (workspace.type !== "hosted") {
    await updateTask(store, task.id, (item) => {
      item.logs.push({ time: new Date().toISOString(), message: `[worker] skipped: unsupported workspace type ${workspace.type}` });
    });
    return { task_id: task.id, status: task.status, skipped: true, reason: `unsupported workspace type: ${workspace.type}` };
  }
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: true });
  const goal = linked.goal;
  const workspaceFiles = linked.workspace_files || goalWorkspaceFiles(goal);
  if (goal) {
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Starting Codex execution for task ${task.id}. Reading ${workspaceFiles.goal_md}.`
    }, context);
  }
  const repoLockPath = config.defaultRepoPath;
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

  const mode = task.mode || "builder";
  let summary = "";
  let parsedResult = null;
  let cr = null;
  const { promptFile, runFilePath, runId } = await prepareCodexTaskRun({
    task,
    goal,
    workspaceFiles,
    workspaceRoot: workspace.root,
    config,
  });

  try {
    ({ cr, parsedResult, summary } = await executeCodexTaskRun({
      config,
      workspaceRoot: workspace.root,
      task,
      goal,
      promptFile,
      runFilePath,
      runId,
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
    ? buildTaskResult(parsedResult, { timedOut, timeoutSeconds: config.codexExecTimeout, returnCode: cr?.returncode ?? 0 })
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
  });

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
    github,
    appendGoalMessageFn: appendGoalMessage,
  });
}
