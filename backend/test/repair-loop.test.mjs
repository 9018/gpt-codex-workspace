/**
 * repair-loop.test.mjs
 * Tests for repair-loop.mjs — repair task lifecycle and attempt tracking.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRepairGoalFromFindings, shouldAttemptRepair, shouldReuseWorktreeForRepair } from "../src/repair-loop.mjs";

// ===========================================================================
// Tests for createRepairGoalFromFindings
// ===========================================================================

test("createRepairGoalFromFindings: creates repair goal with correct parent link", async () => {
  const task = { id: "task_abc", title: "Fix auth bug", root_task_id: "task_root", repair_attempt: 0 };
  const goal = { goal_prompt: "Implement authentication for the API", user_request: "Add auth support" };
  const findings = [{ severity: "blocker", code: "verification_failed", message: "Tests did not pass" }];
  const repairProposals = [{ title: "Fix tests", proposed_action: "Re-run tests after fixing" }];

  const repair = createRepairGoalFromFindings({ task, goal, findings, repairProposals });

  assert.ok(repair.id.startsWith("repair_task_root_"), "id should start with repair_<root>_<attempt>");
  assert.equal(repair.parent_task_id, "task_abc");
  assert.equal(repair.root_task_id, "task_root");
  assert.equal(repair.repair_attempt, 1);
  assert.equal(repair.reason, "Tests did not pass");
  assert.equal(repair.repair_proposals.length, 1);
  assert.equal(repair.repair_proposals[0].title, "Fix tests");
  assert.ok(repair.goal_prompt.includes("Repair Task: Fix auth bug"));
  assert.ok(repair.goal_prompt.includes("Implement authentication"));
  assert.ok(repair.goal_prompt.includes("[blocker] verification_failed"));
  assert.ok(repair.goal_prompt.includes("Re-run tests after fixing"));
  assert.equal(repair.user_request, "Repair: Fix auth bug (attempt 1)");
});

test("createRepairGoalFromFindings: repairs same root task id when no root_task_id set", async () => {
  const task = { id: "task_def", title: "Simple fix" };
  const goal = { goal_prompt: "Fix the bug" };
  const findings = [{ severity: "major", code: "worktree_dirty", message: "Worktree has dirty files" }];

  const repair = createRepairGoalFromFindings({ task, goal, findings });

  assert.equal(repair.root_task_id, "task_def", "root_task_id should default to task.id");
  assert.ok(repair.id.startsWith("repair_task_def_"));
});

test("createRepairGoalFromFindings: increments repair attempt", async () => {
  const task = { id: "task_ghi", title: "Retry fix", root_task_id: "task_root", repair_attempt: 2 };
  const goal = { goal_prompt: "Fix the bug" };
  const findings = [{ severity: "blocker", code: "test_failed", message: "Tests failed" }];

  const repair = createRepairGoalFromFindings({ task, goal, findings });

  assert.equal(repair.repair_attempt, 3);
  assert.equal(repair.user_request, "Repair: Retry fix (attempt 3)");
});

// ===========================================================================
// Tests for shouldAttemptRepair
// ===========================================================================

test("shouldAttemptRepair: first attempt under max returns true", async () => {
  const result = shouldAttemptRepair({ task: { repair_attempt: 0 }, maxAttempts: 2 });
  assert.equal(result.should_repair, true);
  assert.ok(result.reason.includes("1/2"));
});

test("shouldAttemptRepair: second attempt under max returns true", async () => {
  const result = shouldAttemptRepair({ task: { repair_attempt: 1 }, maxAttempts: 2 });
  assert.equal(result.should_repair, true);
  assert.ok(result.reason.includes("2/2"));
});

test("shouldAttemptRepair: exceeds max returns false", async () => {
  const result = shouldAttemptRepair({ task: { repair_attempt: 2 }, maxAttempts: 2 });
  assert.equal(result.should_repair, false);
  assert.ok(result.reason.includes("exceeds max"));
});

test("shouldAttemptRepair: no repair_attempt defaults to 0", async () => {
  const result = shouldAttemptRepair({ task: {}, maxAttempts: 2 });
  assert.equal(result.should_repair, true);
  assert.ok(result.reason.includes("1/2"));
});

test("shouldAttemptRepair: uses env var for max attempts when not specified", async () => {
  process.env.GPTWORK_MAX_REPAIR_ATTEMPTS = "3";
  try {
    const result = shouldAttemptRepair({ task: { repair_attempt: 2 } });
    assert.equal(result.should_repair, true);
    assert.ok(result.reason.includes("3/3"));
  } finally {
    delete process.env.GPTWORK_MAX_REPAIR_ATTEMPTS;
  }
});

// ===========================================================================
// Tests for shouldReuseWorktreeForRepair
// ===========================================================================

test("shouldReuseWorktreeForRepair: returns true when worktree_path exists and policy is retain", async () => {
  const result = shouldReuseWorktreeForRepair({ task: { worktree_path: "/tmp/worktree" }, cleanupPolicy: "remove_on_success_retain_on_failure" });
  assert.equal(result.reuse_worktree, true);
  assert.ok(result.reason.includes("Reusing"));
});

test("shouldReuseWorktreeForRepair: returns false when no worktree_path", async () => {
  const result = shouldReuseWorktreeForRepair({ task: {}, cleanupPolicy: "always_remove" });
  assert.equal(result.reuse_worktree, false);
  assert.ok(result.reason.includes("Creating new"));
});

console.log("repair-loop tests loaded");
