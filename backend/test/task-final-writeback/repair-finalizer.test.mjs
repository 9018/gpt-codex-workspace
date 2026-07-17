import test from "node:test";
import assert from "node:assert/strict";

import {
  applyNoChangeRepairCompletionSummary,
  finalizeAcceptanceRepairCreation,
} from "../../src/task-finalization/repair-finalizer.mjs";

test("applyNoChangeRepairCompletionSummary annotates eligible no-change repair completion", () => {
  const taskResult = applyNoChangeRepairCompletionSummary({
    task: { id: "repair_task", parent_task_id: "parent_task", title: "Repair existing state" },
    taskResult: {
      kind: "repair_noop",
      repair_noop: true,
      changed_files: [],
      verification: { passed: true },
      acceptance_gate: { passed: true },
      integration: { status: "not_required" },
      no_change_repair_evidence: {
        affected_files: ["backend/src/task-final-writeback.mjs"],
        files_match_canonical: true,
        diff_empty: true,
      },
    },
  });

  assert.equal(taskResult.no_change_repair_completion.completion_eligible, true);
  assert.equal(taskResult.no_change_repair_completion_summary.changed_files_empty_acceptable, true);
  assert.equal(taskResult.no_change_repair_completion_summary.reason, "no_change_repair_evidence_satisfied");
  assert.match(taskResult.no_change_repair_completion_summary.explanation, /changed_files=\[\] is acceptable/);
});

test("applyNoChangeRepairCompletionSummary leaves non-repair results unchanged", () => {
  const taskResult = { changed_files: ["backend/src/app.mjs"], summary: "normal change" };

  assert.equal(applyNoChangeRepairCompletionSummary({ task: { id: "task" }, taskResult }), taskResult);
});

test("finalizeAcceptanceRepairCreation creates repair goal for repairable acceptance blockers", async () => {
  let createdPayload = null;
  const task = {
    id: "task_acceptance_repair_boundary",
    title: "Acceptance repair boundary",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
  };
  const goal = { id: "goal_acceptance_repair_boundary", workspace_id: "hosted-default" };
  const closureDecision = {
    status: "waiting_for_repair",
    reason: "acceptance_blocker",
    repairable_blockers: [{ code: "missing_test", message: "Add regression test" }],
  };
  const taskResult = {};

  const result = await finalizeAcceptanceRepairCreation({
    closureDecision,
    taskResult,
    task,
    goal,
    store: { state: { tasks: [task] } },
    config: { maxRepairAttempts: 2 },
    resolvedRepo: { repo_id: "github.com/acme/repo", task_worktree_path: "/tmp/worktree" },
    shouldAttemptRepairFn: async () => ({ should_repair: true, reason: "attempt allowed" }),
    createRepairGoalFromFindingsFn: async ({ task: repairTask, findings, repairProposals }) => ({
      user_request: "Repair acceptance",
      goal_prompt: "Fix acceptance blockers",
      workspace_id: repairTask.workspace_id,
      mode: repairTask.mode,
      repair_attempt: 1,
      attempt: 1,
      repair_of_attempt: 0,
      repair_of_task_id: repairTask.id,
      findings,
      repairProposals,
    }),
    createGoalFn: async (_store, _config, payload) => {
      createdPayload = payload;
      return { goal: { id: "goal_acceptance_repair_created" }, task: { id: "task_acceptance_repair_created" } };
    },
  });

  assert.equal(result.taskResult.repair_goal_id, "goal_acceptance_repair_created");
  assert.equal(result.taskResult.repair_task_id, "task_acceptance_repair_created");
  assert.equal(result.taskResult.failure_class, "missing_test");
  assert.equal(result.closureDecision.status, "waiting_for_repair");
  assert.equal(createdPayload.repair_of_task_id, "task_acceptance_repair_boundary");
});
