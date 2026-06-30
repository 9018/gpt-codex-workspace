import test from "node:test";
import assert from "node:assert/strict";

import { planFollowupTasks } from "../src/closure/followup-task-planner.mjs";

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

