import { dirname, join } from "node:path";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { fireHeartbeat } from "./codex-run-metadata.mjs";
import { convergeStaleGoalStatuses } from "./goal-convergence.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { releaseRepoLock } from "./repo-lock.mjs";
import { removeTaskWorktree } from "./task-worktree-manager.mjs";
import { updateGoalStatus, updateTask } from "./task-lifecycle.mjs";
import { writeWorkspaceTextInternal } from "./workspace-service.mjs";
import { verifyTaskCompletion } from "./task-acceptance.mjs";
import { autoStartNextOnTaskCompleted } from "./goal-queue.mjs";
import { canRetryTask, classifyTaskFailure } from "./failure-classifier.mjs";
import { runIntegrationQueue } from './integration-queue.mjs';
import { createRepairGoalFromFindings, shouldAttemptRepair, handleRepairCompletion, scheduleRepairAttempt } from './repair-loop.mjs';
import { createGoal } from './goal-task-goals.mjs';
import { classifyClosure, checkNotificationConsistency } from './auto-closure-classifier.mjs';
import { runAutoIntegrationCompletion, autoIntegrationVerificationFromReport } from './auto-integration-completion.mjs';
import { applyClosureDecisionToTaskResult, decideTaskClosure } from './closure/task-closure-decider.mjs';
import { planFollowupTasks, planUnacceptedTaskFollowup } from './closure/followup-task-planner.mjs';
import { reconcileTaskClosure } from './closure/task-closure-reconciler.mjs';
import { continueOnCompletedOutcome, convergeGoalFromContinuation, goalStatusFromReconciliation } from './closure/continuation-flow.mjs';
import { runAcceptanceGate } from './acceptance-gate-engine.mjs';
import { applyTaskFinalStateDecision, decideTaskFinalization } from './task-finalization/task-final-state-decider.mjs';
import { reconcileProgressionCommandsInState } from './progression/progression-command-reconciler.mjs';

import { writeVerifierAgentRun, writeReviewerAgentRun, writeFinalizerAgentRun, writeBuilderAgentRun, writeIntegratorAgentRun } from "./agent-run-writeback.mjs";
import { updateWorkstreamContextFromCompletedTask } from "./workstream/task-outcome-summary.mjs";
import { recordAgentRunWritebackFailure } from "./task-processing/agent-run-writeback-failure.mjs";
import { writeFinalizationAgentRuns } from "./task-finalization/finalization-notifier.mjs";
import { collectTaskFinalizerEvidence } from "./task-finalization/task-finalization-facts.mjs";
import { applyTaskStateProjection } from "./task-finalization/task-state-projection.mjs";
import { projectGoalStatusForFinalizedTask } from "./task-finalization/goal-state-projection.mjs";
import {
  buildProgressionDecision,
  mutateFinalTaskState,
  runCompletedTaskAutoStart,
  runPostFinalizationEffects,
  writeGoalFinalizationArtifacts,
} from "./task-finalization/task-finalization-effects.mjs";
import {
  applyNoChangeRepairCompletionSummary,
  finalizeAcceptanceRepairCreation,
  finalizeVerificationRepairAttempt,
  propagateRepairChildCompletion,
} from "./task-finalization/repair-finalizer.mjs";
import { assertValidInputUnifiedDecision } from "./task-finalization/finalization-errors.mjs";
import { runTaskClosureReview, runTaskCompletionVerification, runTaskFinalizerOrchestration } from "./task-finalization/task-finalizer-orchestrator.mjs";
import {
  attachAlreadyIntegratedCommitEvidence,
  attachResolvedWorktreeEvidence,
  buildFallbackResultJson,
  normalizeCompletedDeliveryState,
} from "./task-finalization/finalization-proofs.mjs";
import { releaseFinalizationRepoLock } from "./task-finalization/worktree-cleanup.mjs";

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
  runAcceptanceGateFn = runAcceptanceGate,
  autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted,
  runIntegrationQueueFn = runIntegrationQueue,
  runAutoIntegrationCompletionFn = runAutoIntegrationCompletion,
  shouldAttemptRepairFn = shouldAttemptRepair,
  createRepairGoalFromFindingsFn = createRepairGoalFromFindings,
  scheduleRepairAttemptFn = scheduleRepairAttempt,
  createGoalFn = createGoal,
  reconcileProgressionCommandsInStateFn = reconcileProgressionCommandsInState,
  deliveryResultRecovery = null,
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

  const orchestration = await runTaskFinalizerOrchestration({
    taskStatus,
    taskResult,
    summary,
    deliveryResultRecovery,
    task,
    goal,
    store,
    config,
    resolvedRepo,
    runIntegrationQueueFn,
    runAutoIntegrationCompletionFn,
    shouldAttemptRepairFn,
    createRepairGoalFromFindingsFn,
    createGoalFn,
  });
  taskStatus = orchestration.taskStatus;
  taskResult = orchestration.taskResult;
  summary = orchestration.summary;

  const verifierRepoPath = taskResult?.auto_integration_completion?.completed === true
    ? (resolvedRepo?.canonical_repo_path || taskResult?.execution_cwd || resolvedRepo?.task_worktree_path || workspace?.root || config.defaultRepoPath || config.defaultWorkspaceRoot)
    : taskResult?.execution_cwd
    || resolvedRepo?.task_worktree_path
    || resolvedRepo?.canonical_repo_path
    || workspace?.root
    || config.defaultRepoPath
    || config.defaultWorkspaceRoot;

  taskResult = attachAlreadyIntegratedCommitEvidence({
    taskStatus,
    taskResult,
    candidatePaths: [
      verifierRepoPath,
      resolvedRepo?.canonical_repo_path,
      workspace?.root,
      config.defaultRepoPath,
      config.defaultWorkspaceRoot,
    ],
  });

  if (taskStatus === "completed") {
    const resultJsonForVerification = buildFallbackResultJson({ taskStatus, taskResult, summary });
    const completionVerification = await runTaskCompletionVerification({
      taskStatus,
      taskResult,
      resultJsonForVerification,
      resultJsonPath,
      task,
      goal,
      verifierRepoPath,
      config,
      verifyTaskCompletionFn,
      autoIntegrationVerificationFromReportFn: autoIntegrationVerificationFromReport,
    });
    taskStatus = completionVerification.taskStatus;
    taskResult = completionVerification.taskResult;
    let verification = completionVerification.verification;

    if (resultJsonPath) {
      const verificationPath = join(dirname(resultJsonPath), "verification.json");
      await mkdir(dirname(verificationPath), { recursive: true }).catch(() => {});
      await writeFileFn(verificationPath, JSON.stringify(verification, null, 2) + "\n", "utf8").catch(() => {});
    }
    if (verification.passed !== true) {
      const failure = classifyTaskFailure({ task, codexResult: taskResult, verification });
      const repairAttempt = await finalizeVerificationRepairAttempt({
        taskStatus,
        taskResult,
        task,
        goal,
        store,
        config,
        resolvedRepo,
        failure,
        verification,
        canRetryTaskFn: canRetryTask,
        scheduleRepairAttemptFn,
        createGoalFn,
      });
      taskStatus = repairAttempt.taskStatus;
      taskResult = repairAttempt.taskResult;
      verification = repairAttempt.verification;
      taskResult.summary = taskResult.summary || summary || "Task requires review after verification failed.";
    }

    const closureReview = await runTaskClosureReview({
      taskStatus,
      taskResult,
      task,
      goal,
      store,
      config,
      resolvedRepo,
      verifierRepoPath,
      resultJsonPath,
      verification,
      runAcceptanceGateFn,
      decideTaskClosureFn: decideTaskClosure,
      finalizeAcceptanceRepairCreationFn: finalizeAcceptanceRepairCreation,
      shouldAttemptRepairFn,
      createRepairGoalFromFindingsFn,
      createGoalFn,
      planFollowupTasksFn: planFollowupTasks,
      planUnacceptedTaskFollowupFn: planUnacceptedTaskFollowup,
      applyClosureDecisionToTaskResultFn: applyClosureDecisionToTaskResult,
    });
    taskStatus = closureReview.taskStatus;
    taskResult = closureReview.taskResult;
  }
  await writeFinalizationAgentRuns({
    store,
    task,
    goal,
    taskResult,
    taskStatus,
    context,
    writeBuilderAgentRunFn: writeBuilderAgentRun,
    writeIntegratorAgentRunFn: writeIntegratorAgentRun,
    writeVerifierAgentRunFn: writeVerifierAgentRun,
    writeReviewerAgentRunFn: writeReviewerAgentRun,
    writeFinalizerAgentRunFn: writeFinalizerAgentRun,
    recordAgentRunWritebackFailureFn: recordAgentRunWritebackFailure,
  });


  if (taskStatus !== "completed" && resolvedRepo?.worktree_lifecycle?.mode === "git_worktree" && resolvedRepo?.task_worktree_path) {
    taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
    taskResult.warnings.push("Worktree retained: " + resolvedRepo.task_worktree_path + " (status=" + taskStatus + ")");
  }


  // ---- P0: Auto-closure classification and consistency ----
  // Classify the task type and closure path for auditing.
  // This classification is persisted in the task result for downstream tools.
  const _closureResult = classifyClosure(taskResult, task, null);
  taskResult.closure_type = _closureResult.taskType.type;
  taskResult.closure_path = _closureResult.closurePath.path;
  taskResult.closure_summary = _closureResult.summary;
  taskResult.needs_restart_check = _closureResult.needsRestartCheck;
  taskResult.needs_integration = _closureResult.needsIntegration;
  taskResult = applyNoChangeRepairCompletionSummary({ task, taskResult });
  taskResult = normalizeCompletedDeliveryState({ taskStatus, taskResult });
  taskResult = attachResolvedWorktreeEvidence(taskResult, resolvedRepo);
  assertValidInputUnifiedDecision(taskResult);

  const finalizerDecision = decideTaskFinalization(collectTaskFinalizerEvidence({
    task,
    goal,
    taskStatus,
    taskResult,
    config,
  }));
  const finalizerApplied = applyTaskFinalStateDecision({ taskStatus, taskResult, finalizerDecision });
  taskStatus = finalizerApplied.taskStatus;
  taskResult = finalizerApplied.taskResult;


  // ---- P0-MA12-G2: Auto Closure Reconciliation ----
  // Reconcile closure_decision, finalizer_decision, and task.status so that
  // verified + integrated tasks with all evidence close deterministically.
  const reconciliationResult = reconcileTaskClosure({ taskStatus, taskResult, config });
  // P0-AFC7: Continuation flow — when reconciliation returns a canonical
  // goalStatus (from R0), the continuation hook is available for downstream
  // consumers (goal convergence, queue auto-advance) to use directly.
  let continuationFlow = null;
  if (reconciliationResult.reconciled) {
    taskStatus = reconciliationResult.taskStatus;
    taskResult = reconciliationResult.taskResult;
    taskResult.reconciled_at = new Date().toISOString();
    taskResult.reconciliation_reason = reconciliationResult.reason;
    const taskWarnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
    taskResult.warnings = taskWarnings;
    taskResult.warnings.push("Reconciled: " + reconciliationResult.reason);

    // Build continuation flow decision from canonical outcome.
    // When reconciliation sets goalStatus, the completion is canonical and
    // should drive goal convergence + queue auto-advance unconditionally.
    continuationFlow = continueOnCompletedOutcome({
      taskResult: reconciliationResult.taskResult,
      task,
      goal,
    });
  }

  const progressionDecision = buildProgressionDecision({
    task,
    goal,
    taskResult,
    doneAt,
    config,
  });
  const result = typeof store.mutate === "function"
    ? await mutateFinalTaskState({
        store,
        task,
        taskStatus,
        taskResult,
        doneAt,
        cr,
        config,
        goal,
        progressionDecision,
        reconcileProgressionCommandsInStateFn,
      })
    : await updateTaskFn(store, task.id, (item) => {
      applyTaskStateProjection(item, { taskStatus, taskResult, doneAt, cr, config });
    });
  const progressionReport = result?.progression_commands || null;

  if (taskStatus === "completed" && (task.workstream_id || goal?.workstream_id)) {
    const outcomeUpdate = await updateWorkstreamContextFromCompletedTask({
      store,
      workspaceRoot: config.defaultWorkspaceRoot,
      task: result?.task || { ...task, status: taskStatus },
      goal,
      result: taskResult,
    }).catch((error) => ({ applied: false, reason: error.message }));
    taskResult.workstream_context_update = outcomeUpdate;
  }

  await releaseFinalizationRepoLock({
    config,
    task,
    repoLockPath,
    loadRestartMarkerFn,
    releaseRepoLockFn,
  });

  if (goal) {
    // P0-AFC7: Consume reconciliation goalStatus when available (from R0 canonical outcome)
    const canonicalGoalStatus = goalStatusFromReconciliation(reconciliationResult);
    const goalStatus = canonicalGoalStatus || projectGoalStatusForFinalizedTask({
      goal,
      task: result?.task || task,
      taskStatus,
      taskResult,
      state: store.state || {},
    });
    if (typeof store.mutate !== "function") {
      await updateGoalStatusFn(store, goal.id, goalStatus, doneAt);
    }
    await writeGoalFinalizationArtifacts({
      store,
      config,
      workspace,
      workspaceFiles,
      context,
      goal,
      task,
      taskStatus,
      taskResult,
      summary,
      doneAt,
      resultJsonPath,
      writeWorkspaceTextInternalFn,
      appendGoalMessageFn,
      writeFileFn,
      buildFallbackResultJsonFn: buildFallbackResultJson,
    });
  }

  const autoStartResult = await runCompletedTaskAutoStart({
    taskStatus,
    store,
    config,
    task: result.task,
    autoStartNextOnTaskCompletedFn,
  });

  await propagateRepairChildCompletion({
    task,
    taskStatus,
    taskResult,
    finalTask: result.task,
    store,
    config,
    handleRepairCompletionFn: handleRepairCompletion,
    logFn: (line) => {
      const logPath = process.env.GPTWORK_LOG_PATH;
      if (logPath) appendFileSync(logPath, line);
    },
  });

  await runPostFinalizationEffects({
    store,
    task: result.task,
    taskResult,
    github,
    convergeStaleGoalStatusesFn: convergeStaleGoalStatuses,
    logFn: (line) => {
      const logPath = process.env.GPTWORK_LOG_PATH;
      if (logPath) appendFileSync(logPath, line);
    },
  });
  return {
    task_id: result.task.id,
    status: taskStatus,
    kind: taskResult.kind,
    auto_start: autoStartResult,
    progression_commands: progressionReport,
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
