import test from "node:test";
import assert from "node:assert/strict";

import { determineGoalStatus, convergeStaleGoalStatuses } from "../src/goal-convergence.mjs";

test("determineGoalStatus does not complete a completed task that lacks acceptance evidence", () => {
  const status = determineGoalStatus(
    { id: "goal_missing_evidence", status: "running" },
    { id: "task_missing_evidence", status: "completed" },
    { status: "completed", summary: "done", changed_files: ["backend/src/app.mjs"] },
  );

  assert.equal(status, "waiting_for_review");
});

test("determineGoalStatus completes a verified accepted code-change task", () => {
  const status = determineGoalStatus(
    { id: "goal_code_success", status: "running" },
    { id: "task_code_success", status: "completed" },
    {
      status: "completed",
      changed_files: ["backend/src/app.mjs"],
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
      convergence: { nextStatus: "completed", profile: "code_change" },
    },
  );

  assert.equal(status, "completed");
});

test("determineGoalStatus completes verified admin restart evidence without worktree", () => {
  const head = "88546312e483f2ce4a338ae0486e31c9bc4dd739";
  const status = determineGoalStatus(
    { id: "goal_admin_restart", status: "assigned" },
    { id: "task_admin_restart", status: "completed", mode: "admin" },
    {
      status: "completed",
      kind: "admin_restart_verified",
      changed_files: [],
      commit: head,
      local_head: head,
      running_commit: head,
      restart_required: false,
      verification: {
        passed: true,
        commands: [{ cmd: "safe_restart_phase_c_verify", exit_code: 0 }],
      },
      acceptance_findings: [],
      convergence: { nextStatus: "completed", profile: "admin_restart" },
    },
  );

  assert.equal(status, "completed");
});

test("determineGoalStatus keeps admin restart without verification in review", () => {
  const status = determineGoalStatus(
    { id: "goal_admin_restart_missing", status: "assigned" },
    { id: "task_admin_restart_missing", status: "completed", mode: "admin" },
    {
      status: "completed",
      kind: "admin_restart_verified",
      changed_files: [],
      restart_required: false,
      acceptance_findings: [],
      convergence: { nextStatus: "completed", profile: "admin_restart" },
    },
  );

  assert.equal(status, "waiting_for_review");
});

test("determineGoalStatus treats changed_files_mismatch as blocker for code_change", () => {
  const status = determineGoalStatus(
    { id: "goal_mismatch", status: "running" },
    { id: "task_mismatch", status: "completed" },
    {
      status: "completed",
      changed_files: [],
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [{ severity: "major", code: "changed_files_mismatch", message: "real diff omitted" }],
      convergence: { nextStatus: "completed", profile: "code_change" },
    },
  );

  assert.equal(status, "waiting_for_repair");
});

test("determineGoalStatus treats tests_missing as blocker for implementation/code_change", () => {
  const status = determineGoalStatus(
    { id: "goal_tests_missing", status: "running" },
    { id: "task_tests_missing", status: "completed" },
    {
      status: "completed",
      changed_files: ["backend/src/app.mjs"],
      verification: { passed: true, commands: [] },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [{ severity: "major", code: "tests_missing", message: "tests missing" }],
      convergence: { nextStatus: "completed", profile: "implementation" },
    },
  );

  assert.equal(status, "waiting_for_repair");
});

test("determineGoalStatus allows tests_missing and changed_files_mismatch for sync/noop profiles", () => {
  for (const profile of ["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop", "network_retry"]) {
    const status = determineGoalStatus(
      { id: `goal_${profile}`, status: "running" },
      { id: `task_${profile}`, status: "completed", mode: "sync" },
      {
        status: "completed",
        changed_files: [],
        verification: { passed: true, commands: [] },
        acceptance_findings: [
          { severity: "major", code: "tests_missing", message: "not required" },
          { severity: "major", code: "changed_files_mismatch", message: "remote already aligned" },
        ],
        convergence: { nextStatus: "completed", profile },
      },
    );

    assert.equal(status, "completed", profile);
  }
});

test("determineGoalStatus maps terminal exhausted no-result to failed without review", () => {
  const status = determineGoalStatus(
    { id: "goal_no_result", status: "waiting_for_repair" },
    { id: "task_no_result", status: "failed", repair_attempt: 2, max_attempts: 2 },
    { failure_class: "result_missing", repair_plan: { exhausted: true } },
  );

  assert.equal(status, "failed");
});

test("convergeStaleGoalStatuses is idempotent and records one activity", async () => {
  let saveCount = 0;
  const state = {
    goals: [{ id: "goal_stale", task_id: "task_stale", status: "running", title: "Goal" }],
    tasks: [{
      id: "task_stale",
      status: "completed",
      result: {
        status: "completed",
        changed_files: [],
        verification: { passed: true, commands: [] },
        reviewer_decision: { status: "accepted", passed: true },
        acceptance_findings: [],
        convergence: { nextStatus: "completed", profile: "sync_only" },
      },
    }],
    activities: [],
  };
  const store = {
    load: async () => state,
    save: async () => { saveCount += 1; },
  };

  const first = await convergeStaleGoalStatuses(store);
  const second = await convergeStaleGoalStatuses(store);

  assert.equal(state.goals[0].status, "completed");
  assert.equal(saveCount, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(state.activities.filter((item) => item.type === "goal.completed").length, 1);
});

test("convergeStaleGoalStatuses completes old waiting review goal when completed successor has evidence", async () => {
  let saveCount = 0;
  const state = {
    goals: [
      { id: "goal_legacy_zvec", task_id: "task_legacy_zvec", status: "waiting_for_review", title: "Old zvec repair" },
      { id: "goal_successor_zvec", task_id: "task_successor_zvec", status: "completed", title: "New zvec delivery" },
    ],
    tasks: [
      {
        id: "task_legacy_zvec",
        goal_id: "goal_legacy_zvec",
        status: "waiting_for_review",
        title: "Legacy failed zvec noop repair",
        result: {
          status: "failed",
          summary: "Legacy zvec repair did not land",
          failure_class: "noop_repair",
          acceptance_findings: [{ severity: "major", code: "tests_missing", message: "old missing tests" }],
        },
      },
      {
        id: "task_successor_zvec",
        goal_id: "goal_successor_zvec",
        root_task_id: "task_legacy_zvec",
        repair_of_task_id: "task_legacy_zvec",
        status: "completed",
        title: "Completed zvec delivery",
        result: {
          status: "completed",
          summary: "Integrated zvec bounded context fix",
          changed_files: ["backend/src/context-index/zvec-store.mjs"],
          commit: "4ad576495f4101e39955ea7e4028da3c3d15b4d4",
          verification: { passed: true, commands: [{ cmd: "node --test backend/test/context-index.test.mjs", exit_code: 0 }] },
          reviewer_decision: { status: "accepted", passed: true },
          acceptance_findings: [],
          convergence: { nextStatus: "completed", profile: "code_change" },
        },
      },
    ],
    activities: [],
  };
  const store = {
    load: async () => state,
    save: async () => { saveCount += 1; },
  };

  const first = await convergeStaleGoalStatuses(store);
  const second = await convergeStaleGoalStatuses(store);

  const legacyGoal = state.goals.find((goal) => goal.id === "goal_legacy_zvec");
  const legacyTask = state.tasks.find((task) => task.id === "task_legacy_zvec");
  assert.equal(legacyGoal.status, "completed");
  assert.equal(legacyGoal.resolved_by.task_id, "task_successor_zvec");
  assert.equal(legacyGoal.resolved_by.commit, "4ad576495f4101e39955ea7e4028da3c3d15b4d4");
  assert.equal(legacyGoal.superseded_by.task_id, "task_successor_zvec");
  assert.equal(legacyTask.result.resolved_by_task_id, "task_successor_zvec");
  assert.equal(legacyTask.result.superseded_by_task_id, "task_successor_zvec");
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(saveCount, 1);
});
