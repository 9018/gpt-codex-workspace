import { dirname, join } from "node:path";
import { applyVerifiedDeliveryResultRecovery } from "./finalization-proofs.mjs";
import { finalizeWaitingForIntegration } from "./integration-finalizer.mjs";

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

export function shouldPreferAutoIntegrationEvidence(taskResult = {}) {
  if (taskResult.auto_integration_completion?.completed !== true) return false;
  if (taskResult.auto_integration_completion?.verification_report?.passed === false) return false;
  if (!acceptedByAcceptanceAgent(taskResult)) return false;
  return unresolvedBlockingFindings(taskResult.acceptance_findings).length === 0;
}

export function autoIntegrationClosureVerification({ taskResult = {}, fallbackVerification = null, autoIntegrationVerificationFromReportFn } = {}) {
  const base = autoIntegrationVerificationFromReportFn(taskResult.auto_integration_completion);
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

export async function runTaskCompletionVerification({
  taskStatus,
  taskResult = {},
  resultJsonForVerification,
  resultJsonPath,
  task,
  goal,
  verifierRepoPath,
  config,
  verifyTaskCompletionFn,
  autoIntegrationVerificationFromReportFn,
} = {}) {
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
      ? autoIntegrationClosureVerification({ taskResult, fallbackVerification: verification, autoIntegrationVerificationFromReportFn })
      : null;
    if (closureVerification) {
      verification = closureVerification;
      taskResult.verification = closureVerification;
      taskResult.contract_verification = closureVerification.contract_verification;
    } else {
      taskResult.verification = taskResult.verification || autoIntegrationVerificationFromReportFn(taskResult.auto_integration_completion);
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

  return { taskStatus, taskResult, verification };
}

export function contractForClosure({ goal, taskResult } = {}) {
  return goal?.acceptance_contract || taskResult?.acceptance_contract || null;
}

export function resultForClosure({ taskStatus, taskResult = {}, verification = null } = {}) {
  return {
    ...taskResult,
    status: taskStatus,
    verification: taskResult.verification || verification || null,
    contract_verification: taskResult.contract_verification || verification?.contract_verification || null,
  };
}

export function createdFollowupFromTaskResult(taskResult = {}) {
  if (!taskResult.repair_goal_id && !taskResult.repair_task_id) return null;
  return {
    goal: taskResult.repair_goal_id ? { id: taskResult.repair_goal_id } : null,
    task: taskResult.repair_task_id ? { id: taskResult.repair_task_id } : null,
  };
}

export async function runTaskClosureReview({
  taskStatus,
  taskResult = {},
  task,
  goal,
  store,
  config = {},
  resolvedRepo,
  verifierRepoPath,
  resultJsonPath,
  verification,
  runAcceptanceGateFn,
  decideTaskClosureFn,
  finalizeAcceptanceRepairCreationFn,
  shouldAttemptRepairFn,
  createRepairGoalFromFindingsFn,
  createGoalFn,
  planFollowupTasksFn,
  planUnacceptedTaskFollowupFn,
  applyClosureDecisionToTaskResultFn,
} = {}) {
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
  const closureDecision = acceptanceGate?.closure_decision || decideTaskClosureFn({
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
  const acceptanceRepair = await finalizeAcceptanceRepairCreationFn({
    closureDecision,
    taskResult,
    task,
    goal,
    store,
    config,
    resolvedRepo,
    shouldAttemptRepairFn,
    createRepairGoalFromFindingsFn,
    createGoalFn,
  });
  taskResult = acceptanceRepair.taskResult;
  const plannedFollowups = planFollowupTasksFn({
    task,
    goal,
    result: taskResult,
    contractVerification: taskResult.contract_verification || verification.contract_verification || null,
    closureDecision,
  });
  const unacceptedFollowup = planUnacceptedTaskFollowupFn({
    task,
    goal,
    result: taskResult,
    closureDecision,
    acceptanceGate,
    created: createdFollowupFromTaskResult(taskResult),
  });
  if (unacceptedFollowup) taskResult.followup_processing = unacceptedFollowup;
  const closureApplied = applyClosureDecisionToTaskResultFn({
    taskStatus,
    taskResult,
    closureDecision,
    plannedFollowups,
    config,
  });
  return { taskStatus: closureApplied.taskStatus, taskResult: closureApplied.taskResult, verification, acceptanceGate, closureDecision };
}

export async function runCompletedTaskVerificationPipeline({
  taskStatus,
  taskResult = {},
  summary = "",
  resultJsonForVerification,
  resultJsonPath,
  task,
  goal,
  store,
  config = {},
  resolvedRepo,
  verifierRepoPath,
  verifyTaskCompletionFn,
  autoIntegrationVerificationFromReportFn,
  mkdirFn,
  writeFileFn,
  classifyTaskFailureFn,
  finalizeVerificationRepairAttemptFn,
  canRetryTaskFn,
  scheduleRepairAttemptFn,
  createGoalFn,
  runTaskClosureReviewFn = runTaskClosureReview,
  runAcceptanceGateFn,
  decideTaskClosureFn,
  finalizeAcceptanceRepairCreationFn,
  shouldAttemptRepairFn,
  createRepairGoalFromFindingsFn,
  planFollowupTasksFn,
  planUnacceptedTaskFollowupFn,
  applyClosureDecisionToTaskResultFn,
} = {}) {
  if (taskStatus !== "completed") return { taskStatus, taskResult, verification: null };

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
    autoIntegrationVerificationFromReportFn,
  });
  taskStatus = completionVerification.taskStatus;
  taskResult = completionVerification.taskResult;
  let verification = completionVerification.verification;

  if (resultJsonPath) {
    const verificationPath = join(dirname(resultJsonPath), "verification.json");
    await mkdirFn(dirname(verificationPath), { recursive: true }).catch(() => {});
    await writeFileFn(verificationPath, JSON.stringify(verification, null, 2) + "\n", "utf8").catch(() => {});
  }
  if (verification.passed !== true) {
    const failure = classifyTaskFailureFn({ task, codexResult: taskResult, verification });
    const repairAttempt = await finalizeVerificationRepairAttemptFn({
      taskStatus,
      taskResult,
      task,
      goal,
      store,
      config,
      resolvedRepo,
      failure,
      verification,
      canRetryTaskFn,
      scheduleRepairAttemptFn,
      createGoalFn,
    });
    taskStatus = repairAttempt.taskStatus;
    taskResult = repairAttempt.taskResult;
    verification = repairAttempt.verification;
    taskResult.summary = taskResult.summary || summary || "Task requires review after verification failed.";
  }

  const closureReview = await runTaskClosureReviewFn({
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
    decideTaskClosureFn,
    finalizeAcceptanceRepairCreationFn,
    shouldAttemptRepairFn,
    createRepairGoalFromFindingsFn,
    createGoalFn,
    planFollowupTasksFn,
    planUnacceptedTaskFollowupFn,
    applyClosureDecisionToTaskResultFn,
  });
  return {
    taskStatus: closureReview.taskStatus,
    taskResult: closureReview.taskResult,
    verification: closureReview.verification,
    acceptanceGate: closureReview.acceptanceGate,
    closureDecision: closureReview.closureDecision,
  };
}

export async function runTaskFinalizerOrchestration({
  taskStatus,
  taskResult,
  summary,
  deliveryResultRecovery = null,
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
} = {}) {
  const integrationFinalization = await finalizeWaitingForIntegration({
    taskStatus,
    taskResult,
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

  return applyVerifiedDeliveryResultRecovery({
    taskStatus: integrationFinalization.taskStatus,
    taskResult: integrationFinalization.taskResult,
    summary,
    deliveryResultRecovery,
  });
}
