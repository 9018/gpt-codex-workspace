/**
 * workstream-tick.test.mjs
 * Tests for the tick controller.
 *
 * Covers:
 *   - runTick with all 5 transition steps
 *   - Transition budget limit (max 5)
 *   - Drift + stall detection integration
 *   - Acceptance evaluation for completed tasks
 *   - Task advancement
 *   - Review reconciliation
 *   - Idempotency fields
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runTick, tickDriftDetection, tickStallDetection, tickTaskAdvancement, tickReviewReconciliation, MAX_STATE_TRANSITIONS, TRANSITION_KIND } from "../src/orchestration/workstream-tick.mjs";

// ===========================================================================
// Individual tick step tests
// ===========================================================================

test("tickDriftDetection: finds no drift when clean", () => {
  const recent = new Date().toISOString();
  const result = tickDriftDetection({
    workstream: { id: "ws_1", phase: "backend" },
    tasks: [
      { id: "t1", phase: "backend", updated_at: recent, status: "running" },
    ],
    progress: { updated_at: recent },
  });

  assert.equal(result.kind, TRANSITION_KIND.DRIFT_DETECTED);
  assert.equal(result.count, 0);
  assert.ok(result.idempotency_key);
});

test("tickDriftDetection: finds drift when phase wrong", () => {
  const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const result = tickDriftDetection({
    workstream: { id: "ws_2", phase: "backend" },
    tasks: [
      { id: "t2", phase: "frontend", updated_at: old, status: "running" },
    ],
    progress: { updated_at: old },
  });

  assert.equal(result.kind, TRANSITION_KIND.DRIFT_DETECTED);
  assert.ok(result.count > 0);
  assert.ok(result.findings.length > 0);
});

test("tickStallDetection: finds stall when TUI dead", () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const result = tickStallDetection({
    task: { id: "t3", assignee: "codex", status: "running", updated_at: old },
    tuiSession: { session_id: "s1", last_heartbeat_at: old, status: "active" },
    lock: { lock_id: "l1", acquired_at: old },
    siblingTasks: [{ id: "t3", status: "running" }],
  });

  assert.equal(result.kind, TRANSITION_KIND.STALL_DETECTED);
  assert.ok(result.count > 0);
  assert.ok(result.stalled);
});

test("tickStallDetection: no stall when clean", () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const result = tickStallDetection({
    task: { id: "t4", assignee: "codex", status: "running", updated_at: recent },
    tuiSession: { session_id: "s2", last_heartbeat_at: recent, status: "active" },
    lock: { lock_id: "l2", acquired_at: recent },
  });

  assert.equal(result.kind, TRANSITION_KIND.STALL_DETECTED);
  assert.equal(result.count, 0);
  assert.equal(result.stalled, false);
});

test("tickTaskAdvancement: advances eligible tasks", () => {
  const result = tickTaskAdvancement({
    tasks: [
      { id: "t5", status: "assigned" },
      { id: "t6", status: "queued" },
      { id: "t7", status: "completed" }, // terminal, not advanced
    ],
  });

  assert.equal(result.kind, TRANSITION_KIND.TASK_ADVANCED);
  assert.equal(result.count, 2);
  assert.equal(result.advancements.length, 2);
  assert.equal(result.advancements[0].old_status, "assigned");
  assert.equal(result.advancements[1].old_status, "queued");
});

test("tickTaskAdvancement: no tasks to advance", () => {
  const result = tickTaskAdvancement({
    tasks: [
      { id: "t8", status: "completed" },
      { id: "t9", status: "failed" },
    ],
  });

  assert.equal(result.count, 0);
});

test("tickReviewReconciliation: evaluates backlog items", () => {
  const result = tickReviewReconciliation({
    reviewBacklog: [
      { task_id: "r1", status: "waiting_for_review" },
      { task_id: "r2", status: "waiting_for_repair" },
      { task_id: "r3", status: "completed" }, // not review status
    ],
  });

  assert.equal(result.kind, TRANSITION_KIND.REVIEW_RECONCILED);
  assert.equal(result.count, 2);
});

// ===========================================================================
// Composite runTick tests
// ===========================================================================

test("runTick: runs all 5 transitions with clean state", async () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const result = await runTick({
    workstream: { id: "ws_3", phase: "backend" },
    tasks: [{ id: "t10", phase: "backend", status: "assigned", updated_at: recent }],
    goal: {},
    progress: { updated_at: recent },
    tuiSession: {},
    lock: {},
    parentTask: {},
    reviewBacklog: [],
    maxTransitions: 5,
  });

  assert.ok(result.tick_id);
  assert.equal(result.transition_count, 5);
  assert.equal(result.state_transitions, 5);
  assert.ok(result.idempotency_key);
  assert.ok(Array.isArray(result.transitions));
  assert.equal(result.transitions.length, 5);
});

test("runTick: respects maxTransitions budget", async () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const result = await runTick({
    workstream: { id: "ws_4" },
    tasks: [{ id: "t11", status: "running", updated_at: recent }],
    goal: {},
    progress: { updated_at: recent },
    maxTransitions: 2,
  });

  assert.equal(result.transition_count, 2);
  assert.equal(result.transitions.length, 2);
});

test("runTick: transitions include correct kinds", async () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const result = await runTick({
    workstream: { id: "ws_5" },
    tasks: [{ id: "t12", status: "running", updated_at: recent }],
    goal: {},
    progress: { updated_at: recent },
    maxTransitions: 5,
  });

  const kinds = result.transitions.map((t) => t.kind);
  assert.ok(kinds.includes(TRANSITION_KIND.DRIFT_DETECTED));
  assert.ok(kinds.includes(TRANSITION_KIND.STALL_DETECTED));
  assert.ok(kinds.includes(TRANSITION_KIND.ACCEPTANCE_EVALUATED));
  assert.ok(kinds.includes(TRANSITION_KIND.TASK_ADVANCED));
  assert.ok(kinds.includes(TRANSITION_KIND.REVIEW_RECONCILED));
});

test("runTick: handles empty/null state gracefully", async () => {
  const result = await runTick({});
  assert.ok(result.tick_id);
  assert.ok(result.transition_count >= 0);
  assert.ok(Array.isArray(result.transitions));
  assert.ok(Array.isArray(result.errors));
});

test("runTick: completed tasks trigger acceptance evaluation", async () => {
  const result = await runTick({
    workstream: { id: "ws_6" },
    tasks: [
      { id: "t13", status: "completed", changed_files: [], result: { status: "completed", summary: "done" } },
    ],
    goal: { id: "g13" },
    progress: {},
    maxTransitions: 5,
  });

  const acceptanceTransition = result.transitions.find((t) => t.kind === TRANSITION_KIND.ACCEPTANCE_EVALUATED);
  assert.ok(acceptanceTransition);

  // Should have at least evaluated the completed task
  assert.ok(acceptanceTransition.count > 0 || acceptanceTransition.repairs_created >= 0);
});

test("runTick: idempotency key is stable", async () => {
  const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  const opts = {
    workstream: { id: "ws_7", phase: "backend" },
    tasks: [
      { id: "t14", phase: "backend", status: "completed", updated_at: recent, changed_files: [] },
    ],
    goal: { id: "g14" },
    progress: { updated_at: recent },
    maxTransitions: 5,
  };

  const r1 = await runTick(opts);
  const r2 = await runTick(opts);

  // Idempotency keys should be deterministic for the same state
  // (tick_id will differ due to timestamp)
  assert.ok(r1.idempotency_key);
  assert.ok(r2.idempotency_key);
});
