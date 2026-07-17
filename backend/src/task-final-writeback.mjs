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
import { projectGoalStatusForFinalizedTask } from "./task-finalization/goal-state-projection.mjs";
import {
  runFinalizationStateTransition,
  runPostFinalizationEffects,
} from "./task-finalization/task-finalization-effects.mjs";
import {
  applyNoChangeRepairCompletionSummary,
  finalizeAcceptanceRepairCreation,
  finalizeVerificationRepairAttempt,
  propagateRepairChildCompletion,
} from "./task-finalization/repair-finalizer.mjs";
import { assertValidInputUnifiedDecision } from "./task-finalization/finalization-errors.mjs";
import { runCompletedTaskFinalizationStage, runCompletedTaskVerificationPipeline, runFinalDecisionReconciliation, runTaskFinalizerOrchestration } from "./task-finalization/task-finalizer-orchestrator.mjs";
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

  const completedStage = await runCompletedTaskFinalizationStage({
    taskStatus,
    taskResult,
    summary,
    resultJsonPath,
    task,
    goal,
    store,
    config,
    workspace,
    resolvedRepo,
    attachAlreadyIntegratedCommitEvidenceFn: attachAlreadyIntegratedCommitEvidence,
    buildFallbackResultJsonFn: buildFallbackResultJson,
    runCompletedTaskVerificationPipelineFn: runCompletedTaskVerificationPipeline,
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
  taskStatus = completedStage.taskStatus;
  taskResult = completedStage.taskResult;
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

  const finalDecisionReconciliation = runFinalDecisionReconciliation({
    taskStatus,
    taskResult,
    task,
    goal,
    config,
    resolvedRepo,
    classifyClosureFn: classifyClosure,
    applyNoChangeRepairCompletionSummaryFn: applyNoChangeRepairCompletionSummary,
    normalizeCompletedDeliveryStateFn: normalizeCompletedDeliveryState,
    attachResolvedWorktreeEvidenceFn: attachResolvedWorktreeEvidence,
    assertValidInputUnifiedDecisionFn: assertValidInputUnifiedDecision,
    collectTaskFinalizerEvidenceFn: collectTaskFinalizerEvidence,
    decideTaskFinalizationFn: decideTaskFinalization,
    applyTaskFinalStateDecisionFn: applyTaskFinalStateDecision,
    reconcileTaskClosureFn: reconcileTaskClosure,
    continueOnCompletedOutcomeFn: continueOnCompletedOutcome,
  });
  taskStatus = finalDecisionReconciliation.taskStatus;
  taskResult = finalDecisionReconciliation.taskResult;
  const reconciliationResult = finalDecisionReconciliation.reconciliationResult;

  return await runFinalizationStateTransition({
    store,
    config,
    task,
    goal,
    taskStatus,
    taskResult,
    cr,
    summary,
    doneAt,
    workspace,
    workspaceFiles,
    context,
    repoLockPath,
    resultJsonPath,
    github,
    reconciliationResult,
    updateTaskFn,
    reconcileProgressionCommandsInStateFn,
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
