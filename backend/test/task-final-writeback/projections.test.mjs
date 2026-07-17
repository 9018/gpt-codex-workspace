import test from "node:test";
import assert from "node:assert/strict";

import { applyTaskStateProjection } from "../../src/task-finalization/task-state-projection.mjs";
import { projectGoalStatusForFinalizedTask } from "../../src/task-finalization/goal-state-projection.mjs";

test("applyTaskStateProjection records canonical task result and worktree shape", () => {
  const task = { id: "task_projection", logs: [], worktree: { branch: "existing" } };
  const doneAt = "2026-07-17T10:00:00.000Z";

  applyTaskStateProjection(task, {
    taskStatus: "completed",
    doneAt,
    cr: {},
    config: { codexExecTimeout: 900 },
    taskResult: {
      kind: "codex_executed",
      summary: "done",
      repo_resolution: {
        task_worktree_path: "/repo/.worktrees/task_projection",
        worktree_lifecycle: {
          mode: "git_worktree",
          ok: true,
          branch_name: "gptwork/task/projection",
          head_sha: "abc123",
        },
      },
      delivery_result_recovery: { attempted: true, recovered: true, eligible: true, commit: "abc123" },
      auto_integration_completion: { attempted: true, completed: false, reason: "dirty" },
      failure_class: "none",
      repair_of_attempt: 0,
    },
  });

  assert.equal(task.status, "completed");
  assert.equal(task.execution_mode, "worktree");
  assert.equal(task.worktree.path, "/repo/.worktrees/task_projection");
  assert.equal(task.worktree.branch, "gptwork/task/projection");
  assert.equal(task.worktree.head_sha, "abc123");
  assert.equal(task.result.completed_at, doneAt);
  assert.match(task.logs.map((entry) => entry.message).join("\n"), /delivery recovery attempted/);
  assert.match(task.logs.map((entry) => entry.message).join("\n"), /auto integration completion failed/);
});

test("projectGoalStatusForFinalizedTask keeps failed running queue tasks repairable", () => {
  const goal = { id: "goal_projection", status: "running" };
  const task = {
    id: "task_projection_failed",
    goal_id: goal.id,
    status: "failed",
    result: { failure_class: "verification_failed" },
  };
  const state = {
    goal_queue: [{ task_id: task.id, status: "running" }],
  };

  const goalStatus = projectGoalStatusForFinalizedTask({
    goal,
    task,
    taskStatus: "failed",
    taskResult: task.result,
    state,
  });

  assert.equal(goalStatus, "waiting_for_repair");
});
