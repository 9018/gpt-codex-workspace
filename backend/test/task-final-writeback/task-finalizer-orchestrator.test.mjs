import test from "node:test";
import assert from "node:assert/strict";

import {
  runCompletedTaskFinalizationStage,
  runFinalDecisionReconciliation,
  runCompletedTaskVerificationPipeline,
  runTaskClosureReview,
  runTaskCompletionVerification,
  runTaskFinalizerOrchestration,
} from "../../src/task-finalization/task-finalizer-orchestrator.mjs";

test("runCompletedTaskFinalizationStage attaches integrated proof and runs completed verification", async () => {
  const calls = [];
  const result = await runCompletedTaskFinalizationStage({
    taskStatus: "completed",
    taskResult: {
      execution_cwd: "/repo/worktree",
      auto_integration_completion: { completed: true },
    },
    summary: "done",
    resultJsonPath: "/workspace/.gptwork/goals/goal_stage/result.json",
    task: { id: "task_stage" },
    goal: { id: "goal_stage" },
    store: { state: {} },
    config: { defaultRepoPath: "/repo/default" },
    workspace: { root: "/workspace" },
    resolvedRepo: {
      canonical_repo_path: "/repo/main",
      task_worktree_path: "/repo/worktree",
    },
    attachAlreadyIntegratedCommitEvidenceFn: ({ taskResult, candidatePaths }) => {
      calls.push(["attach", candidatePaths]);
      return { ...taskResult, attached: true };
    },
    buildFallbackResultJsonFn: ({ taskStatus, taskResult, summary }) => {
      calls.push(["fallback", taskStatus, taskResult.attached, summary]);
      return { taskStatus, taskResult, summary };
    },
    runCompletedTaskVerificationPipelineFn: async ({ taskStatus, taskResult, verifierRepoPath, resultJsonForVerification }) => {
      calls.push(["pipeline", taskStatus, verifierRepoPath, resultJsonForVerification.taskResult.attached]);
      return {
        taskStatus: "waiting_for_review",
        taskResult: { ...taskResult, verified: true },
      };
    },
  });

  assert.equal(result.taskStatus, "waiting_for_review");
  assert.equal(result.taskResult.attached, true);
  assert.equal(result.taskResult.verified, true);
  assert.equal(result.verifierRepoPath, "/repo/main");
  assert.deepEqual(calls, [
    ["attach", ["/repo/main", "/repo/main", "/workspace", "/repo/default", undefined]],
    ["fallback", "completed", true, "done"],
    ["pipeline", "completed", "/repo/main", true],
  ]);
});

test("runFinalDecisionReconciliation annotates closure, applies final decision, and builds continuation", () => {
  const calls = [];
  const result = runFinalDecisionReconciliation({
    taskStatus: "completed",
    taskResult: { summary: "done" },
    task: { id: "task_decision" },
    goal: { id: "goal_decision" },
    config: { defaultBranch: "main" },
    resolvedRepo: { task_worktree_path: "/repo/.worktrees/task_decision" },
    classifyClosureFn: (taskResult, task) => {
      calls.push(["classify", task.id, taskResult.summary]);
      return {
        taskType: { type: "feature" },
        closurePath: { path: "accepted" },
        summary: "closure summary",
        needsRestartCheck: false,
        needsIntegration: true,
      };
    },
    applyNoChangeRepairCompletionSummaryFn: ({ taskResult }) => {
      calls.push(["no_change", taskResult.closure_type]);
      return { ...taskResult, no_change_checked: true };
    },
    normalizeCompletedDeliveryStateFn: ({ taskStatus, taskResult }) => {
      calls.push(["normalize", taskStatus]);
      return { ...taskResult, normalized: true };
    },
    attachResolvedWorktreeEvidenceFn: (taskResult, resolvedRepo) => {
      calls.push(["worktree", resolvedRepo.task_worktree_path]);
      return { ...taskResult, worktree_path: resolvedRepo.task_worktree_path };
    },
    assertValidInputUnifiedDecisionFn: (taskResult) => {
      calls.push(["validate", taskResult.normalized]);
    },
    collectTaskFinalizerEvidenceFn: ({ taskStatus, taskResult }) => {
      calls.push(["facts", taskStatus]);
      return { current_status: taskStatus, codex_result: taskResult };
    },
    decideTaskFinalizationFn: (facts) => {
      calls.push(["decide", facts.current_status]);
      return { status: "completed", reason: "terminal_evidence_satisfied" };
    },
    applyTaskFinalStateDecisionFn: ({ taskStatus, taskResult, finalizerDecision }) => {
      calls.push(["apply", finalizerDecision.reason]);
      return {
        taskStatus,
        taskResult: { ...taskResult, finalizer_decision: finalizerDecision },
      };
    },
    reconcileTaskClosureFn: ({ taskStatus, taskResult }) => {
      calls.push(["reconcile", taskResult.finalizer_decision.status]);
      return {
        reconciled: true,
        taskStatus,
        taskResult: { ...taskResult, reconciled_marker: true },
        reason: "canonical_completion",
      };
    },
    continueOnCompletedOutcomeFn: ({ taskResult, task, goal }) => {
      calls.push(["continue", task.id, goal.id, taskResult.reconciled_marker]);
      return { goalStatus: "completed", advanceQueue: true };
    },
  });

  assert.equal(result.taskStatus, "completed");
  assert.equal(result.taskResult.closure_type, "feature");
  assert.equal(result.taskResult.closure_path, "accepted");
  assert.equal(result.taskResult.closure_summary, "closure summary");
  assert.equal(result.taskResult.needs_restart_check, false);
  assert.equal(result.taskResult.needs_integration, true);
  assert.equal(result.taskResult.no_change_checked, true);
  assert.equal(result.taskResult.normalized, true);
  assert.equal(result.taskResult.worktree_path, "/repo/.worktrees/task_decision");
  assert.equal(result.taskResult.reconciled_at.length > 0, true);
  assert.equal(result.taskResult.reconciliation_reason, "canonical_completion");
  assert.deepEqual(result.taskResult.warnings, ["Reconciled: canonical_completion"]);
  assert.equal(result.finalizerDecision.reason, "terminal_evidence_satisfied");
  assert.equal(result.reconciliationResult.reconciled, true);
  assert.deepEqual(result.continuationFlow, { goalStatus: "completed", advanceQueue: true });
  assert.deepEqual(calls.map((call) => call[0]), [
    "classify",
    "no_change",
    "normalize",
    "worktree",
    "validate",
    "facts",
    "decide",
    "apply",
    "reconcile",
    "continue",
  ]);
});

test("runTaskFinalizerOrchestration sequences integration finalization before delivery recovery", async () => {
  const result = await runTaskFinalizerOrchestration({
    taskStatus: "waiting_for_integration",
    taskResult: {
      summary: "missing result",
      delivery_result_recovery: {
        canonical_clean: true,
        commit_integrated: true,
        commit: "abc123",
        local_head: "abc123",
        remote_head: "abc123",
        changed_files: ["src/app.mjs"],
        verification: {
          passed: true,
          commands: [{ command: "npm test", exit_code: 0 }],
        },
      },
    },
    summary: "fallback summary",
    task: { id: "task_orchestrator", title: "Orchestrate finalizer" },
    goal: { id: "goal_orchestrator" },
    store: { state: { tasks: [] } },
    config: { defaultBranch: "main" },
    resolvedRepo: {
      repo_id: "github.com/acme/repo",
      canonical_repo_path: "/repo/main",
      task_worktree_path: "/repo/.worktrees/task_orchestrator",
      worktree_lifecycle: { branch_name: "gptwork/task/orchestrator" },
    },
    runIntegrationQueueFn: async () => ({ ok: true, status: "merged", merged: true }),
  });

  assert.equal(result.taskStatus, "completed");
  assert.equal(result.taskResult.kind, "codex_executed");
  assert.equal(result.taskResult.integration.status, "merged");
  assert.equal(result.taskResult.delivery_result_recovery.passed, true);
  assert.equal(result.taskResult.commit, "abc123");
});

test("runTaskCompletionVerification captures verifier errors and merges findings", async () => {
  const result = await runTaskCompletionVerification({
    taskStatus: "completed",
    taskResult: { summary: "done", acceptance_findings: [{ code: "existing", message: "keep" }] },
    summary: "done",
    task: { id: "task_verify" },
    goal: { id: "goal_verify" },
    verifierRepoPath: "/repo/main",
    resultJsonPath: "/tmp/result.json",
    config: {},
    verifyTaskCompletionFn: async () => {
      throw new Error("verifier exploded");
    },
  });

  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.failure_class, "verifier_error");
  assert.equal(result.taskResult.verification.failure_class, "verifier_error");
  assert.equal(result.taskResult.failure_class, "verifier_error");
  assert.equal(result.taskResult.acceptance_findings.length, 2);
  assert.equal(result.taskResult.acceptance_findings[1].code, "verifier_error");
});

test("runTaskClosureReview applies acceptance gate closure and planned followups", async () => {
  const closureDecision = {
    status: "auto_completed_with_followups",
    task_status: "completed",
    reason: "non_blocking_followup",
  };
  const result = await runTaskClosureReview({
    taskStatus: "completed",
    taskResult: { summary: "done", acceptance_findings: [] },
    task: { id: "task_closure", title: "Closure helper" },
    goal: { id: "goal_closure", acceptance_contract: { id: "contract_closure" } },
    store: { state: { tasks: [] } },
    config: {},
    verifierRepoPath: "/repo/main",
    resultJsonPath: "/tmp/result.json",
    verification: { passed: true, contract_verification: { blocking_passed: true } },
    runAcceptanceGateFn: async () => ({
      closure_decision: closureDecision,
      contract_verification: { blocking_passed: true, non_blocking_followups: [{ code: "docs" }] },
      artifacts: { acceptance_json: "/tmp/acceptance.json" },
    }),
    finalizeAcceptanceRepairCreationFn: async ({ taskResult }) => ({ taskResult }),
    planFollowupTasksFn: () => [{ title: "Write docs" }],
    planUnacceptedTaskFollowupFn: () => ({ status: "queued" }),
    applyClosureDecisionToTaskResultFn: ({ taskStatus, taskResult, plannedFollowups }) => ({
      taskStatus,
      taskResult: { ...taskResult, closure_decision: closureDecision, followups: plannedFollowups },
    }),
  });

  assert.equal(result.taskStatus, "completed");
  assert.equal(result.taskResult.acceptance_result_path, "/tmp/acceptance.json");
  assert.equal(result.taskResult.contract_verification.non_blocking_followups[0].code, "docs");
  assert.deepEqual(result.taskResult.followups, [{ title: "Write docs" }]);
  assert.equal(result.taskResult.followup_processing.status, "queued");
});

test("runCompletedTaskVerificationPipeline writes verification, repairs failures, and runs closure review", async () => {
  const writes = [];
  const result = await runCompletedTaskVerificationPipeline({
    taskStatus: "completed",
    taskResult: { summary: "done", acceptance_findings: [] },
    summary: "done",
    task: { id: "task_pipeline", title: "Pipeline helper" },
    goal: { id: "goal_pipeline" },
    store: { state: { tasks: [] } },
    config: {},
    resolvedRepo: { canonical_repo_path: "/repo/main" },
    verifierRepoPath: "/repo/main",
    resultJsonPath: "/workspace/.gptwork/goals/goal_pipeline/result.json",
    verifyTaskCompletionFn: async () => ({
      passed: false,
      failure_class: "tests_failed",
      findings: [{ severity: "blocker", code: "tests_failed", message: "tests failed" }],
      contract_verification: { blocking_passed: false },
    }),
    autoIntegrationVerificationFromReportFn: () => ({ passed: true, findings: [] }),
    mkdirFn: async (path) => writes.push(["mkdir", path]),
    writeFileFn: async (path, content) => writes.push(["write", path, JSON.parse(content)]),
    classifyTaskFailureFn: () => ({ failure_class: "tests_failed" }),
    finalizeVerificationRepairAttemptFn: async ({ taskStatus, taskResult, verification }) => ({
      taskStatus: "waiting_for_repair",
      taskResult: { ...taskResult, repair_task_id: "repair_pipeline" },
      verification,
    }),
    canRetryTaskFn: () => true,
    scheduleRepairAttemptFn: async () => null,
    createGoalFn: async () => null,
    runTaskClosureReviewFn: async ({ taskStatus, taskResult, verification }) => ({
      taskStatus,
      taskResult: { ...taskResult, closure_checked: true },
      verification,
    }),
    runAcceptanceGateFn: async () => null,
    decideTaskClosureFn: () => null,
    finalizeAcceptanceRepairCreationFn: async ({ taskResult }) => ({ taskResult }),
    shouldAttemptRepairFn: () => false,
    createRepairGoalFromFindingsFn: async () => null,
    planFollowupTasksFn: () => [],
    planUnacceptedTaskFollowupFn: () => null,
    applyClosureDecisionToTaskResultFn: ({ taskStatus, taskResult }) => ({ taskStatus, taskResult }),
  });

  assert.equal(result.taskStatus, "waiting_for_repair");
  assert.equal(result.taskResult.repair_task_id, "repair_pipeline");
  assert.equal(result.taskResult.closure_checked, true);
  assert.equal(result.verification.failure_class, "tests_failed");
  assert.deepEqual(writes[0], ["mkdir", "/workspace/.gptwork/goals/goal_pipeline"]);
  assert.equal(writes[1][0], "write");
  assert.equal(writes[1][1], "/workspace/.gptwork/goals/goal_pipeline/verification.json");
  assert.equal(writes[1][2].failure_class, "tests_failed");
});
