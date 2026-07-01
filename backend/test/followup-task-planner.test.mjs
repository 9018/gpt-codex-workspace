import test from "node:test";
import assert from "node:assert/strict";

import { planFollowupTasks, planUnacceptedTaskFollowup } from "../src/closure/followup-task-planner.mjs";

test("planFollowupTasks turns quality notes into non-enqueued next_tasks", () => {
  const tasks = planFollowupTasks({
    task: { id: "task_quality", title: "Implement closure" },
    goal: { id: "goal_quality" },
    result: {},
    contractVerification: { non_blocking_followups: [], quality_notes: ["Add broader fixture coverage."] },
    closureDecision: {
      status: "auto_completed_with_followups",
      quality_notes: ["Add broader fixture coverage."],
      non_blocking_followups: [],
    },
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].severity, "non_blocking");
  assert.equal(tasks[0].source_task_id, "task_quality");
  assert.equal(tasks[0].auto_enqueue, false);
  assert.match(tasks[0].title, /P1/);
  assert.match(tasks[0].reason, /blocking gate passed/i);
});

test("planFollowupTasks preserves explicit non-blocking followup title and reason", () => {
  const tasks = planFollowupTasks({
    task: { id: "task_followup", title: "Implement closure" },
    goal: { id: "goal_followup" },
    result: {},
    contractVerification: {},
    closureDecision: {
      status: "auto_completed_with_followups",
      non_blocking_followups: [{ title: "Add trace metric", reason: "Useful but not blocking", severity: "non_blocking" }],
      quality_notes: [],
    },
  });

  assert.deepEqual(tasks, [{
    title: "Add trace metric",
    reason: "Useful but not blocking",
    severity: "non_blocking",
    source_task_id: "task_followup",
    source_goal_id: "goal_followup",
    source: "closure_decision",
    auto_enqueue: false,
  }]);
});

test("planFollowupTasks returns no tasks for clean or blocking closure", () => {
  assert.deepEqual(planFollowupTasks({
    task: { id: "task_clean" },
    closureDecision: { status: "auto_completed_clean", non_blocking_followups: [], quality_notes: [] },
  }), []);

  assert.deepEqual(planFollowupTasks({
    task: { id: "task_blocked" },
    closureDecision: { status: "requires_review", non_blocking_followups: [{ title: "Later" }], quality_notes: ["Later"] },
  }), []);
});

test("planUnacceptedTaskFollowup traces source task, goal, attempt, and blocking result", () => {
  const planned = planUnacceptedTaskFollowup({
    task: { id: "task_parent", title: "Implement G6", repair_attempt: 1, root_task_id: "task_root" },
    goal: { id: "goal_parent" },
    result: { summary: "Tests failed", failure_class: "test_failed" },
    closureDecision: {
      status: "waiting_for_repair",
      reason: "verification_failed",
      repairable_blockers: [{ code: "verification_not_passed", message: "npm test failed", source: "task_verifier" }],
    },
    acceptanceGate: { status: "needs_action", passed: false },
    created: { goal: { id: "goal_repair" }, task: { id: "task_repair" } },
  });

  assert.equal(planned.kind, "unaccepted_task_followup");
  assert.equal(planned.source_task_id, "task_parent");
  assert.equal(planned.root_task_id, "task_root");
  assert.equal(planned.source_goal_id, "goal_parent");
  assert.equal(planned.followup_goal_id, "goal_repair");
  assert.equal(planned.followup_task_id, "task_repair");
  assert.equal(planned.handling_attempt, 2);
  assert.equal(planned.handling_result.status, "waiting_for_repair");
  assert.equal(planned.handling_result.reason, "verification_failed");
  assert.equal(planned.handling_result.failure_class, "test_failed");
  assert.equal(planned.blockers[0].code, "verification_not_passed");
  assert.equal(planned.auto_enqueue, true);
});

test("planUnacceptedTaskFollowup returns null for accepted closure", () => {
  assert.equal(planUnacceptedTaskFollowup({
    task: { id: "task_done" },
    goal: { id: "goal_done" },
    closureDecision: { status: "auto_completed_clean", reason: "blocking_gate_passed_clean" },
    acceptanceGate: { status: "passed", passed: true },
  }), null);
});
