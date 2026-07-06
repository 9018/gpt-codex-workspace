/**
 * queue-auto-advance.test.mjs — Tests for queue auto-advance reconciler.
 *
 * Covers:
 * 1. queued -> assigned: basic dependency-free advancement
 * 2. completed after dependent auto-start: completion triggers dependent
 * 3. waiting_for_integration retry: terminal completed unblocks waiting items
 * 4. accepted+verified review recovery: review task auto-advances with verification
 * 5. running queue reconciliation: stale blockers detection and resolution
 * 6. enabled_but_not_running integration: worker health phase in queue context
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ===========================================================================
// Helpers
// ===========================================================================

function makeState(overrides = {}) {
  return {
    goals: [],
    tasks: [],
    goal_queue: [],
    ...overrides,
  };
}

function addGoal(state, id, status = "open", opts = {}) {
  state.goals.push({
    id,
    title: opts.title || id,
    status,
    mode: opts.mode || "builder",
    workspace_id: opts.workspace_id || "hosted-default",
    project_id: "default",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...opts,
  });
}

function addTask(state, id, status, opts = {}) {
  state.tasks.push({
    id,
    assignee: opts.assignee || "codex",
    status,
    goal_id: opts.goal_id || null,
    mode: "builder",
    logs: [],
    result: opts.result || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...opts,
  });
}

function addQueueItem(state, queueId, goalId, position, status, opts = {}) {
  state.goal_queue.push({
    queue_id: queueId,
    goal_id: goalId,
    task_id: opts.task_id || null,
    position,
    status: status || "waiting",
    depends_on_goal_id: opts.depends_on_goal_id || null,
    depends_on_task_id: opts.depends_on_task_id || null,
    dependency_policy: opts.dependency_policy || "completed_only",
    blocked_reason: opts.blocked_reason || null,
    auto_start: opts.auto_start !== false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// ===========================================================================
// Test 1: queued -> assigned — dependency-free advancement
// ===========================================================================

test("queue-reconciler: dependency-free queued item can advance (diagnose reports can_advance)", async () => {
  const { diagnoseQueueItems } = await import("../src/queue-reconciler.mjs");
  const state = makeState();
  addQueueItem(state, "queue_independent", "goal_independent", 1, "waiting");

  const result = diagnoseQueueItems(state);

  assert.equal(result.queue_items_count, 1);
  assert.equal(result.scans.length, 1);
  // Without a dependency, the item is considered advanceable
  // (dependency is trivially satisfied when there is none)
  assert.equal(result.scans[0].can_advance, true);
  assert.equal(result.scans[0].dependency.kind, "none");
  assert.equal(result.scans[0].effective_completed, true);
});

// ===========================================================================
// Test 2: completed after dependent auto-start
// ===========================================================================

test("queue-reconciler: completed upstream task unblocks dependent queue item", async () => {
  const { diagnoseQueueItems } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_upstream", "completed", {
    goal_id: "goal_upstream",
    result: { needs_integration: false },
  });
  addQueueItem(state, "queue_dependent", "goal_dependent", 1, "waiting", {
    depends_on_task_id: "task_upstream",
    dependency_policy: "completed_only",
  });

  const result = diagnoseQueueItems(state);

  assert.equal(result.queue_items_count, 1);
  const scan = result.scans[0];
  assert.equal(scan.dependency.status, "completed");
  assert.equal(scan.effective_completed, true);
  assert.equal(scan.can_advance, true);
});

// ===========================================================================
// Test 3: waiting_for_integration retry resolved by integrated upstream
// ===========================================================================

test("queue-reconciler: integration-not-required upstream unblocks dependent", async () => {
  const { diagnoseQueueItems } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_integrated", "completed", {
    goal_id: "goal_integrated",
    result: { integration: { status: "not_required" }, needs_integration: false },
  });
  addQueueItem(state, "queue_after_integration", "goal_after_integration", 1, "waiting", {
    depends_on_task_id: "task_integrated",
  });

  const result = diagnoseQueueItems(state);

  const scan = result.scans[0];
  assert.equal(scan.effective_completed, true);
  assert.equal(scan.integration_required_and_missing, false);
  assert.equal(scan.action, "advance");
  assert.ok(scan.detail.includes("integration not required"));
});

// ===========================================================================
// Test 4: accepted+verified review recovery
// ===========================================================================

test("queue-reconciler: waiting_for_review task with passing verification auto-recovers", async () => {
  const { detectStaleBlockers, diagnoseQueueItems } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_accepted", "completed", {
    goal_id: "goal_accepted",
    result: {
      verification: { passed: true, commands: ["test"] },
      tests: "All tests pass",
      acceptance: { verdict: "accepted" },
      needs_integration: false,
    },
  });
  addQueueItem(state, "queue_dep_on_accepted", "goal_dependent", 1, "blocked", {
    depends_on_task_id: "task_accepted",
    blocked_reason: "waiting for upstream",
  });

  // The detectStaleBlockers function should detect that the dependency is
  // terminal-completed and the item is still blocked — a stale blocker
  const stale = detectStaleBlockers(state);
  const itemStale = stale.find(s => s.queue_id === "queue_dep_on_accepted");
  if (itemStale) {
    assert.equal(itemStale.stale_type, "dependency_resolved");
    assert.ok(itemStale.recommendation.includes("unblock"));
  } else {
    // Stale blockers detection only reports blocked items whose dependency resolved;
    // items in 'waiting' status are not stale-blockers
    // For this test, verify the item would be advanceable
    const diag = diagnoseQueueItems(state);
    const scan = diag.scans.find(s => s.queue_id === "queue_dep_on_accepted");
    assert.ok(scan, "should have scan for queue_dep_on_accepted");
    assert.equal(scan.can_advance, true);
  }
});

// ===========================================================================
// Test 5: running queue reconciliation — reconcileQueue dry run =================================================================================

test("queue-reconciler: reconcileQueue dry-run does not mutate state", async () => {
  const { reconcileQueue } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_dry_run", "completed", {
    goal_id: "goal_dry",
    result: { needs_integration: false },
  });
  addQueueItem(state, "queue_dry_run", "goal_dry_run", 1, "waiting", {
    depends_on_task_id: "task_dry_run",
  });

  const originalQueue = JSON.parse(JSON.stringify(state.goal_queue));

  const result = await reconcileQueue(state, {}, { dryRun: true, fixStaleBlockers: false });

  assert.equal(result.dry_run, true);
  assert.equal(result.reconciled, false);

  // Verify no mutation
  assert.deepEqual(state.goal_queue, originalQueue);
});

// ===========================================================================
// Test 6: propagateRepairSuccess unblocks dependents when dependency resolves
// ===========================================================================

test("queue-reconciler: propagateRepairSuccess unblocks queue items after repair completion", async () => {
  const { propagateRepairSuccess } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  const rootTaskId = "task_root";
  // Create the original task — already marked as resolved_by successor
  addTask(state, rootTaskId, "resolved_by_successor", {
    goal_id: "goal_root",
    result: {
      failure_class: "test_failure",
      resolved_by_task_id: "task_repair",
      repair_outcome: "repaired",
    },
  });
  // Queue item depends on the original task (which now has resolved marker)
  addQueueItem(state, "queue_blocked_by_root", "goal_dependent", 1, "blocked", {
    depends_on_task_id: rootTaskId,
    blocked_reason: "upstream task failed",
  });

  // The repair task completed with repair_of_task_id pointing to root
  const repairTask = {
    id: "task_repair",
    goal_id: "goal_root",
    repair_of_task_id: rootTaskId,
    status: "completed",
    result: {
      repair_outcome: "repaired",
      delivered: true,
    },
  };
  state.tasks.push(repairTask);

  const result = await propagateRepairSuccess(state, repairTask, { dryRun: false });

  // Should detect propagated result
  assert.ok(result.propagated, "should propagate repair success");
  assert.ok(result.affected_count >= 1, "should affect at least one queue item");
  // In non-dry-run mode, the blocked item should be unblocked
  if (result.affected_count > 0) {
    assert.equal(result.affected[0].action, "unblocked", "first affected item should be unblocked");
  }
});

// ===========================================================================
// Test 7: Worker health computed properly in extended snapshot
// ===========================================================================

test("queue-reconciler: worker health phase correctly when enabled but not running", async () => {
  const { workerStatusExtendedSnapshot } = await import("../src/codex-worker-state.mjs");

  const state = { enabled: true, running: false, started_at: null };
  const snapshot = workerStatusExtendedSnapshot(state);

  assert.equal(snapshot.health.phase, "enabled_but_not_running");
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.running, false);
});

// ===========================================================================
// Test 8: detectStaleBlockers reports dependency_in_progress correctly
// ===========================================================================

test("queue-reconciler: detectStaleBlockers returns dependency_in_progress for non-terminal", async () => {
  const { detectStaleBlockers } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_running", "running", {
    goal_id: "goal_running",
  });
  addQueueItem(state, "queue_blocked_by_running", "goal_dependent", 1, "blocked", {
    depends_on_task_id: "task_running",
    blocked_reason: "waiting for running task",
  });

  const stale = detectStaleBlockers(state);
  const itemStale = stale.find(s => s.queue_id === "queue_blocked_by_running");
  assert.ok(itemStale, "stale blocker should be detected");
  assert.equal(itemStale.stale_type, "dependency_in_progress");
  assert.ok(itemStale.recommendation.includes("keep blocked"));
});

// ===========================================================================
// Test 9: resolveQueueDependencyState handles missing dependency gracefully
// ===========================================================================

test("queue-reconciler: resolveQueueDependencyState returns effective_failed for failed dependency", async () => {
  const { resolveQueueDependencyState } = await import("../src/queue-reconciler.mjs");

  const state = makeState();
  addTask(state, "task_failed", "failed", {
    goal_id: "goal_failed",
    result: { failure_class: "test_failure" },
  });
  addQueueItem(state, "queue_dep_on_failed", "goal_dependent", 1, "blocked", {
    depends_on_task_id: "task_failed",
    blocked_reason: "waiting for failed task",
  });

  const item = state.goal_queue[0];
  const depState = resolveQueueDependencyState(state, item);

  assert.equal(depState.status, "failed");
  assert.equal(depState.effective_completed, false);
  assert.equal(depState.effective_failed, true);
  assert.ok(depState.detail.includes("terminal failed"));
});

// ===========================================================================
// Test 10: integrate health gate with queue — enabled_but_not_running
//         diagnostic when worker should be running
// ===========================================================================

test("queue-reconciler: computeWorkerHealth distinguishes all required states", async () => {
  const { computeWorkerHealth } = await import("../src/codex-worker-state.mjs");

  // Disabled
  const disabled = computeWorkerHealth({ enabled: false, running: false });
  assert.equal(disabled.phase, "disabled");

  // Enabled but not running (never started)
  const neverStarted = computeWorkerHealth({ enabled: true, running: false, started_at: null, last_tick_finished_at: null });
  assert.equal(neverStarted.phase, "enabled_but_not_running");
  assert.equal(neverStarted.reason, "worker enabled but never started");

  // Enabled but not running (between ticks)
  const betweenTicks = computeWorkerHealth({
    enabled: true,
    running: false,
    started_at: new Date(Date.now() - 30000).toISOString(),
    last_tick_started_at: new Date(Date.now() - 15000).toISOString(),
    last_tick_finished_at: new Date(Date.now() - 5000).toISOString(),
    last_tick_duration_ms: 1000,
    interval_ms: 10000,
    current_interval_ms: 10000,
    next_tick_due_at: new Date(Date.now() + 5000).toISOString(),
  });
  assert.equal(betweenTicks.phase, "enabled_but_not_running");
  assert.equal(betweenTicks.reason, "worker enabled but not running");

  // Running
  const running = computeWorkerHealth({
    enabled: true,
    running: true,
    started_at: new Date(Date.now() - 60000).toISOString(),
    last_tick_started_at: new Date(Date.now() - 2000).toISOString(),
    last_tick_finished_at: null,
    last_tick_duration_ms: null,
    interval_ms: 10000,
    current_interval_ms: 10000,
    next_tick_due_at: null,
    last_error: null,
    last_tick_result: null,
    concurrency: null,
    limit: null,
  });
  assert.equal(running.phase, "running");
  assert.ok(running.reason.startsWith("tick running for"));
  assert.ok(running.current_tick_duration_ms !== null);

  // Stalled
  const stalled = computeWorkerHealth({
    enabled: true,
    running: false,
    started_at: new Date(Date.now() - 120000).toISOString(),
    last_tick_started_at: new Date(Date.now() - 70000).toISOString(),
    last_tick_finished_at: new Date(Date.now() - 65000).toISOString(),
    last_tick_duration_ms: 5000,
    interval_ms: 5000,
    current_interval_ms: 5000,
    next_tick_due_at: null,
  });
  assert.equal(stalled.phase, "stalled");
  assert.ok(stalled.reason.includes("last tick"));
});
