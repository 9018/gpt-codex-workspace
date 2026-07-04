import { dirname, join } from "node:path";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { fireHeartbeat } from "./codex-run-metadata.mjs";
import { determineGoalStatus, convergeStaleGoalStatuses } from "./goal-convergence.mjs";
import { loadRestartMarker } from "./safe-restart.mjs";
import { releaseRepoLock } from "./repo-lock.mjs";
import { removeTaskWorktree } from "./task-worktree-manager.mjs";
import { notifyTerminalTask, updateGoalStatus, updateTask } from "./task-lifecycle.mjs";
import { writeWorkspaceTextInternal } from "./workspace-service.mjs";
import { verifyTaskCompletion } from "./task-acceptance.mjs";
import { autoStartNextOnTaskCompleted } from "./goal-queue.mjs";
import { canRetryTask, classifyTaskFailure } from "./failure-classifier.mjs";
import { sanitizeTaskBranchName } from "./task-worktree-manager.mjs";
import { runIntegrationQueue } from './integration-queue.mjs';
import { createRepairGoalFromFindings, shouldAttemptRepair, handleRepairCompletion, scheduleRepairAttempt } from './repair-loop.mjs';
import { createGoal } from './goal-task-goals.mjs';
import { classifyClosure, checkNotificationConsistency } from './auto-closure-classifier.mjs';
import { applyFailedAutoIntegrationCompletion, applySuccessfulAutoIntegrationCompletion, classifyIntegrationQueueResult, runAutoIntegrationCompletion, autoIntegrationVerificationFromReport } from './auto-integration-completion.mjs';
import { applyClosureDecisionToTaskResult, decideTaskClosure } from './closure/task-closure-decider.mjs';
import { planFollowupTasks, planUnacceptedTaskFollowup } from './closure/followup-task-planner.mjs';
import { reconcileTaskClosure } from './closure/task-closure-reconciler.mjs';
import { runAcceptanceGate } from './acceptance-gate-engine.mjs';
import { applyTaskFinalStateDecision, decideTaskFinalState } from './task-finalizer.mjs';
import { classifyNoChangeRepairOutcome } from './no-change-repair-classifier.mjs';

import { writeVerifierAgentRun, writeReviewerAgentRun, writeFinalizerAgentRun, writeBuilderAgentRun, writeIntegratorAgentRun } from "./agent-run-writeback.mjs";
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

function createdFollowupFromTaskResult(taskResult = {}) {
  if (!taskResult.repair_goal_id && !taskResult.repair_task_id) return null;
  return {
    goal: taskResult.repair_goal_id ? { id: taskResult.repair_goal_id } : null,
    task: taskResult.repair_task_id ? { id: taskResult.repair_task_id } : null,
  };
}

function contractForClosure({ goal, taskResult } = {}) {
  return goal?.acceptance_contract || taskResult?.acceptance_contract || null;
}

function resultForClosure({ taskStatus, taskResult = {}, verification = null } = {}) {
  return {
    ...taskResult,
    status: taskStatus,
    verification: taskResult.verification || verification || null,
    contract_verification: taskResult.contract_verification || verification?.contract_verification || null,
  };
}

function unresolvedBlockingFindings(findings = []) {
  return Array.isArray(findings)
    ? findings.filter((finding) => (finding?.severity === "blocker" || finding?.severity === "major") && finding?.resolved !== true)
    : [];
}

function acceptedByAcceptanceAgent(taskResult = {}) {
  const decision = taskResult.reviewer_decision || {};
  if (decision.passed === true) return true;
  if (decision.status === "accepted" || decision.decision === "accepted") return true;
  if (decision.decision?.passed === true) return true;
  if (decision.decision?.status === "accepted" || decision.decision?.decision === "accepted") return true;
  return false;
}

function shouldPreferAutoIntegrationEvidence(taskResult = {}) {
  if (taskResult.auto_integration_completion?.completed !== true) return false;
  if (taskResult.auto_integration_completion?.verification_report?.passed === false) return false;
  if (!acceptedByAcceptanceAgent(taskResult)) return false;
  return unresolvedBlockingFindings(taskResult.acceptance_findings).length === 0;
}

function closureAllowsQueuePropagation(taskResult = {}) {
  const status = taskResult.closure_decision?.status;
  return status === "auto_completed_clean" || status === "auto_completed_with_followups";
}

function integrationVerifiedForQueuePropagation(taskResult = {}) {
  const integration = taskResult.integration || {};
  const autoCompletion = taskResult.auto_integration_completion || {};
  const merged = integration.merged === true || ["merged", "ff_only_merged", "skipped"].includes(String(integration.status || ""));
  const report = autoCompletion.verification_report || {};
  const autoCompleted = autoCompletion.completed === true
    && report.passed !== false
    && report.dirty !== true
    && autoCompletion.canonical_clean_after !== false;
  return merged && autoCompleted;
}

function shouldPropagateAcceptedQueueCompletion({ taskStatus, taskResult = {} } = {}) {
  if (taskStatus !== "completed") return false;
  if (taskResult.requires_review === true) return false;
  if (!acceptedByAcceptanceAgent(taskResult)) return false;
  if (!closureAllowsQueuePropagation(taskResult)) return false;
  if (!integrationVerifiedForQueuePropagation(taskResult)) return false;
  if (taskResult.contract_verification?.blocking_passed === false) return false;
  if (taskResult.contract_verification?.completion_eligible === false) return false;
  if (taskResult.contract_verification?.requires_review === true) return false;
  return unresolvedBlockingFindings(taskResult.acceptance_findings).length === 0;
}

function isGoalDependencyReasonFor(goalId, reason = "") {
  const text = String(reason || "");
  return text.includes(`depends_on_goal ${goalId}`) || text.includes(`depends_on_goal_id ${goalId}`);
}

function autoIntegrationClosureVerification({ taskResult = {}, fallbackVerification = null } = {}) {
  const base = autoIntegrationVerificationFromReport(taskResult.auto_integration_completion);
  return {
    ...base,
    status: "completed",
    passed: true,
    changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
    reason_no_tests: null,
    failure_class: null,
    requires_review: false,
    findings: [],
    report_reuse: fallbackVerification?.report_reuse || null,
    fallback_verification: fallbackVerification ? {
      passed: fallbackVerification.passed === true,
      status: fallbackVerification.status || null,
      failure_class: fallbackVerification.failure_class || null,
      findings: Array.isArray(fallbackVerification.findings) ? fallbackVerification.findings : [],
    } : null,
    contract_verification: {
      ...(fallbackVerification?.contract_verification || {}),
      contract_valid: fallbackVerification?.contract_verification?.contract_valid !== false,
      blocking_passed: true,
      acceptance_status: "satisfied",
      completion_eligible: true,
      requires_review: false,
      blockers: [],
      non_blocking_followups: Array.isArray(fallbackVerification?.contract_verification?.non_blocking_followups)
        ? fallbackVerification.contract_verification.non_blocking_followups
        : [],
      quality_notes: Array.isArray(fallbackVerification?.contract_verification?.quality_notes)
        ? fallbackVerification.contract_verification.quality_notes
        : [],
      state_assertions: fallbackVerification?.contract_verification?.state_assertions || { passed: true, failures: [] },
    },
  };
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
  runAcceptanceGateFn = runAcceptanceGate,
  autoStartNextOnTaskCompletedFn = autoStartNextOnTaskCompleted,
  runIntegrationQueueFn = runIntegrationQueue,
  runAutoIntegrationCompletionFn = runAutoIntegrationCompletion,
  shouldAttemptRepairFn = shouldAttemptRepair,
  createRepairGoalFromFindingsFn = createRepairGoalFromFindings,
  scheduleRepairAttemptFn = scheduleRepairAttempt,
  createGoalFn = createGoal,
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
          taskResult.integration = { ...integrationResult };
          const integrationDecision = classifyIntegrationQueueResult(integrationResult);
          if (integrationDecision.kind === 'terminal_completed') {
            taskStatus = integrationDecision.task_status;
          } else if (integrationDecision.should_attempt_auto_completion) {
            const autoCompletion = await runAutoIntegrationCompletionFn({
              task,
              goal,
              taskResult,
              resolvedRepo,
              integrationResult,
              config,
            });
            taskResult.auto_integration_completion = autoCompletion;
            if (autoCompletion.completed === true) {
              taskStatus = "completed";
              taskResult = applySuccessfulAutoIntegrationCompletion({ taskResult, integrationResult, autoCompletion });
            } else {
              taskStatus = "waiting_for_review";
              taskResult = applyFailedAutoIntegrationCompletion({ taskResult, autoCompletion });
            }
          } else {
            taskStatus = integrationDecision.task_status;
          }
        } else if (classifyIntegrationQueueResult(integrationResult).should_attempt_repair) {
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

  const recoveryDecision = applyVerifiedDeliveryResultRecovery({
    taskStatus,
    taskResult,
    summary,
    deliveryResultRecovery,
  });
  taskStatus = recoveryDecision.taskStatus;
  taskResult = recoveryDecision.taskResult;
  summary = recoveryDecision.summary;

  const verifierRepoPath = taskResult?.auto_integration_completion?.completed === true
    ? (resolvedRepo?.canonical_repo_path || taskResult?.execution_cwd || resolvedRepo?.task_worktree_path || workspace?.root || config.defaultRepoPath || config.defaultWorkspaceRoot)
    : taskResult?.execution_cwd
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

    if (taskResult.auto_integration_completion?.completed === true) {
      taskResult.final_verification = verification;
      const closureVerification = shouldPreferAutoIntegrationEvidence(taskResult)
        ? autoIntegrationClosureVerification({ taskResult, fallbackVerification: verification })
        : null;
      if (closureVerification) {
        verification = closureVerification;
        taskResult.verification = closureVerification;
        taskResult.contract_verification = closureVerification.contract_verification;
      } else {
        taskResult.verification = taskResult.verification || autoIntegrationVerificationFromReport(taskResult.auto_integration_completion);
      }
    } else {
      taskResult.verification = verification;
    }
    if (verification.contract_verification) {
      taskResult.contract_verification = verification.contract_verification;
    }
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
      const failure = classifyTaskFailure({ task, codexResult: taskResult, verification });
      const retryTask = {
        ...task,
        max_attempts: config.maxRepairAttempts || task.max_attempts || task.maxAttempts || 2,
      };
      taskResult.failure_class = failure.failure_class;
      taskResult.failure_reason = failure.reason;
      taskResult.repair_strategy = failure.repair_strategy;
      verification.failure_class = failure.failure_class;

      if (canRetryTask(retryTask, failure)) {
        try {
          const repairResult = await scheduleRepairAttemptFn({
            store,
            task: taskWithRepairContext(retryTask, resolvedRepo),
            goal,
            failure,
            verification,
            config: { ...config, createGoalFn },
          });
          taskStatus = "waiting_for_repair";
          taskResult.repair_goal = repairResult.repair_goal;
          taskResult.attempt = repairResult.attempt;
          taskResult.repair_attempt = repairResult.attempt;
          taskResult.repair_of_attempt = repairResult.repair_of_attempt;
          taskResult.repair_goal_id = repairResult.repair_goal_id;
          taskResult.repair_task_id = repairResult.repair_task_id;
          taskResult.reason = `verification_failed: scheduled repair attempt ${repairResult.attempt}/${retryTask.max_attempts}`;
        } catch (err) {
          taskStatus = "waiting_for_review";
          taskResult.repair_denied_reason = "Repair attempt creation failed: " + (err?.message || String(err));
          taskResult.reason = taskResult.repair_denied_reason;
          taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
          taskResult.warnings.push(taskResult.repair_denied_reason);
        }
      } else {
        taskStatus = "waiting_for_review";
        taskResult.repair_denied_reason = failure.repairable
          ? `Max attempts reached for ${failure.failure_class}; waiting for review.`
          : `${failure.failure_class} is not repairable automatically; waiting for review.`;
        taskResult.reason = taskResult.repair_denied_reason;
      }
      taskResult.kind = taskResult.kind || "verification_failed";
      taskResult.requires_review = true;
      taskResult.summary = taskResult.summary || summary || "Task requires review after verification failed.";
    }

    let acceptanceGate = null;
    try {
      acceptanceGate = await runAcceptanceGateFn({
        task,
        goal,
        repoPath: verifierRepoPath,
        resultJson: resultForClosure({ taskStatus, taskResult, verification }),
        resultJsonPath,
        config: {
          ...config,
          verificationFailureRequiresReview: verification.passed === false && taskStatus === "waiting_for_review",
        },
        verification,
        writeArtifacts: true,
      });
    } catch (err) {
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push("Acceptance gate execution failed: " + (err?.message || String(err)));
    }
    if (acceptanceGate) {
      taskResult.acceptance_gate = acceptanceGate;
      taskResult.acceptance_result_path = acceptanceGate.artifacts?.acceptance_json || null;
      if (acceptanceGate.contract_verification) taskResult.contract_verification = acceptanceGate.contract_verification;
    }
    const closureDecision = acceptanceGate?.closure_decision || decideTaskClosure({
        contract: contractForClosure({ goal, taskResult }),
        contractVerification: taskResult.contract_verification || verification.contract_verification || null,
        verification,
        integration: taskResult.integration,
        deployment: taskResult.deployment || taskResult.runtime || null,
        result: resultForClosure({ taskStatus, taskResult, verification }),
        task,
        config: {
          ...config,
          verificationFailureRequiresReview: verification.passed === false && taskStatus === "waiting_for_review",
        },
      });
    if (closureDecision.status === "waiting_for_repair" && !taskResult.repair_goal_id && !taskResult.repair_task_id) {
      const repairableBlockers = Array.isArray(closureDecision.repairable_blockers) ? closureDecision.repairable_blockers : [];
      const repairCheck = shouldAttemptRepairFn({ task, tasks: store.state?.tasks || [], maxAttempts: config.maxRepairAttempts || task.max_attempts || 2 });
      if (repairableBlockers.length > 0 && repairCheck.should_repair) {
        const failureClass = repairableBlockers[0]?.code || "acceptance_blocker";
        const repairGoal = createRepairGoalFromFindingsFn({
          task: taskWithRepairContext(task, resolvedRepo),
          goal,
          findings: repairableBlockers,
          repairProposals: repairableBlockers.map((finding) => ({
            title: `Repair ${finding.code || "acceptance blocker"}`,
            proposed_action: finding.message || closureDecision.reason || "Fix the blocking acceptance finding and rerun verification.",
          })),
        });
        try {
          const created = await createGoalFn(store, config, applyRepairMetadata({
            user_request: repairGoal.user_request,
            goal_prompt: repairGoal.goal_prompt,
            title: `Repair: ${task.title || task.id} (acceptance blocker)`,
            project_id: task.project_id || goal?.project_id || "default",
            workspace_id: repairGoal.workspace_id || task.workspace_id || goal?.workspace_id || "hosted-default",
            mode: repairGoal.mode || task.mode || "builder",
            assign_to_codex: true,
            skip_created_notification: false,
            attempt: repairGoal.attempt,
            repair_of_attempt: repairGoal.repair_of_attempt,
          }, repairGoal));
          taskResult.repair_goal = repairGoal;
          taskResult.repair_attempt = repairGoal.repair_attempt;
          taskResult.attempt = repairGoal.attempt;
          taskResult.repair_of_attempt = repairGoal.repair_of_attempt;
          taskResult.repair_goal_id = created.goal?.id || null;
          taskResult.repair_task_id = created.task?.id || null;
          taskResult.failure_class = taskResult.failure_class || failureClass;
        } catch (err) {
          closureDecision.status = "requires_review";
          closureDecision.task_status = "waiting_for_review";
          closureDecision.reason = "acceptance_repair_creation_failed";
          taskResult.repair_denied_reason = "Acceptance repair task creation failed: " + (err?.message || String(err));
          taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
          taskResult.warnings.push(taskResult.repair_denied_reason);
        }
      } else if (repairableBlockers.length > 0 && !repairCheck.should_repair) {
        closureDecision.status = "requires_review";
        closureDecision.task_status = "waiting_for_review";
        closureDecision.reason = "acceptance_repair_budget_exhausted";
        taskResult.repair_denied_reason = repairCheck.reason;
      }
    }
    const plannedFollowups = planFollowupTasks({
      task,
      goal,
      result: taskResult,
      contractVerification: taskResult.contract_verification || verification.contract_verification || null,
      closureDecision,
    });
    const unacceptedFollowup = planUnacceptedTaskFollowup({
      task,
      goal,
      result: taskResult,
      closureDecision,
      acceptanceGate,
      created: createdFollowupFromTaskResult(taskResult),
    });
    if (unacceptedFollowup) taskResult.followup_processing = unacceptedFollowup;
    const closureApplied = applyClosureDecisionToTaskResult({
      taskStatus,
      taskResult,
      closureDecision,
      plannedFollowups,
      config,
    });
    taskStatus = closureApplied.taskStatus;
    taskResult = closureApplied.taskResult;
  }
  // Agent run writebacks: builder, integrator, verifier, reviewer, finalizer (non-blocking)
  const _writebackCtx = { eventLogger: context?.eventLogger, hookBus: context?.hookBus };
  await writeBuilderAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    taskResult,
    summary: taskResult.summary || '',
  }, _writebackCtx).catch(() => {});
  await writeIntegratorAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    integrationResult: taskResult.integration || {},
  }, _writebackCtx).catch(() => {});
  await writeVerifierAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    verification: taskResult.verification || {},
  }, _writebackCtx).catch(() => {});
  await writeReviewerAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    reviewer_decision: taskResult.reviewer_decision || { decision: { status: taskStatus } },
  }, _writebackCtx).catch(() => {});
  await writeFinalizerAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    taskResult,
    taskStatus,
  }, _writebackCtx).catch(() => {});


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

  const finalizerDecision = decideTaskFinalState(collectTaskFinalizerEvidence({
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
  if (reconciliationResult.reconciled) {
    taskStatus = reconciliationResult.taskStatus;
    taskResult = reconciliationResult.taskResult;
    taskResult.reconciled_at = new Date().toISOString();
    taskResult.reconciliation_reason = reconciliationResult.reason;
    const taskWarnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
    taskResult.warnings = taskWarnings;
    taskResult.warnings.push("Reconciled: " + reconciliationResult.reason);
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
    const goalStatus = determineGoalStatus(goal, result?.task || task, taskResult || {}) || (taskStatus === "timed_out" ? "failed" : taskStatus);
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

  // P0: Repair parent-child loop — when a repair task completes, trigger
  // parent task re-verification / integration.
  if (taskStatus === "completed" && (task.parent_task_id || task.repair_of_task_id)) {
    try {
      const repairResult = await handleRepairCompletion({
        store,
        config,
        completedTask: result.task,
        passed: true,
      });
      if (repairResult.parent_updated) {
        const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] repair completion: parent ${repairResult.parent_task_id} updated to ${repairResult.parent_status}
`);
      }
    } catch (repairErr) {
      const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] repair completion handler error: ${repairErr.message}
`);
    }
  }

  try {
    const _gs = await github.syncTask(result.task);
    taskResult.github_sync = { ok: _gs?.ok === true, issue: _gs?.issue || null, updated: _gs?.updated === true || _gs?.created === true || false, comment_posted: _gs?.comment_posted === true };
  } catch (_ge) {
    taskResult.github_sync = { ok: false, error: _ge?.message || String(_ge) };
    // Non-critical — do not fail finalization
  }

  try {
    const sweepChanges = await convergeStaleGoalStatuses(store);
    if (sweepChanges.length > 0) {
      const logPath = process.env.GPTWORK_LOG_PATH;
      if (logPath) appendFileSync(logPath, `[gptwork-worker] goal sweep: converged ${sweepChanges.length} stale goal(s)\n`);
    }
  } catch {
    // Non-critical — goal sweep must not fail finalization.
  }
  return { task_id: result.task.id, status: taskStatus, kind: taskResult.kind, auto_start: autoStartResult };
}

function buildFallbackResultJson({ taskStatus, taskResult = {}, summary = "" }) {
  const verifiedNoChange = taskStatus === "completed"
    && Array.isArray(taskResult.changed_files)
    && taskResult.changed_files.length === 0
    && !taskResult.commit
    && taskResult.verification?.passed === true;
  return {
    status: taskStatus,
    summary: taskResult.summary || summary || "",
    noop: taskResult.noop === true || verifiedNoChange,
    noop_reason: taskResult.noop_reason || (verifiedNoChange ? "No changed files were reported and verification passed." : null),
    no_mutation: taskResult.no_mutation === true || verifiedNoChange,
    repo_mutated: taskResult.repo_mutated === false || verifiedNoChange ? false : (taskResult.repo_mutated === true ? true : null),
    operation_kind: taskResult.operation_kind || taskResult.operationKind || taskResult.acceptance_contract?.intent?.operation_kind || (verifiedNoChange ? "noop" : null),
    acceptance_contract_id: taskResult.acceptance_contract_id || taskResult.acceptanceContractId || taskResult.acceptance_contract?.id || null,
    blocking_evidence: taskResult.blocking_evidence || null,
    changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
    file_evidence: Array.isArray(taskResult.file_evidence) ? taskResult.file_evidence : [],
    restart_evidence: taskResult.restart_evidence || null,
    admin_evidence: taskResult.admin_evidence || null,
    diagnostic_evidence: taskResult.diagnostic_evidence || null,
    cleanup_evidence: taskResult.cleanup_evidence || null,
    tests: taskResult.tests || null,
    commit: taskResult.commit || null,
    local_head: taskResult.local_head || null,
    remote_head: taskResult.remote_head || null,
    warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
    followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
    followup_findings: Array.isArray(taskResult.followup_findings) ? taskResult.followup_findings : [],
    followup_processing: taskResult.followup_processing || null,
    quality_notes: Array.isArray(taskResult.quality_notes) ? taskResult.quality_notes : [],
    verification: taskResult.verification || null,
    contract_verification: taskResult.contract_verification || taskResult.verification?.contract_verification || taskResult.final_verification?.contract_verification || null,
    final_verification: taskResult.final_verification || null,
    acceptance_gate: taskResult.acceptance_gate || null,
    acceptance_result_path: taskResult.acceptance_result_path || null,
    closure_decision: taskResult.closure_decision || null,
    finalizer_decision: taskResult.finalizer_decision || null,
    no_change_repair_completion_summary: taskResult.no_change_repair_completion_summary || null,
    no_change_repair_completion: taskResult.no_change_repair_completion || null,
    failure_class: taskResult.failure_class || null,
    attempt: taskResult.attempt ?? null,
    repair_of_attempt: taskResult.repair_of_attempt ?? null,
    repo_resolution: taskResult.repo_resolution || null,
    worktree_lifecycle: taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null,
    worktree_lifecycle_proof: taskResult.worktree_lifecycle_proof || buildWorktreeLifecycleProof(taskResult),
    execution_cwd: taskResult.execution_cwd || null,
    execution_cwd_proof: taskResult.execution_cwd_proof || buildExecutionCwdProof(taskResult),
    queue_autostart_fix: taskResult.queue_autostart_fix || null,
    evidence_paths: taskResult.evidence_paths || null,
    reviewer_decision: taskResult.reviewer_decision || null,
    auto_integration_completion: taskResult.auto_integration_completion || null,
    acceptance_findings: Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [],
    next_tasks: Array.isArray(taskResult.next_tasks) ? taskResult.next_tasks : [],
    delivery_result_recovery: taskResult.delivery_result_recovery || null,
    needs_integration: taskResult.needs_integration === true,
    needs_restart_check: taskResult.needs_restart_check === true,
    delivery_state_normalized: taskResult.delivery_state_normalized === true,
  };
}

function normalizeCompletedDeliveryState({ taskStatus, taskResult = {} } = {}) {
  if (taskStatus !== "completed") return taskResult;
  if (!hasIntegratedCommitEvidence(taskResult) || !hasRuntimeHeadConvergence(taskResult)) return taskResult;

  const warnings = Array.isArray(taskResult.warnings)
    ? taskResult.warnings.filter((warning) => !/^Worktree retained:/i.test(String(warning || "")))
    : [];
  const next = {
    ...taskResult,
    warnings,
    needs_integration: false,
    needs_restart_check: false,
    delivery_state_normalized: true,
  };
  if (next.closure_path === "integrate") next.closure_path = "complete";
  if (typeof next.closure_summary === "string") {
    next.closure_summary = next.closure_summary
      .replace(/Closure path: integrate/g, "Closure path: complete")
      .replace(/Code change task \([^)]*\)\. Needs integration\./g, "Completed code change task is integrated and runtime-verified.")
      .replace(/Restart check: required/g, "Restart check: not required");
  }
  return next;
}

function hasIntegratedCommitEvidence(taskResult = {}) {
  const integration = taskResult.integration || {};
  if (integration.merged === true) return true;
  if (["merged", "skipped"].includes(integration.status)) return true;
  if (taskResult.auto_integration_completion?.completed === true) return true;
  if (taskResult.delivery_result_recovery?.commit_integrated === true) return true;
  return false;
}

function hasRuntimeHeadConvergence(taskResult = {}) {
  const autoCompletion = taskResult.auto_integration_completion || null;
  const commit = taskResult.commit || autoCompletion?.commit || taskResult.delivery_result_recovery?.commit || null;
  const localHead = taskResult.local_head || autoCompletion?.commit || taskResult.delivery_result_recovery?.local_head || taskResult.repo_head || null;
  const runningCommit = taskResult.running_commit || taskResult.runtime?.running_commit || null;
  const repoHead = taskResult.repo_head || taskResult.runtime?.repo_head || localHead;
  const remoteHead = taskResult.remote_head || taskResult.delivery_result_recovery?.remote_head || null;
  const restartVerified = taskResult.restart_state === "verified" || taskResult.post_restart_verified === true || Boolean(taskResult.restart_verified_at);

  if (!commit || !localHead) return false;
  if (commit !== localHead) return false;
  if (repoHead && repoHead !== commit) return false;
  if (remoteHead && remoteHead !== commit) return false;
  if (runningCommit && runningCommit !== commit) return false;
  return restartVerified || !runningCommit;
}

function collectTaskFinalizerEvidence({ task = {}, goal = null, taskStatus, taskResult = {}, config = {} } = {}) {
  const maxAttempts = Number.isInteger(task.max_attempts)
    ? task.max_attempts
    : Number.isInteger(task.maxAttempts)
      ? task.maxAttempts
      : Number.isInteger(config.maxRepairAttempts)
        ? config.maxRepairAttempts
        : 2;
  const attempt = Number.isInteger(task.attempt)
    ? task.attempt
    : Number.isInteger(taskResult.attempt)
      ? taskResult.attempt
      : Number.isInteger(taskResult.repair_attempt)
        ? taskResult.repair_attempt
        : 0;
  const integrationRequired = taskResult.needs_integration === true
    || goal?.acceptance_contract?.requirements?.requires_integration === true
    || goal?.acceptance_contract?.completion_policy?.requires_integration === true;
  return {
    current_status: taskStatus,
    previous_status: task.status || null,
    task,
    goal,
    codex_result: taskResult,
    verification: taskResult.verification || taskResult.final_verification || null,
    acceptance: taskResult.acceptance_gate || taskResult.acceptance || null,
    contract_verification: taskResult.contract_verification || taskResult.verification?.contract_verification || taskResult.final_verification?.contract_verification || null,
    integration: {
      ...(taskResult.integration || {}),
      required: integrationRequired || taskResult.integration?.required === true,
    },
    runtime_guard: taskResult.runtime_guard || taskResult.restart_guard || taskResult.runtime || null,
    repair_budget: {
      attempt,
      max_attempts: maxAttempts,
      attempts_remaining: Math.max(0, maxAttempts - attempt - 1),
    },
    queue_context: {
      auto_start: task.auto_start,
      goal_id: goal?.id || task.goal_id || null,
    },
  };
}

function applyNoChangeRepairCompletionSummary({ task = {}, taskResult = {} } = {}) {
  const classification = classifyNoChangeRepairOutcome({ task, taskResult });
  if (!classification.is_no_change_repair) return taskResult;
  return {
    ...taskResult,
    no_change_repair_completion: classification,
    no_change_repair_completion_summary: {
      kind: classification.kind,
      completion_eligible: classification.completion_eligible,
      reason: classification.reason,
      changed_files_empty_acceptable: classification.completion_eligible === true,
      explanation: classification.completion_eligible === true
        ? "changed_files=[] is acceptable for this repair because existing canonical state already satisfies the target, verification passed, acceptance passed, no unresolved blocker remains, and integration is not required or already satisfied."
        : "changed_files=[] remains blocked until repair/noop, target-state, verification, acceptance, blocker, and integration evidence are all present.",
      evidence: classification.evidence,
      blockers: classification.blockers,
    },
  };
}

function applyVerifiedDeliveryResultRecovery({ taskStatus, taskResult = {}, summary = "", deliveryResultRecovery = null }) {
  const recovery = deliveryResultRecovery || taskResult.delivery_result_recovery || null;
  if (!recovery) return { taskStatus, taskResult, summary };

  const verification = recovery.verification || taskResult.verification || null;
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  const verified = verification?.passed === true && commands.length > 0;
  const canonicalClean = recovery.canonical_clean === true;
  const commitIntegrated = recovery.commit_integrated === true;
  const hasHeads = Boolean(recovery.commit && recovery.local_head && recovery.remote_head);

  const nextTaskResult = {
    ...taskResult,
    delivery_result_recovery: {
      ...recovery,
      verification,
      passed: verified && canonicalClean && commitIntegrated && hasHeads,
    },
  };

  if (!(verified && canonicalClean && commitIntegrated && hasHeads)) {
    return { taskStatus, taskResult: nextTaskResult, summary };
  }

  const findings = Array.isArray(nextTaskResult.acceptance_findings) ? [...nextTaskResult.acceptance_findings] : [];
  findings.push({
    severity: "followup",
    code: "result_missing_but_verified_commit",
    message: "Codex CLI/result writeback failed, but canonical commit integration and verification evidence are complete.",
    source: "task_final_writeback",
    resolved: true,
  });

  const recoveredSummary = recovery.summary || summary || nextTaskResult.summary || "Delivery result writeback recovered from verified commit evidence.";
  return {
    taskStatus: "completed",
    summary: recoveredSummary,
    taskResult: {
      ...nextTaskResult,
      kind: "codex_executed",
      summary: recoveredSummary,
      failure_class: "delivery_result_writeback_missing",
      changed_files: Array.isArray(recovery.changed_files) ? recovery.changed_files : (Array.isArray(nextTaskResult.changed_files) ? nextTaskResult.changed_files : []),
      tests: recovery.tests || nextTaskResult.tests || "verified fallback result; see verification.commands",
      commit: recovery.commit,
      local_head: recovery.local_head,
      remote_head: recovery.remote_head,
      verification,
      reviewer_decision: nextTaskResult.reviewer_decision || { status: "accepted", passed: true },
      acceptance_findings: findings,
      followups: Array.isArray(nextTaskResult.followups) ? nextTaskResult.followups : [],
      warnings: Array.isArray(nextTaskResult.warnings) ? nextTaskResult.warnings : [],
      convergence: {
        ...(nextTaskResult.convergence || {}),
        nextStatus: "completed",
        closureReason: "result_missing_but_verified_commit",
      },
    },
  };
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
  if (taskResult.delivery_result_recovery?.attempted === true) {
    const recovery = taskResult.delivery_result_recovery;
    item.logs.push({
      time: doneAt,
      message: recovery.recovered === true
        ? `[worker] delivery recovery attempted: eligible=${recovery.eligible === true} recovered=true commit=${recovery.commit || "none"}`
        : `[worker] delivery recovery failed: ${recovery.reason || recovery.blockers?.[0]?.code || "unknown"}`,
    });
  }
  if (taskResult.auto_integration_completion?.attempted === true) {
    const autoCompletion = taskResult.auto_integration_completion;
    item.logs.push({
      time: doneAt,
      message: autoCompletion.completed === true
        ? `[worker] auto integration completion: ff-only merged and verified commit=${autoCompletion.commit || "none"} report=${autoCompletion.verification_report_path || "none"}`
        : `[worker] auto integration completion failed: ${autoCompletion.reason || autoCompletion.blockers?.[0]?.code || "unknown"}`,
    });
  }
  if (taskResult.failure_class || taskResult.repair_attempt !== undefined || taskResult.repair_of_attempt !== undefined) {
    item.logs.push({
      time: doneAt,
      message: `[worker] failure_class=${taskResult.failure_class || "none"} attempt=${item.attempt} repair_of_attempt=${taskResult.repair_of_attempt ?? "none"}`,
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

    let goalStatus = null;
    if (goal) {
      const goalItem = state.goals.find((candidate) => candidate.id === goal.id);
      if (goalItem) {
        goalStatus = determineGoalStatus(goalItem, item, item.result || {}) || (taskStatus === "timed_out" ? "failed" : taskStatus);
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
    reconcileAcceptedQueuePropagation(state, { task, item, goal, goalStatus, taskStatus, taskResult, doneAt });
    return { task: item };
  });
}

function reconcileAcceptedQueuePropagation(state, { task, item, goal, goalStatus, taskStatus, taskResult, doneAt }) {
  if (!Array.isArray(state.goal_queue)) return;
  if (!goal || !shouldPropagateAcceptedQueueCompletion({ taskStatus, taskResult })) return;

  const goalId = goal.id;
  if (goalStatus !== "completed") {
    const goalItem = Array.isArray(state.goals) ? state.goals.find((candidate) => candidate.id === goalId) : null;
    if (!goalItem || goalItem.status !== "completed") return;
  }

  const current = state.goal_queue.find((candidate) => candidate.task_id === task.id || candidate.goal_id === goalId);
  if (current && current.status !== "completed") {
    current.status = "completed";
    current.completed_task_id = task.id;
    current.failure_class = null;
    current.blocked_reason = null;
    current.updated_at = doneAt;
  }

  for (const candidate of state.goal_queue) {
    if (candidate.depends_on_goal_id !== goalId) continue;
    if (candidate.status !== "blocked") continue;
    if (!isGoalDependencyReasonFor(goalId, candidate.blocked_reason)) continue;
    candidate.status = candidate.auto_start === false ? "waiting" : "ready";
    candidate.blocked_reason = null;
    candidate.updated_at = doneAt;
    state.activities ||= [];
    state.activities.push({
      time: doneAt,
      type: "queue.dependency_reconciled",
      queue_id: candidate.queue_id,
      goal_id: candidate.goal_id,
      depends_on_goal_id: goalId,
      completed_task_id: item.id,
    });
  }
}
