/**
 * workstream-drift-stall.test.mjs
 * Tests for drift and stall detection modules.
 *
 * Covers:
 *   - detectWrongPhaseDrift
 *   - detectWrongScopeDrift
 *   - detectStaleProgressDrift
 *   - detectTerminalQueueMismatchDrift
 *   - detectDrift (composite)
 *   - detectDeadTuiStall
 *   - detectStaleWorkerStall
 *   - detectStaleLockStall
 *   - detectTerminalMismatchStall
 *   - detectStall (composite)
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { detectDrift, detectWrongPhaseDrift, detectWrongScopeDrift, detectStaleProgressDrift, detectTerminalQueueMismatchDrift, DRIFT_TYPE } from "../src/orchestration/workstream-drift-detector.mjs";
import { detectStall, detectDeadTuiStall, detectStaleWorkerStall, detectStaleLockStall, detectTerminalMismatchStall, STALL_TYPE } from "../src/orchestration/workstream-stall-detector.mjs";

// ===========================================================================
// Drift detection tests
// ===========================================================================

test("detectWrongPhaseDrift: no drift when phase matches", () => {
  const result = detectWrongPhaseDrift({
    task: { id: "t1", phase: "backend" },
    workstream: { id: "ws_1" },
    expectedPhase: "backend",
  });
  assert.equal(result.drifted, false);
});

test("detectWrongPhaseDrift: drift when phase mismatches", () => {
  const result = detectWrongPhaseDrift({
    task: { id: "t2", phase: "backend" },
    expectedPhase: "frontend",
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "task_phase_mismatch");
});

test("detectWrongPhaseDrift: drift when phase missing", () => {
  const result = detectWrongPhaseDrift({
    task: { id: "t3" },
    expectedPhase: "backend",
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "task_phase_missing");
});

test("detectWrongPhaseDrift: no drift when no expected phase", () => {
  const result = detectWrongPhaseDrift({
    task: { id: "t4", phase: "anything" },
    expectedPhase: "",
  });
  assert.equal(result.drifted, false);
});

test("detectWrongScopeDrift: no drift when scope matches", () => {
  const result = detectWrongScopeDrift({
    task: { id: "t5", scope: "backend" },
    expectedScopes: ["backend", "frontend"],
  });
  assert.equal(result.drifted, false);
});

test("detectWrongScopeDrift: drift when scope outside expected", () => {
  const result = detectWrongScopeDrift({
    task: { id: "t6", scope: "infra" },
    expectedScopes: ["backend", "frontend"],
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "task_scope_outside_expected");
});

test("detectWrongScopeDrift: drift when scope missing", () => {
  const result = detectWrongScopeDrift({
    task: { id: "t7" },
    expectedScopes: ["backend"],
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "task_scope_missing");
});

test("detectStaleProgressDrift: no drift when recently updated", () => {
  const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const result = detectStaleProgressDrift({
    task: { id: "t8", updated_at: recent },
    progress: { updated_at: recent },
    staleThresholdHours: 2,
  });
  assert.equal(result.drifted, false);
});

test("detectStaleProgressDrift: drift when stale", () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
  const result = detectStaleProgressDrift({
    task: { id: "t9", updated_at: old, status: "running" },
    progress: { updated_at: old },
    staleThresholdHours: 2,
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "stale_progress");
});

test("detectStaleProgressDrift: no drift for completed task even if old", () => {
  const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const result = detectStaleProgressDrift({
    task: { id: "t10", updated_at: old, status: "completed" },
    progress: { updated_at: old },
    staleThresholdHours: 2,
  });
  assert.equal(result.drifted, false);
});

test("detectTerminalQueueMismatchDrift: no drift when both terminal", () => {
  const result = detectTerminalQueueMismatchDrift({
    task: { id: "t11", status: "completed" },
    parentTask: { id: "p11", status: "completed" },
  });
  assert.equal(result.drifted, false);
});

test("detectTerminalQueueMismatchDrift: drift when terminal task non-terminal parent", () => {
  const result = detectTerminalQueueMismatchDrift({
    task: { id: "t12", status: "completed" },
    parentTask: { id: "p12", status: "running" },
  });
  assert.equal(result.drifted, true);
  assert.equal(result.code, "terminal_task_non_terminal_parent");
});

test("detectDrift: composite finds no drift when clean", () => {
  const recent = new Date().toISOString();
  const result = detectDrift({
    task: { id: "t13", phase: "backend", scope: "test", updated_at: recent, status: "running" },
    expectedPhase: "backend",
    expectedScopes: ["test"],
    progress: { updated_at: recent },
    staleThresholdHours: 2,
  });
  assert.equal(result.drifted, false);
  assert.equal(result.drift_count, 0);
});

test("detectDrift: composite finds multiple drifts", () => {
  const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const result = detectDrift({
    task: { id: "t14", phase: "wrong", scope: "wrong", updated_at: old, status: "running" },
    parentTask: { id: "p14", status: "running" },
    expectedPhase: "backend",
    expectedScopes: ["correct"],
    progress: { updated_at: old },
    staleThresholdHours: 1,
  });
  assert.ok(result.drifted);
  assert.ok(result.drift_count >= 3); // phase + scope + stale, possibly queue
});

// ===========================================================================
// Stall detection tests
// ===========================================================================

test("detectDeadTuiStall: no stall when TUI has recent heartbeat", () => {
  const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min ago
  const result = detectDeadTuiStall({
    tuiSession: { session_id: "s1", last_heartbeat_at: recent, status: "active" },
    maxHeartbeatAgeMinutes: 10,
  });
  assert.equal(result.stalled, false);
});

test("detectDeadTuiStall: stall when heartbeat stale", () => {
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const result = detectDeadTuiStall({
    tuiSession: { session_id: "s2", last_heartbeat_at: old, status: "active" },
    maxHeartbeatAgeMinutes: 10,
  });
  assert.equal(result.stalled, true);
  assert.equal(result.code, "tui_heartbeat_stale");
});

test("detectDeadTuiStall: no stall when no TUI session", () => {
  const result = detectDeadTuiStall({ tuiSession: {} });
  assert.equal(result.stalled, false);
});

test("detectStaleWorkerStall: no stall when worker recently updated", () => {
  const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const result = detectStaleWorkerStall({
    task: { id: "t15", assignee: "codex", status: "running", updated_at: recent },
    maxWorkerIdleMinutes: 15,
  });
  assert.equal(result.stalled, false);
});

test("detectStaleWorkerStall: stall when worker idle", () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const result = detectStaleWorkerStall({
    task: { id: "t16", assignee: "codex", status: "running", updated_at: old },
    maxWorkerIdleMinutes: 15,
  });
  assert.equal(result.stalled, true);
  assert.equal(result.code, "worker_idle");
});

test("detectStaleWorkerStall: no stall for non-worker task", () => {
  const result = detectStaleWorkerStall({
    task: { id: "t17", assignee: "human", status: "running" },
  });
  assert.equal(result.stalled, false);
});

test("detectStaleLockStall: no stall when lock recent", () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = detectStaleLockStall({
    lock: { lock_id: "l1", acquired_at: recent },
    maxLockAgeMinutes: 60,
  });
  assert.equal(result.stalled, false);
});

test("detectStaleLockStall: stall when lock stale", () => {
  const old = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
  const result = detectStaleLockStall({
    lock: { lock_id: "l2", acquired_at: old },
    maxLockAgeMinutes: 60,
  });
  assert.equal(result.stalled, true);
  assert.equal(result.code, "lock_stale");
});

test("detectStaleLockStall: no stall when no lock", () => {
  const result = detectStaleLockStall({ lock: {} });
  assert.equal(result.stalled, false);
});

test("detectTerminalMismatchStall: no stall when no terminal tasks", () => {
  const result = detectTerminalMismatchStall({
    tasks: [
      { id: "t18", status: "running" },
      { id: "t19", status: "queued" },
    ],
    parentTask: { id: "p18", status: "running" },
  });
  assert.equal(result.stalled, false);
});

test("detectTerminalMismatchStall: stall with terminal tasks and pending siblings", () => {
  const result = detectTerminalMismatchStall({
    tasks: [
      { id: "t20", status: "completed" },
      { id: "t21", status: "running" },
    ],
    parentTask: { id: "p20", status: "running" },
  });
  assert.equal(result.stalled, true);
  assert.equal(result.code, "terminal_tasks_with_pending_siblings");
});

test("detectStall: composite — no stall when clean", () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const result = detectStall({
    task: { id: "t22", assignee: "codex", status: "running", updated_at: recent },
    tuiSession: { session_id: "s3", last_heartbeat_at: recent, status: "active" },
    lock: { lock_id: "l3", acquired_at: recent },
    parentTask: { id: "p22", status: "running" },
    siblingTasks: [{ id: "t22", status: "running" }],
  });
  assert.equal(result.stalled, false);
  assert.equal(result.stall_count, 0);
});

test("detectStall: composite — multiple stalls", () => {
  const old = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  const result = detectStall({
    task: { id: "t23", assignee: "codex", status: "running", updated_at: old },
    tuiSession: { session_id: "s4", last_heartbeat_at: old, status: "active" },
    lock: { lock_id: "l4", acquired_at: old },
    parentTask: { id: "p23", status: "running" },
    siblingTasks: [
      { id: "t23a", status: "completed" },
      { id: "t23b", status: "running" },
    ],
    maxHeartbeatAgeMinutes: 10,
    maxWorkerIdleMinutes: 15,
    maxLockAgeMinutes: 60,
  });
  assert.ok(result.stalled);
  assert.ok(result.stall_count >= 3);
});
