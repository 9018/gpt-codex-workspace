import { appendFileSync } from "node:fs";
import { mkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { fireHeartbeat } from "./codex-run-metadata.mjs";
import { convergeStaleGoalStatuses } from "./goal-convergence.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { releaseRepoLock } from "./repo-lock.mjs";
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

import { updateWorkstreamContextFromCompletedTask } from "./workstream/task-outcome-summary.mjs";
import { writeDefaultFinalizationAgentRuns } from "./task-finalization/finalization-notifier.mjs";
import { collectTaskFinalizerEvidence } from "./task-finalization/task-finalization-facts.mjs";
import { applyTaskStateProjection } from "./task-finalization/task-state-projection.mjs";
import { projectGoalStatusForFinalizedTask } from "./task-finalization/goal-state-projection.mjs";
import {
  buildProgressionDecision,
  mutateFinalTaskState,
  runFinalizationPostStateEffects,
  runPostFinalizationEffects,
} from "./task-finalization/task-finalization-effects.mjs";
import {
  applyNoChangeRepairCompletionSummary,
  finalizeAcceptanceRepairCreation,
  finalizeVerificationRepairAttempt,
  propagateRepairChildCompletion,
} from "./task-finalization/repair-finalizer.mjs";
import { assertValidInputUnifiedDecision } from "./task-finalization/finalization-errors.mjs";
import { runCompletedTaskVerificationPipeline, runTaskFinalizerOrchestration } from "./task-finalization/task-finalizer-orchestrator.mjs";
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
    const completionPipeline = await runCompletedTaskVerificationPipeline({
      taskStatus,
      taskResult,
      summary,
      resultJsonForVerification,
      resultJsonPath,
      task,
      goal,
      store,
      config,
      resolvedRepo,
      verifierRepoPath,
      verifyTaskCompletionFn,
      autoIntegrationVerificationFromReportFn: autoIntegrationVerificationFromReport,
      mkdirFn: mkdir,
      writeFileFn,
      classifyTaskFailureFn: classifyTaskFailure,
      finalizeVerificationRepairAttemptFn: finalizeVerificationRepairAttempt,
      canRetryTaskFn: canRetryTask,
      scheduleRepairAttemptFn,
      createGoalFn,
      runAcceptanceGateFn,
      decideTaskClosureFn: decideTaskClosure,
      finalizeAcceptanceRepairCreationFn: finalizeAcceptanceRepairCreation,
      shouldAttemptRepairFn,
      createRepairGoalFromFindingsFn,
      planFollowupTasksFn: planFollowupTasks,
      planUnacceptedTaskFollowupFn: planUnacceptedTaskFollowup,
      applyClosureDecisionToTaskResultFn: applyClosureDecisionToTaskResult,
    });
    taskStatus = completionPipeline.taskStatus;
    taskResult = completionPipeline.taskResult;
  }
  await writeDefaultFinalizationAgentRuns({
    store,
    task,
    goal,
    taskResult,
    taskStatus,
    context,
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

  return await runFinalizationPostStateEffects({
    store,
    config,
    task,
    finalTask: result.task,
    goal,
    taskStatus,
    taskResult,
    summary,
    doneAt,
    workspace,
    workspaceFiles,
    context,
    repoLockPath,
    resultJsonPath,
    progressionReport,
    github,
    reconciliationResult,
    updateWorkstreamContextFromCompletedTaskFn: updateWorkstreamContextFromCompletedTask,
    releaseFinalizationRepoLockFn: releaseFinalizationRepoLock,
    loadRestartMarkerFn,
    releaseRepoLockFn,
    updateGoalStatusFn,
    writeWorkspaceTextInternalFn,
    appendGoalMessageFn,
    writeFileFn,
    buildFallbackResultJsonFn: buildFallbackResultJson,
    autoStartNextOnTaskCompletedFn,
    propagateRepairChildCompletionFn: propagateRepairChildCompletion,
    handleRepairCompletionFn: handleRepairCompletion,
    runPostFinalizationEffectsFn: ({ store, task, taskResult, github, logFn }) => runPostFinalizationEffects({
      store,
      task,
      taskResult,
      github,
      convergeStaleGoalStatusesFn: convergeStaleGoalStatuses,
      logFn,
    }),
    goalStatusFromReconciliationFn: goalStatusFromReconciliation,
    projectGoalStatusForFinalizedTaskFn: projectGoalStatusForFinalizedTask,
    logFn: (line) => {
      const logPath = process.env.GPTWORK_LOG_PATH;
      if (logPath) appendFileSync(logPath, line);
    },
  });
}
