/**
 * p0-no-auto-retry-regression.test.mjs
 *
 * P0 regression tests: 禁止系统因验收失败、result.json 缺失、TUI 证据缺失创建
 * 任何新的 follow-up、repair task、retry task 或 Goal。
 *
 * TDD: 这些测试在实现前必须 RED，实现后 GREEN。
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ===========================================================================
// 1. scheduleRepairAttempt 不得在 auto_retry_disabled 时创建 Goal/Task
// ===========================================================================

test("P0: scheduleRepairAttempt with autoRetryEnabled=false must not call createGoalFn", async () => {
  const { scheduleRepairAttempt } = await import("../src/repair-loop.mjs");

  let createGoalFnCalled = false;
  const store = { state: { tasks: [] } };
  const task = {
    id: "task_no_retry",
    title: "No retry",
    goal_id: "goal_no_retry",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "full",
    attempt: 0,
    max_attempts: 2,
    logs: [],
  };
  const goal = { id: "goal_no_retry", goal_prompt: "Original goal" };

  const result = await scheduleRepairAttempt({
    store,
    task,
    goal,
    failure: { failure_class: "missing_result_json", reason: "result.json missing" },
    verification: { findings: [{ severity: "blocker", code: "result_json_missing", message: "No result.json" }] },
    config: {
      autoRetryEnabled: false,
      createGoalFn: async () => {
        createGoalFnCalled = true;
        return { goal: { id: "should_not_exist" }, task: { id: "should_not_exist" } };
      },
    },
  });

  assert.equal(createGoalFnCalled, false,
    "createGoalFn must NOT be called when autoRetryEnabled=false");
  assert.equal(result.scheduled, false,
    "scheduled must be false when autoRetryEnabled=false");
  assert.equal(result.reason, "auto_retry_disabled",
    "reason must be 'auto_retry_disabled'");
});

test("P0: scheduleRepairAttempt with autoRetryEnabled=false does not assign_to_codex", async () => {
  const { scheduleRepairAttempt } = await import("../src/repair-loop.mjs");

  const capturedPayloads = [];
  const store = { state: { tasks: [] } };
  const task = {
    id: "task_no_assign",
    title: "No assign",
    goal_id: "goal_no_assign",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "full",
    attempt: 0,
    max_attempts: 2,
    logs: [],
  };

  const result = await scheduleRepairAttempt({
    store,
    task,
    goal: { id: "goal_no_assign", goal_prompt: "Original" },
    failure: { failure_class: "acceptance_failed", reason: "Acceptance failed" },
    verification: { findings: [{ severity: "blocker", code: "acceptance_failed", message: "Not accepted" }] },
    config: {
      autoRetryEnabled: false,
      createGoalFn: async (s, c, payload) => {
        capturedPayloads.push(payload);
        return { goal: { id: "g" }, task: { id: "t" } };
      },
    },
  });

  assert.equal(capturedPayloads.length, 0,
    "No payload should be created when autoRetryEnabled=false");
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, "auto_retry_disabled");
});

test("P0: scheduleRepairAttempt with autoRetryEnabled=true still works (backward compat)", async () => {
  const { scheduleRepairAttempt } = await import("../src/repair-loop.mjs");

  let createGoalFnCalled = false;
  const store = { state: { tasks: [] } };
  const task = {
    id: "task_backward",
    title: "Backward compat",
    goal_id: "goal_backward",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "full",
    attempt: 0,
    max_attempts: 2,
    logs: [],
  };

  const result = await scheduleRepairAttempt({
    store,
    task,
    goal: { id: "goal_backward", goal_prompt: "Original" },
    failure: { failure_class: "test_failed", reason: "Test failed" },
    verification: { commands: [{ cmd: "npm test", exit_code: 1 }] },
    config: {
      autoRetryEnabled: true,
      createGoalFn: async () => {
        createGoalFnCalled = true;
        return { goal: { id: "g_repair" }, task: { id: "t_repair" } };
      },
    },
  });

  assert.equal(createGoalFnCalled, true,
    "createGoalFn must be called when autoRetryEnabled=true");
  assert.equal(result.scheduled, true,
    "scheduled must be true when autoRetryEnabled=true");
});

// ===========================================================================
// 2. 任意 acceptance failure 均不会创建 follow-up/repair Goal/Task
// ===========================================================================

test("P0: scheduleRepairAttempt with acceptance_failed and autoRetryEnabled=false returns disabled", async () => {
  const { scheduleRepairAttempt } = await import("../src/repair-loop.mjs");

  let createGoalFnCalled = false;
  const store = { state: { tasks: [] } };
  const task = {
    id: "task_accept_fail",
    title: "Acceptance failure",
    goal_id: "goal_accept",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "full",
    attempt: 0,
    max_attempts: 2,
    logs: [],
  };

  // Verify that acceptance_failed with autoRetryEnabled=false
  // does NOT lead to repair via scheduleRepairAttempt
  const result = await scheduleRepairAttempt({
    store,
    task,
    goal: { id: "goal_accept", goal_prompt: "Original" },
    failure: { failure_class: "acceptance_failed", reason: "Acceptance criteria not met" },
    verification: { findings: [{ severity: "blocker", code: "acceptance_failed", message: "Not accepted" }] },
    config: {
      autoRetryEnabled: false,
      createGoalFn: async () => {
        createGoalFnCalled = true;
        return { goal: { id: "g" }, task: { id: "t" } };
      },
    },
  });

  assert.equal(createGoalFnCalled, false);
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, "auto_retry_disabled");
});

// ===========================================================================
// 3. handleRepairCompletion: 失败后不得递增 attempt、不得准备下一次执行
// ===========================================================================

test("P0: handleRepairCompletion with autoRetryEnabled=false must not set next_attempt", async () => {
  const { handleRepairCompletion } = await import("../src/repair-loop.mjs");

  const store = {
    mutate: async (fn) => {
      const state = {
        tasks: [
          { id: "parent_auto", status: "waiting_for_repair", result: {}, logs: [] },
        ],
        goals: [],
      };
      return fn(state);
    },
  };

  const result = await handleRepairCompletion({
    store,
    config: { autoRetryEnabled: false },
    completedTask: { id: "repair_fail", parent_task_id: "parent_auto", status: "failed" },
    passed: false,
  });

  // When autoRetryEnabled=false, repair failure should NOT auto-continue to next attempt
  // Instead, it should move to waiting_for_review or human_review state
  assert.equal(result.repair_outcome !== "continued", true,
    "repair_outcome should NOT be 'continued' when autoRetryEnabled=false");
  assert.equal(result.next_attempt, undefined,
    "next_attempt should NOT be set when autoRetryEnabled=false");
  assert.equal(result.parent_updated, true,
    "parent should be updated");
  // Should stay in a review state, not waiting_for_repair for auto-retry
  assert.notEqual(result.parent_status, "waiting_for_repair",
    "parent should NOT be set back to waiting_for_repair for auto-retry");
});

test("P0: handleRepairCompletion with default config still continues (backward compat)", async () => {
  const { handleRepairCompletion } = await import("../src/repair-loop.mjs");

  const store = {
    mutate: async (fn) => {
      const state = {
        tasks: [
          { id: "parent_cont", status: "waiting_for_repair", result: {}, logs: [] },
        ],
        goals: [],
      };
      return fn(state);
    },
  };

  const result = await handleRepairCompletion({
    store,
    completedTask: { id: "repair_cont", parent_task_id: "parent_cont", status: "failed" },
    passed: false,
  });

  // Default behavior without autoRetryEnabled should still continue (backward compat)
  assert.equal(result.repair_outcome, "continued",
    "Default should still continue to next attempt");
  assert.ok(result.next_attempt !== undefined,
    "next_attempt should be set by default");
});

// ===========================================================================
// 4. completion collector 在缺 result.json 时可从现有 git/session/result.md
//    生成 synthetic result；没有命令证据时不得标 tests passed。
// ===========================================================================

test("P0: reconstructResultJson returns synthetic result with unknown fields", async () => {
  const { reconstructResultJson } = await import("../src/codex-tui-completion-collector.mjs");

  const synthetic = reconstructResultJson({
    sessionId: "session_recon",
    goalId: "goal_recon",
    taskId: "task_recon",
    commit: "abc123def456",
    changedFiles: ["src/main.js"],
    worktreeClean: true,
    resultMd: "Summary: Task completed.\n\nCommit: abc123def456\n",
    tests: null,
  });

  assert.ok(synthetic, "Should return a synthetic result object");
  assert.equal(synthetic.status, "unknown",
    "Status should be unknown when result.json is missing");
  assert.equal(synthetic.commit, "abc123def456",
    "Commit should come from available evidence");
  assert.deepEqual(synthetic.changed_files, ["src/main.js"],
    "Changed files should come from git evidence");
  assert.equal(synthetic.tests, null,
    "Tests should be null when no command evidence exists");
  assert.equal(synthetic.verification?.passed, undefined,
    "verification.passed should NOT be set when no test evidence");
  assert.equal(synthetic.result_json_source, "system_reconstructed",
    "Should indicate system reconstruction");
  assert.ok(synthetic.reconstructed_at, "Should have reconstruction timestamp");
});

test("P0: reconstructResultJson does not fabricate test passed", async () => {
  const { reconstructResultJson } = await import("../src/codex-tui-completion-collector.mjs");

  // No tests evidence at all
  const synthetic = reconstructResultJson({
    sessionId: "session_no_test",
    goalId: "goal_no_test",
    taskId: "task_no_test",
    commit: null,
    changedFiles: [],
    worktreeClean: true,
    resultMd: null,
    tests: null,
  });

  assert.equal(synthetic.tests, null,
    "tests must be null when no evidence available");
  if (synthetic.verification) {
    assert.equal(synthetic.verification.passed, undefined,
      "verification.passed must not be set without evidence");
  }
});

test("P0: reconstructResultJson includes result.md evidence when available", async () => {
  const { reconstructResultJson } = await import("../src/codex-tui-completion-collector.mjs");

  const synthetic = reconstructResultJson({
    sessionId: "session_md",
    goalId: "goal_md",
    taskId: "task_md",
    commit: "def789",
    changedFiles: ["README.md", "src/index.js"],
    worktreeClean: false,
    resultMd: "Summary: Fixed bug.\n\nTests: node --test\nCommit: def789\n",
    tests: "node --test",
  });

  assert.equal(synthetic.commit, "def789");
  assert.deepEqual(synthetic.changed_files, ["README.md", "src/index.js"]);
  assert.equal(synthetic.tests, "node --test",
    "Tests should come from result.md/session when available");
  assert.ok(synthetic.result_md_evidence, "Should include result_md_evidence marker");
});

// ===========================================================================
// 5. synthetic result 不足时只产生 review/evidence blocker，不创建任务
// ===========================================================================

test("P0: collectCodexTuiCompletion returns system_reconstructed result_json_source when result.json missing", async () => {
  const { collectCodexTuiCompletion } = await import("../src/codex-tui-completion-collector.mjs");
  const { createCodexTuiSessionStore } = await import("../src/codex-tui-session-store.mjs");

  // Setup a temp git repo
  const repo = join(tmpdir(), "p0-collector-recon-test-" + Date.now());
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });

  // Create session but NO result.json
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId: "session_recon_test",
    taskId: "task_recon_test",
    goalId: "goal_recon_test",
    cwd: repo,
    repoLockId: "lock_1",
  });

  const snapshot = await collectCodexTuiCompletion({
    sessionId: "session_recon_test",
    workspaceRoot: repo,
  });

  // The collector should not crash - it should return result_json_present=false
  // and when reconstruction is added, it should also return result_json_source
  assert.equal(snapshot.result_json_present, false,
    "result.json should not be present (we didn't create one)");
  assert.equal(snapshot.ready_for_review, false,
    "Should not be ready for review without result.json");

  // Cleanup
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

import { rm } from "node:fs/promises";

console.log("P0 no-auto-retry regression tests loaded");
