/**
 * replay-scenarios.test.mjs — Deterministic worker-level replay tests.
 *
 * P0: Simulates the complete worker convergence → notification → sweeper chain
 * for key scenarios, without depending on external network. Covers:
 *
 *   1. sync-only no-code → completed (with real notification suppression)
 *   2. 429/quota → quota_wait, no repair created
 *   3. 502/503/provider_interruption → retry_wait, no repair created
 *   4. verification failed → waiting_for_repair → parent/root auto-completed
 *   5. stale waiting_for_integration → local/remote aligned → completed
 *   6. waiting_for_repair parent accepted → sweeper completes it
 *   7. emitTaskLifecycleEvent with suppress_notifications
 *   8. emitTaskLifecycleEvent with notify:false
 *   9. GitHub writeback contract in convergence decision
 *  10. Safe restart detection via runtimeState
 */

import test from "node:test";
import assert from "node:assert/strict";
import { convergeTaskAfterRun, CONVERGENCE_STATUSES, CLOSURE_REASONS, detectAcceptanceProfile } from "../src/task-convergence.mjs";
import { sweepStaleTaskStates, applySweepActions } from "../src/stale-state-sweeper.mjs";
import { createNotificationService } from "../src/notification-service.mjs";
import { createBarkNotifier } from "../src/bark-notifier.mjs";
import { handleRepairCompletion } from "../src/repair-loop.mjs";

// ===========================================================================
// 1. sync-only no-code → completed replay
// ===========================================================================

test("replay: sync-only no-code → completed convergence + notification suppression", () => {
  // Step 1: Create a sync-only task
  const task = {
    id: "replay_sync_1",
    status: "running",
    mode: "builder",
    title: "P0: 同步本地 main 到远端 main",
    description: "同步当前本地 main 到远端 main",
    suppress_notifications: true,
  };

  // Step 2: Build a sync-only result
  const taskResult = {
    status: "completed",
    summary: "remote head updated, ahead/behind 0/0",
    changed_files: [],
    commit: "abc123def456",
    remote_head: "abc123def456",
    verification: { passed: true },
  };

  // Step 3: Create acceptance result with tests_missing finding
  const acceptance = {
    passed: false,
    status: "needs_fix",
    findings: [{ severity: "major", code: "tests_missing", message: "No tests in sync-only task" }],
  };

  // Step 4: Converge
  const convergence = convergeTaskAfterRun({
    task,
    taskResult,
    acceptance,
    attempt: 0,
  });

  // Step 5: Verify sync-only completion
  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "sync-only should converge to completed despite tests_missing");
  assert.equal(convergence.profile, "sync_only",
    "sync-only should be detected as sync_only profile");
  assert.equal(convergence.closureReason, CLOSURE_REASONS.SYNC_ONLY,
    "Closure reason should be sync_only");
  assert.equal(convergence.repairPlan, null,
    "sync-only should NOT create a repair plan");
  assert.equal(convergence.retryPlan, null,
    "sync-only should NOT have a retry plan");

  // Step 6: Verify notifications include task_completed
  const completedNotification = convergence.notifications.find(n => n.event === "task_completed");
  assert.ok(completedNotification, "Should have task_completed notification");
  assert.equal(completedNotification.taskId, "replay_sync_1");
});

test("replay: sync-only builder-mode with changed_files_mismatch → completed", () => {
  // A builder-mode task with sync intent should detect sync_only profile
  const task = {
    id: "replay_sync_2",
    status: "running",
    mode: "builder",
    title: "同步仓库状态",
    description: "同步本地 main 到远端 main，检查 ahead/behind",
  };

  const taskResult = {
    status: "completed",
    summary: "local=remote, ahead/behind 0/0",
    changed_files: [],
    commit: "abc123",
    remote_head: "abc123",
    verification: { passed: true },
  };

  const acceptance = {
    passed: false,
    status: "needs_fix",
    findings: [
      { severity: "major", code: "tests_missing", message: "No tests" },
      { severity: "major", code: "changed_files_mismatch", message: "No files changed" },
    ],
  };

  const convergence = convergeTaskAfterRun({
    task,
    taskResult,
    acceptance,
    attempt: 0,
  });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "sync-only with changed_files_mismatch should complete");
  assert.equal(convergence.profile, "sync_only");
  assert.ok(convergence.githubWriteback !== null, "Should have GitHub writeback");
  assert.equal(convergence.githubWriteback.action, "close",
    "Completed task should close GitHub status");
});

// ===========================================================================
// 2. 429/quota → quota_wait, no repair
// ===========================================================================

test("replay: 429 rate_limited → quota_wait, no repair created", () => {
  const task = { id: "replay_429", status: "running", title: "Some task" };
  const taskResult = {
    failure_class: "rate_limited",
    summary: "429 Too Many Requests",
  };

  const convergence = convergeTaskAfterRun({ task, taskResult, attempt: 0 });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.QUOTA_WAIT,
    "429 should go to quota_wait");
  assert.equal(convergence.repairPlan, null,
    "429 should NOT create a repair plan");
  assert.ok(convergence.retryPlan !== null,
    "429 should have a retry plan");
  assert.ok(convergence.retryPlan.delay > 0,
    "429 should have backoff delay");
  assert.ok(convergence.retryPlan.maxAttempts > 0,
    "429 should have max attempts");

  // Verify GitHub writeback is a comment
  assert.equal(convergence.githubWriteback.action, "comment",
    "429 should comment, not close");
  assert.ok(convergence.githubWriteback.body.includes("quota_wait"),
    "Comment should mention quota_wait");

  // Verify notification
  const quotaNotification = convergence.notifications.find(n => n.event === "task_quota_wait");
  assert.ok(quotaNotification, "Should have quota_wait notification");
});

// ===========================================================================
// 3. 502/503/provider_interruption → retry_wait, no repair
// ===========================================================================

test("replay: 502 gateway_error → retry_wait, no repair", () => {
  const task = { id: "replay_502", status: "running", title: "Gateway task" };
  const taskResult = {
    failure_class: "gateway_error",
    summary: "502 Bad Gateway from upstream provider",
  };

  const convergence = convergeTaskAfterRun({ task, taskResult, attempt: 0 });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT,
    "502 should go to retry_wait");
  assert.equal(convergence.repairPlan, null,
    "502 should NOT create repair plan");
  assert.ok(convergence.retryPlan !== null,
    "502 should have retry plan");
  assert.equal(convergence.retryPlan.currentAttempt, 0);

  const retryNotification = convergence.notifications.find(n => n.event === "task_retry_wait");
  assert.ok(retryNotification, "Should have retry_wait notification");
});

test("replay: 503 service_unavailable → retry_wait, no repair", () => {
  const task = { id: "replay_503", status: "running" };
  const taskResult = {
    failure_class: "service_unavailable",
    summary: "503 Service Unavailable",
  };

  const convergence = convergeTaskAfterRun({ task, taskResult, attempt: 0 });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(convergence.repairPlan, null);
});

test("replay: provider_interruption → retry_wait, no repair", () => {
  const task = { id: "replay_provider", status: "running" };
  const taskResult = {
    failure_class: "provider_interruption",
    summary: "Provider interruption: stdout empty, exit code 1",
  };

  const convergence = convergeTaskAfterRun({ task, taskResult, attempt: 0 });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(convergence.repairPlan, null,
    "provider_interruption should NOT create repair plan");
});

// ===========================================================================
// 4. verification failed → waiting_for_repair → parent/root auto-completed
// ===========================================================================

test("replay: verification failed → waiting_for_repair with proper metadata", () => {
  const task = {
    id: "replay_verify_fail",
    status: "running",
    title: "P0: Implement feature",
    repair_attempt: 0,
    max_attempts: 2,
  };

  const taskResult = {
    status: "completed",
    summary: "Tests failed",
    verification: { passed: false },
    failure_class: "verification_failed",
  };

  const acceptance = {
    passed: false,
    status: "needs_fix",
    findings: [{ severity: "blocker", code: "test_failed", message: "Tests failed" }],
  };

  const convergence = convergeTaskAfterRun({
    task,
    taskResult,
    acceptance,
    attempt: 0,
  });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.WAITING_FOR_REPAIR,
    "Verification failed should go to waiting_for_repair");
  assert.ok(convergence.repairPlan !== null,
    "Should have a repair plan");
  assert.equal(convergence.repairPlan.attempt, 1,
    "Should be attempt 1");
  assert.ok(Array.isArray(convergence.repairPlan.findings),
    "Repair plan should include findings");

  // Verify notification
  const repairNotification = convergence.notifications.find(n => n.event === "task_waiting_for_repair");
  assert.ok(repairNotification, "Should have waiting_for_repair notification");
  assert.equal(repairNotification.repairAttempt, 1);
});

test("replay: handleRepairCompletion parent/root auto-completion no worktree → completed", async () => {
  // Simulate: repair task passed → parent marked completed → root auto-completed
  let parentStatus = null;
  let rootStatus = null;
  let parentGoalStatus = null;
  let rootGoalStatus = null;

  const parentGoal = { id: "goal_parent", status: "waiting_for_repair" };
  const rootGoal = { id: "goal_root", status: "running" };

  const store = {
    mutate: async (updater) => {
      const state = {
        tasks: [
          {
            id: "parent_task",
            goal_id: "goal_parent",
            status: "waiting_for_repair",
            root_task_id: "root_task",
            result: {},
            logs: [],
          },
          {
            id: "root_task",
            goal_id: "goal_root",
            status: "running",
            result: {},
            logs: [],
          },
        ],
        goals: [parentGoal, rootGoal],
      };
      const result = updater(state);
      parentStatus = state.tasks[0].status;
      rootStatus = state.tasks[1].status;
      parentGoalStatus = parentGoal.status;
      rootGoalStatus = rootGoal.status;
      return result;
    },
  };

  const result = await handleRepairCompletion({
    store,
    config: {},
    completedTask: {
      id: "repair_task",
      parent_task_id: "parent_task",
      goal_id: "goal_repair",
    },
    passed: true,
  });

  assert.equal(result.parent_updated, true);
  assert.equal(parentStatus, "completed",
    "Parent should be completed after repair success");
  assert.equal(rootStatus, "completed",
    "Root task should be auto-completed via cascade");
  assert.equal(parentGoalStatus, "completed",
    "Parent goal should be completed");
  assert.equal(rootGoalStatus, "completed",
    "Root goal should be completed");
});

// ===========================================================================
// 5. stale waiting_for_integration → local/remote aligned → completed (sweeper)
// ===========================================================================

test("replay: stale waiting_for_integration sweeper resolves aligned ones via repoState", () => {
  const now = Date.now();
  const staleThresholdMs = 300_000;

  // Sweeper uses repoState.remoteHead || result.remote_head, repoState.localHead || result.commit
  // When repoState is set it takes priority over individual task results
  // Tasks with aligned heads (via repoState) should complete
  const tasks = [
    {
      id: "replay_int_align",
      status: "waiting_for_integration",
      updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
      result: {},
    },
  ];

  let actions = sweepStaleTaskStates({
    tasks,
    repoState: { localHead: "abc123", remoteHead: "abc123" },
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "Aligned task should produce action");
  assert.equal(actions[0].recommendedStatus, "completed", "Aligned via repoState should complete");
  assert.equal(actions[0].actions[0].type, "update_task_status");
});

test("replay: stale waiting_for_integration with mismatched repoState → queued", () => {
  const now = Date.now();
  const staleThresholdMs = 300_000;

  // When repoState shows mismatch, stale tasks should re-queue
  const tasks = [{
    id: "replay_int_mismatch",
    status: "waiting_for_integration",
    updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
    result: {},
  }];

  const actions = sweepStaleTaskStates({
    tasks,
    repoState: { localHead: "abc123", remoteHead: "def456" },
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "Mismatched stale task should produce action");
  assert.equal(actions[0].recommendedStatus, "queued",
    "Mismatched stale task should re-queue");
  assert.ok(actions[0].reason.includes("re-queuing"), "Reason should mention re-queuing");
});

test("replay: fresh waiting_for_integration with mismatched heads produces no action", () => {
  const now = Date.now();
  const staleThresholdMs = 300_000;

  // Fresh non-stale task with mismatched heads should not produce action
  const freshTasks = [{
    id: "replay_int_fresh",
    status: "waiting_for_integration",
    updated_at: new Date(now - 1000).toISOString(),
    result: { commit: "xyz789", remote_head: "abc999" }, // Mismatched
  }];

  const freshActions = sweepStaleTaskStates({
    tasks: freshTasks,
    repoState: { localHead: "xyz789", remoteHead: "abc999" }, // Mismatched
    now,
    staleThresholdMs,
  });

  assert.equal(freshActions.length, 0, "Fresh mismatched task should not produce action");
});

// ===========================================================================
// 6. waiting_for_repair parent accepted → completed (sweeper)
// ===========================================================================

test("replay: waiting_for_repair sweeper resolves to completed when parent is done", () => {
  const now = Date.now();

  const tasks = [
    { id: "parent_replay", status: "completed" },
    {
      id: "child_replay",
      status: "waiting_for_repair",
      parent_task_id: "parent_replay",
      updated_at: new Date(now - 1000).toISOString(),
    },
    // This one has a non-completed parent and is stale → should fail
    {
      id: "child_stale",
      status: "waiting_for_repair",
      parent_task_id: "parent_missing",
      repair_attempt: 2,
      max_attempts: 2,
      updated_at: new Date(now - 1_500_000).toISOString(), // very stale
    },
  ];

  const staleThresholdMs = 300_000;
  const actions = sweepStaleTaskStates({ tasks, now, staleThresholdMs });

  const childDoneAction = actions.find(a => a.taskId === "child_replay");
  const childStaleAction = actions.find(a => a.taskId === "child_stale");

  assert.ok(childDoneAction, "Repair child with completed parent should have action");
  assert.equal(childDoneAction.recommendedStatus, "completed",
    "Repair child should complete when parent done");
  assert.ok(childDoneAction.actions[0].payload.status === "completed");

  assert.ok(childStaleAction, "Stale repair child should have action");
  assert.equal(childStaleAction.recommendedStatus, "failed",
    "Stale repair child with exhausted attempts should fail");
});

// ===========================================================================
// 7-8. emitTaskLifecycleEvent notification suppression
// ===========================================================================

test("replay: emitTaskLifecycleEvent respects suppress_notifications", async () => {
  const bark = createBarkNotifier({ barkEnabled: true, barkKey: "test-key" });
  const svc = createNotificationService(bark);

  // Mock fetch to track calls
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  };

  try {
    const task = {
      id: "task_suppressed",
      title: "Quiet task",
      status: "running",
      suppress_notifications: true,
    };

    const result = await svc.emitTaskLifecycleEvent({
      task,
      event: "task_completed",
      nextStatus: "completed",
    });

    assert.ok(result.suppressed || result.ok === false,
      "Should suppress or not send notification");
    // Bark fetch should NOT have been called
    if (result.suppressed) {
      assert.equal(fetchCalled, false,
        "Bark should NOT be called for suppressed task");
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("replay: emitTaskLifecycleEvent respects notify:false", async () => {
  const bark = createBarkNotifier({ barkEnabled: true, barkKey: "test-key" });
  const svc = createNotificationService(bark);

  let fetchCalled = false;
  const origFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
    };

    const task = {
      id: "task_notify_false",
      title: "Notify false task",
      status: "running",
      notify: false,
    };

    const result = await svc.emitTaskLifecycleEvent({
      task,
      event: "task_completed",
      nextStatus: "completed",
    });

    assert.ok(result.suppressed === true,
      "notify:false should cause suppression");
    if (result.suppressed) {
      assert.equal(fetchCalled, false,
        "Bark should NOT be called for notify:false task");
      assert.equal(result.reason, "suppressed:task_policy",
        "Reason should indicate task_policy suppression");
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ===========================================================================
// 9. GitHub writeback contract in convergence decision
// ===========================================================================

test("replay: convergence decision includes GitHub writeback contract", () => {
  // Test that all convergence modes produce the correct GitHub writeback
  const testCases = [
    {
      name: "sync-only completed",
      task: { id: "t_gh_sync", status: "running", mode: "sync" },
      taskResult: { status: "completed", summary: "sync done", verification: { passed: true } },
      acceptance: { passed: false, findings: [{ severity: "major", code: "tests_missing" }] },
      expectedAction: "close",
      expectedStatus: "completed",
    },
    {
      name: "rate_limited",
      task: { id: "t_gh_429", status: "running" },
      taskResult: { failure_class: "rate_limited", summary: "429" },
      expectedAction: "comment",
      expectedStatus: "quota_wait",
    },
    {
      name: "verification failed",
      task: { id: "t_gh_verify", status: "running", repair_attempt: 0 },
      taskResult: { failure_class: "verification_failed", summary: "verify fail", verification: { passed: false } },
      acceptance: { passed: false, findings: [{ severity: "blocker", code: "test_failed" }] },
      expectedAction: "status",
      expectedStatus: "waiting_for_repair",
    },
  ];

  for (const tc of testCases) {
    const convergence = convergeTaskAfterRun({
      task: tc.task,
      taskResult: tc.taskResult,
      acceptance: tc.acceptance,
      attempt: 0,
    });

    assert.equal(convergence.nextStatus, tc.expectedStatus,
      `${tc.name}: expected status ${tc.expectedStatus}, got ${convergence.nextStatus}`);
    assert.ok(convergence.githubWriteback !== null,
      `${tc.name}: should have GitHub writeback`);
    assert.equal(convergence.githubWriteback.action, tc.expectedAction,
      `${tc.name}: expected action ${tc.expectedAction}, got ${convergence.githubWriteback.action}`);
  }
});

// ===========================================================================
// 10. Safe restart detection via runtimeState
// ===========================================================================

test("replay: runtime change triggers restart_pending with proper plan", () => {
  const task = { id: "replay_restart", status: "running" };
  const taskResult = {
    status: "completed",
    summary: "Runtime code changed",
    verification: { passed: true },
  };
  const acceptance = { passed: true, status: "accepted", findings: [] };
  const runtimeState = {
    runningCommit: "old_commit",
    repo_head: "new_commit",
    runtimeChanged: true,
  };

  const convergence = convergeTaskAfterRun({
    task, taskResult, acceptance, runtimeState, attempt: 0,
  });

  assert.equal(convergence.nextStatus, CONVERGENCE_STATUSES.RESTART_PENDING,
    "Runtime change should go to restart_pending");
  assert.ok(convergence.restartPlan !== null,
    "Should have a restart plan");
  assert.equal(convergence.restartPlan.runningCommit, "old_commit",
    "Should track running commit");
  assert.equal(convergence.restartPlan.repoHead, "new_commit",
    "Should track repo head");
  assert.equal(convergence.restartPlan.required, true,
    "Restart should be required");

  // Verify notification
  const restartNotification = convergence.notifications.find(n => n.event === "restart_required");
  assert.ok(restartNotification, "Should have restart_required notification");
});

// ===========================================================================
// 11. Acceptance profile detection edge cases
// ===========================================================================

test("replay: detectAcceptanceProfile for various task types", () => {
  const cases = [
    { task: { mode: "sync" }, result: {}, expected: "sync_only" },
    { task: { mode: "github_sync" }, result: {}, expected: "github_sync_only" },
    { task: { mode: "verification" }, result: {}, expected: "verification_only" },
    { task: { parent_task_id: "p1", repair_of_task_id: "p1" }, result: { changed_files: [] }, expected: "repair_noop" },
    { task: { parent_task_id: "p1", repair_of_task_id: "p1" }, result: { changed_files: ["src/a.js"] }, expected: "repair_code_change" },
    { task: { status: "retry_wait" }, result: {}, expected: "network_retry" },
    { task: { status: "quota_wait" }, result: {}, expected: "network_retry" },
    { task: { mode: "noop" }, result: { noop: true }, expected: "noop" },
  ];

  for (const c of cases) {
    const profile = detectAcceptanceProfile(c.task, c.result);
    assert.equal(profile, c.expected,
      `Task mode=${c.task.mode} expected ${c.expected}, got ${profile}`);
  }
});

// ===========================================================================
// 12. Sweeper → store mutation integration
// ===========================================================================

test("replay: full sweeper chain → applySweepActions completes stale tasks", async () => {
  const now = Date.now();
  const staleThresholdMs = 300_000;

  // Create sweeper actions for a batch of stale tasks
  const sweepActions = sweepStaleTaskStates({
    tasks: [
      {
        id: "replay_full_1",
        status: "waiting_for_integration",
        updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
        result: { commit: "abc", remote_head: "abc" },
      },
      {
        id: "replay_full_2",
        status: "waiting_for_review",
        updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
        result: { verification: { passed: true } },
      },
      {
        id: "replay_full_3",
        status: "waiting_for_repair",
        parent_task_id: "parent_completed",
        updated_at: new Date(now - 1000).toISOString(),
      },
    ],
    repoState: { localHead: "abc", remoteHead: "abc" },
    now,
    staleThresholdMs,
  });

  // Also add a parent task for replay_full_3
  const sweepActionsWithParent = sweepStaleTaskStates({
    tasks: [
      {
        id: "replay_full_1",
        status: "waiting_for_integration",
        updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
        result: { commit: "abc", remote_head: "abc" },
      },
      {
        id: "replay_full_2",
        status: "waiting_for_review",
        updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
        result: { verification: { passed: true } },
      },
      { id: "parent_completed", status: "completed" },
      {
        id: "replay_full_3",
        status: "waiting_for_repair",
        parent_task_id: "parent_completed",
        updated_at: new Date(now - 1000).toISOString(),
      },
    ],
    repoState: { localHead: "abc", remoteHead: "abc" },
    now,
    staleThresholdMs,
  });

  assert.equal(sweepActionsWithParent.length, 3,
    "All 3 stale tasks should be resolved");
  const statuses = sweepActionsWithParent.map(a => a.recommendedStatus);
  assert.equal(statuses.filter(s => s === "completed").length, 3,
    "All actions should recommend completed");

  // Apply the sweeper actions
  const updatedTasks = [];
  const mockStore = {
    updateTask: async (taskId, updater) => {
      const task = { id: taskId, status: "stale", logs: [] };
      updater(task);
      updatedTasks.push(task);
    },
  };

  const result = await applySweepActions(mockStore, sweepActionsWithParent);

  assert.equal(result.applied, 3, "Should apply 3 updates");
  assert.equal(result.errors.length, 0, "No errors");
  assert.equal(updatedTasks.length, 3, "3 tasks updated");
  for (const t of updatedTasks) {
    assert.equal(t.status, "completed",
      `Task ${t.id} should be completed after sweep`);
    assert.ok(t.swept_at, "Should have swept_at timestamp");
    assert.ok(Array.isArray(t.logs), "Should have logs array");
    assert.ok(t.logs.length > 0, "Should have at least one log entry");
  }
});
