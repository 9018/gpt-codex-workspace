import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFailedIntegrationCompletion,
  applySuccessfulIntegrationCompletion,
  classifyFinalizationIntegrationResult,
  finalizeWaitingForIntegration,
} from "../../src/task-finalization/integration-finalizer.mjs";

test("classifyFinalizationIntegrationResult exposes terminal and repairable integration decisions", () => {
  assert.deepEqual(classifyFinalizationIntegrationResult({ ok: true, status: "merged", merged: true }), {
    kind: "terminal_completed",
    task_status: "completed",
    should_attempt_auto_completion: false,
    should_attempt_repair: false,
  });
  assert.deepEqual(classifyFinalizationIntegrationResult({ ok: false, status: "conflict" }), {
    kind: "repairable_failure",
    task_status: null,
    should_attempt_auto_completion: false,
    should_attempt_repair: true,
  });
});

test("integration completion helpers preserve finalizer-facing task result shape", () => {
  const successful = applySuccessfulIntegrationCompletion({
    taskResult: { commit: "task-commit", acceptance_findings: [] },
    integrationResult: { status: "branch_pushed", commit: "branch-commit" },
    autoCompletion: { completed: true, commit: "merged-commit", verification_report: { passed: true } },
  });

  assert.equal(successful.integration.status, "merged");
  assert.equal(successful.integration.auto_completed, true);
  assert.equal(successful.commit, "merged-commit");
  assert.equal(successful.needs_integration, false);

  const failed = applyFailedIntegrationCompletion({
    taskResult: { acceptance_findings: [] },
    autoCompletion: { reason: "dirty", blockers: [{ message: "repo dirty" }] },
  });

  assert.equal(failed.requires_review, true);
  assert.match(failed.reason, /auto_integration_completion_failed/);
  assert.equal(failed.acceptance_findings[0].code, "auto_integration_completion_failed");
});

test("finalizeWaitingForIntegration creates repair goal for repairable integration failure", async () => {
  let createdPayload = null;
  const task = {
    id: "task_integration_boundary",
    title: "Integration boundary",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
  };
  const goal = { id: "goal_integration_boundary", workspace_id: "hosted-default" };
  const result = await finalizeWaitingForIntegration({
    taskStatus: "waiting_for_integration",
    taskResult: { summary: "ready" },
    task,
    goal,
    store: { state: { tasks: [task] } },
    config: { defaultBranch: "main", integrationMode: "push_branch", maxRepairAttempts: 2 },
    resolvedRepo: {
      repo_id: "github.com/acme/repo",
      canonical_repo_path: "/tmp/canonical",
      task_worktree_path: "/tmp/worktree",
      worktree_lifecycle: { branch_name: "gptwork/task/boundary" },
    },
    runIntegrationQueueFn: async () => ({
      ok: false,
      status: "conflict",
      error: "merge conflict",
      conflict_files: ["src/app.mjs"],
    }),
    shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "attempt allowed" }),
    createRepairGoalFromFindingsFn: async ({ task: repairTask, findings }) => ({
      repair_attempt: 1,
      user_request: "Repair integration",
      goal_prompt: "Fix conflict",
      workspace_id: repairTask.workspace_id,
      mode: repairTask.mode,
      parent_task_id: repairTask.id,
      repair_of_task_id: repairTask.id,
      findings,
    }),
    createGoalFn: async (_store, _config, payload) => {
      createdPayload = payload;
      return { goal: { id: "goal_repair_boundary" }, task: { id: "task_repair_boundary" } };
    },
  });

  assert.equal(result.taskStatus, "waiting_for_repair");
  assert.equal(result.taskResult.repair_goal_id, "goal_repair_boundary");
  assert.equal(result.taskResult.repair_task_id, "task_repair_boundary");
  assert.equal(result.taskResult.integration.status, "conflict");
  assert.equal(createdPayload.repair_of_task_id, "task_integration_boundary");
});
