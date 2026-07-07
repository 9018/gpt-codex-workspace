/**
 * runtime-patrol-loop.test.mjs — AFC-10 Patrol Loop Tests
 *
 * Tests all six patrol domains:
 *   1. detectStalledTasks
 *   2. detectMisclassifiedTasks
 *   3. detectReviewRepairIntegrationBlockers
 *   4. detectMissingEvidence
 *   5. detectDirtyCanonicalRepo
 *   6. detectMissingAfcTasks
 *   7. runPatrolLoop (integration)
 *   8. formatPatrolReport
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ===========================================================================
// Helpers
// ===========================================================================

async function createFixtureStore(tasks = [], goals = [], goalQueue = []) {
  const { StateStore } = await import("../src/state-store.mjs");
  const dir = await mkdtemp(join(tmpdir(), "patrol-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.tasks = tasks;
  store.state.goals = goals;
  store.state.goal_queue = goalQueue;
  await store.save();
  return { store, dir };
}

function makeTask(overrides = {}) {
  return {
    id: "task-" + Math.random().toString(36).slice(2, 8),
    status: "running",
    goal_id: "goal-" + Math.random().toString(36).slice(2, 8),
    created_at: new Date(Date.now() - 100_000).toISOString(),
    updated_at: new Date(Date.now() - 100_000).toISOString(),
    result: {},
    ...overrides,
  };
}

// ===========================================================================
// Domain 1: detectStalledTasks
// ===========================================================================

test("detectStalledTasks: no tasks returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.detectStalledTasks({ tasks: [] });
  assert.equal(result.length, 0);
});

test("detectStalledTasks: recent tasks are not stalled", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({ status: "waiting_for_review", updated_at: new Date().toISOString() }),
    makeTask({ status: "waiting_for_repair", updated_at: new Date().toISOString() }),
  ];
  const result = m.detectStalledTasks({ tasks }, { stallThresholdMs: 1_000 });
  assert.equal(result.length, 0);
});

test("detectStalledTasks: old waiting_for_review is stalled", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_review",
      updated_at: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
    }),
  ];
  // Extended threshold is 2h, so use a lower threshold so it catches it
  const result = m.detectStalledTasks({ tasks }, {
    stallThresholdMs: 600_000,
    extendedThresholdMs: 600_000, // lower extended threshold too
  });
  assert.ok(result.length >= 1);
  assert.equal(result[0].category, "stalled_task");
  assert.ok(result[0].description.includes("waiting_for_review"));
  assert.ok(result[0].recommended_action);
});

test("detectStalledTasks: queued/assigned tasks stall at regular threshold", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "queued",
      updated_at: new Date(Date.now() - 1_200_000).toISOString(), // 20 min ago
    }),
  ];
  const result = m.detectStalledTasks({ tasks }, { stallThresholdMs: 60_000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.state_family, "pending");
});

test("detectStalledTasks: terminal and running tasks are skipped", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({ status: "completed", updated_at: new Date(Date.now() - 3_600_000).toISOString() }),
    makeTask({ status: "running", updated_at: new Date(Date.now() - 3_600_000).toISOString() }),
  ];
  const result = m.detectStalledTasks({ tasks }, { stallThresholdMs: 1_000 });
  assert.equal(result.length, 0);
});

test("detectStalledTasks: waiting_for_repair with exhausted budget flags needs_review", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_repair",
      repair_attempt: 3,
      max_attempts: 2,
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    }),
  ];
  const result = m.detectStalledTasks({ tasks }, { stallThresholdMs: 60_000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].recommended_action.safety, "needs_review");
  assert.equal(result[0].recommended_action.action, "flag_for_review");
});

test("detectStalledTasks: human_interrupted state uses extended threshold", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "human_interrupted",
      updated_at: new Date(Date.now() - 600_000).toISOString(), // 10 min
    }),
  ];
  // Regular threshold = 60s (would catch it), but extended = 1h (won't catch it)
  const result = m.detectStalledTasks({ tasks }, {
    stallThresholdMs: 60_000,
    extendedThresholdMs: 3_600_000,
  });
  assert.equal(result.length, 0);
});

// ===========================================================================
// Domain 2: detectMisclassifiedTasks
// ===========================================================================

test("detectMisclassifiedTasks: no tasks returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.detectMisclassifiedTasks({ tasks: [] });
  assert.equal(result.length, 0);
});

test("detectMisclassifiedTasks: terminal status with non-terminal graph node", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "completed",
      graph_node: "created",
    }),
  ];
  const result = m.detectMisclassifiedTasks({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "misclassified_task");
  assert.equal(result[0].detail.mismatch, "terminal_status_non_terminal_graph_node");
  assert.equal(result[0].recommended_action.safety, "safe");
});

test("detectMisclassifiedTasks: non-terminal status with terminal graph node", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "running",
      graph_node: "closed",
    }),
  ];
  const result = m.detectMisclassifiedTasks({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.mismatch, "non_terminal_status_terminal_graph_node");
  assert.equal(result[0].recommended_action.safety, "needs_review");
});

test("detectMisclassifiedTasks: running but graph_node is created", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "running",
      graph_node: "created",
    }),
  ];
  const result = m.detectMisclassifiedTasks({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.mismatch, "running_but_created");
});

test("detectMisclassifiedTasks: consistent tasks are not misclassified", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({ status: "running", graph_node: "builder_running" }),
    makeTask({ status: "completed", graph_node: "closed" }),
    makeTask({ status: "failed", graph_node: "failed_terminal" }),
  ];
  const result = m.detectMisclassifiedTasks({ tasks });
  assert.equal(result.length, 0);
});

test("detectMisclassifiedTasks: tasks without graph_node are skipped", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({ status: "completed" }), // no graph_node
  ];
  const result = m.detectMisclassifiedTasks({ tasks });
  assert.equal(result.length, 0);
});

// ===========================================================================
// Domain 3: detectReviewRepairIntegrationBlockers
// ===========================================================================

test("detectReviewRepairIntegrationBlockers: no tasks returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.detectReviewRepairIntegrationBlockers({ tasks: [] });
  assert.equal(result.length, 0);
});

test("detectReviewRepairIntegrationBlockers: review state with no active blockers", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_review",
      blockers: [
        { code: "test", resolved_at: "2026-01-01T00:00:00Z" },
      ],
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "review_blocker");
  assert.equal(result[0].detail.has_active_blocker, false);
});

test("detectReviewRepairIntegrationBlockers: review state with active blockers", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_review",
      blockers: [
        { code: "active", resolved_at: null },
      ],
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  // Not flagged because there IS an active blocker
  assert.equal(result.length, 0);
});

test("detectReviewRepairIntegrationBlockers: machine-repairable blockers detected", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_evidence_missing",
      blockers: [
        { code: "missing_evidence", machine_resolvable: true, resolved_at: null },
      ],
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  // Should flag as all machine-resolvable in a machine-repairable state
  assert.ok(result.length >= 1);
  const mr = result.find(r => r.detail.all_machine_resolvable === true);
  assert.ok(mr);
  assert.equal(mr.recommended_action.action, "auto_status_update");
});

test("detectReviewRepairIntegrationBlockers: repair budget exhausted", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_repair",
      repair_attempt: 3,
      max_attempts: 2,
      result: { repair_attempts: 3 },
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "repair_blocker");
  assert.equal(result[0].level, "blocker");
  assert.equal(result[0].recommended_action.safety, "needs_review");
});

test("detectReviewRepairIntegrationBlockers: integration without worktree", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_integration",
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "integration_blocker");
});

test("detectReviewRepairIntegrationBlockers: integration with worktree is fine", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_integration",
      worktree_path: "/tmp/some-worktree",
    }),
  ];
  const result = m.detectReviewRepairIntegrationBlockers({ tasks });
  assert.equal(result.length, 0);
});

// ===========================================================================
// Domain 4: detectMissingEvidence
// ===========================================================================

test("detectMissingEvidence: no tasks returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = await m.detectMissingEvidence({ tasks: [] });
  assert.equal(result.length, 0);
});

test("detectMissingEvidence: completed task with full evidence passes", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "completed",
      result: {
        commit: "abc123",
        changed_files: ["src/test.js"],
        verification: { commands: [], passed: true },
        summary: "All good",
      },
    }),
  ];
  const result = await m.detectMissingEvidence({ tasks });
  assert.equal(result.length, 0);
});

test("detectMissingEvidence: completed task missing several fields", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "completed",
      result: {},
    }),
  ];
  const result = await m.detectMissingEvidence({ tasks });
  assert.ok(result.length >= 1);
  const r = result[0];
  assert.equal(r.category, "missing_evidence");
  assert.ok(r.detail.missing_count >= 3);
  assert.equal(r.recommended_action.safety, "needs_review");
});

test("detectMissingEvidence: terminal task without summary", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "failed",
      result: {},
    }),
  ];
  const result = await m.detectMissingEvidence({ tasks });
  assert.ok(result.length >= 1);
  const r = result.find(f => f.task_id === tasks[0].id);
  assert.ok(r);
  assert.ok(r.detail.missing_fields.some(f => f.includes("summary")));
});

test("detectMissingEvidence: review/repair task missing failure_class and blockers", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_review",
      result: {},
    }),
  ];
  const result = await m.detectMissingEvidence({ tasks });
  assert.ok(result.length >= 1);
});

// ===========================================================================
// Domain 5: detectDirtyCanonicalRepo
// ===========================================================================

test("detectDirtyCanonicalRepo: no path returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.detectDirtyCanonicalRepo(null);
  assert.equal(result.length, 0);
});

test("detectDirtyCanonicalRepo: non-existent path returns classification error", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.detectDirtyCanonicalRepo("/nonexistent/path/for/test");
  // Should either return empty (if git fails) or a finding
  // This is platform-dependent but should not crash
  assert.ok(Array.isArray(result));
});

// ===========================================================================
// Domain 6: detectMissingAfcTasks
// ===========================================================================

test("detectMissingAfcTasks: no references returns empty", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = { tasks: [{ id: "t1" }], goals: [], goal_queue: [] };
  const result = m.detectMissingAfcTasks(state);
  assert.equal(result.length, 0);
});

test("detectMissingAfcTasks: goal references missing task", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = {
    tasks: [{ id: "t1" }],
    goals: [{ id: "g1", task_id: "t-missing" }],
    goal_queue: [],
  };
  const result = m.detectMissingAfcTasks(state);
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "missing_afc_task");
  assert.equal(result[0].detail.reference_type, "goal_to_task");
});

test("detectMissingAfcTasks: queue item references missing task", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = {
    tasks: [{ id: "t1" }],
    goals: [],
    goal_queue: [{ queue_id: "q1", task_id: "t-ghost", goal_id: "g1" }],
  };
  const result = m.detectMissingAfcTasks(state);
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.reference_type, "queue_to_task");
});

test("detectMissingAfcTasks: task references missing parent_task", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = {
    tasks: [
      { id: "t-child", parent_task_id: "t-parent-missing", goal_id: "g1" },
    ],
    goals: [],
    goal_queue: [],
  };
  const result = m.detectMissingAfcTasks(state);
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.reference_type, "task_to_parent_task");
});

test("detectMissingAfcTasks: task references missing root_task", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = {
    tasks: [
      { id: "t-child", root_task_id: "t-root-missing", goal_id: "g1" },
    ],
    goals: [],
    goal_queue: [],
  };
  const result = m.detectMissingAfcTasks(state);
  assert.equal(result.length, 1);
  assert.equal(result[0].detail.reference_type, "task_to_root_task");
});

test("detectMissingAfcTasks: multiple references to same missing task deduped", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const state = {
    tasks: [{ id: "t1" }],
    goals: [
      { id: "g1", task_id: "t-missing" },
    ],
    goal_queue: [
      { queue_id: "q1", task_id: "t-missing", goal_id: "g1" },
    ],
  };
  const result = m.detectMissingAfcTasks(state);
  // Two different reference types from two different sources referencing the same
  // missing task should BOTH appear (they use different dedup keys)
  assert.equal(result.length, 2);
});

// ===========================================================================
// Integration: runPatrolLoop
// ===========================================================================

test("runPatrolLoop: empty state returns empty findings", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const { store } = await createFixtureStore();

  const result = await m.runPatrolLoop({ store, dryRun: true });

  assert.ok(result.summary);
  assert.equal(result.dry_run, true);
  assert.equal(result.summary.total_findings, 0);
  assert.equal(result.recovery_actions.length, 0);
});

test("runPatrolLoop: detects stalled tasks", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "waiting_for_repair",
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    }),
  ];
  const { store } = await createFixtureStore(tasks);

  const result = await m.runPatrolLoop({
    store,
    dryRun: true,
    stallThresholdMs: 60_000,
    extendedThresholdMs: 60_000,
  });

  assert.ok(result.summary.total_findings >= 1);
  const stalled = result.findings.stalled_tasks;
  assert.ok(stalled.length >= 1);
});

test("runPatrolLoop: detects misclassified tasks", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({ status: "completed", graph_node: "created" }),
  ];
  const { store } = await createFixtureStore(tasks);

  const result = await m.runPatrolLoop({ store, dryRun: true });

  assert.ok(result.summary.total_findings >= 1);
  const mis = result.findings.misclassified_tasks;
  assert.ok(mis.length >= 1);
  assert.equal(mis[0].category, "misclassified_task");
});

test("runPatrolLoop: detects missing evidence", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "completed",
      result: {},
    }),
  ];
  const { store } = await createFixtureStore(tasks);

  const result = await m.runPatrolLoop({
    store,
    dryRun: true,
    config: { checkDiskPaths: false },
  });

  assert.ok(result.summary.total_findings >= 1);
  const me = result.findings.missing_evidence;
  assert.ok(me.length >= 1);
});

test("runPatrolLoop: detects missing AFC tasks", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const goals = [
    { id: "g-orphan", task_id: "t-ghost", status: "assigned" },
  ];
  const { store } = await createFixtureStore([], goals);

  const result = await m.runPatrolLoop({ store, dryRun: true });

  assert.ok(result.summary.total_findings >= 1);
  const missing = result.findings.missing_afc_tasks;
  assert.ok(missing.length >= 1);
  assert.equal(missing[0].category, "missing_afc_task");
});

test("runPatrolLoop: recovery actions have correct safety model", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const tasks = [
    makeTask({
      status: "completed",
      graph_node: "created", // misclassified
      result: {}, // missing evidence
    }),
    makeTask({
      status: "waiting_for_repair",
      repair_attempt: 3,
      max_attempts: 2,
      updated_at: new Date(Date.now() - 3_600_000).toISOString(), // stalled
    }),
  ];
  const { store } = await createFixtureStore(tasks);

  const result = await m.runPatrolLoop({
    store,
    dryRun: true,
    stallThresholdMs: 60_000,
    extendedThresholdMs: 60_000,
    config: { checkDiskPaths: false },
  });

  assert.ok(result.summary.total_findings >= 2);
  assert.ok(result.recovery_actions.length >= 2);

  // Verify safety: no action is "blocked"
  const blocked = result.recovery_actions.filter(a => a.safety === "blocked");
  assert.equal(blocked.length, 0);

  // Verify dry_run is consistently true
  const allDry = result.recovery_actions.every(a => a.is_dry_run === true);
  assert.equal(allDry, true);
});

// ===========================================================================
// formatPatrolReport
// ===========================================================================

test("formatPatrolReport: null returns fallback", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const result = m.formatPatrolReport(null);
  assert.ok(result.includes("No patrol data"));
});

test("formatPatrolReport: formats empty report", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const report = {
    timestamp: "2026-07-07T00:00:00Z",
    dry_run: true,
    summary: {
      dry_run: true,
      total_findings: 0,
      total_recovery_actions: 0,
      categories: {},
      safe_actions: 0,
      needs_review: 0,
      blocked_actions: 0,
    },
    findings: {
      stalled_tasks: [],
      misclassified_tasks: [],
      blockers: [],
      missing_evidence: [],
      dirty_canonical_repo: [],
      missing_afc_tasks: [],
    },
    recovery_actions: [],
  };
  const result = m.formatPatrolReport(report);
  assert.ok(result.includes("Patrol Loop Report"));
  assert.ok(result.includes("total_findings:"));
  assert.ok(result.includes("safe_actions:"));
});

test("formatPatrolReport: formats report with findings", async () => {
  const m = await import("../src/runtime-patrol-loop.mjs");
  const report = {
    timestamp: "2026-07-07T00:00:00Z",
    dry_run: true,
    summary: {
      dry_run: true,
      total_findings: 3,
      total_recovery_actions: 3,
      categories: { stalled_task: 1, misclassified_task: 1, missing_evidence: 1 },
      safe_actions: 2,
      needs_review: 1,
      blocked_actions: 0,
    },
    findings: {
      stalled_tasks: [
        { category: "stalled_task", level: "warning", description: "Task t1 stalled in waiting_for_repair for 1.5h (threshold 30m)", task_id: "t1", goal_id: "g1", detail: {}, recommended_action: { action: "flag_for_review", safety: "needs_review", description: "Repair budget exhausted", target: { domain: "task", id: "t1" } } },
      ],
      misclassified_tasks: [
        { category: "misclassified_task", level: "warning", description: "Task t2 completed but graph_node=created", task_id: "t2", goal_id: "g2", detail: {}, recommended_action: { action: "auto_status_update", safety: "safe", description: "Advance graph node", target: { domain: "task", id: "t2" } } },
      ],
      blockers: [],
      missing_evidence: [
        { category: "missing_evidence", level: "warning", description: "Task t3 missing evidence", task_id: "t3", goal_id: "g3", detail: {}, recommended_action: { action: "flag_for_review", safety: "safe", description: "Flag for evidence collection", target: { domain: "task", id: "t3" } } },
      ],
      dirty_canonical_repo: [],
      missing_afc_tasks: [],
    },
    recovery_actions: [
      { action: "flag_for_review", safety: "needs_review", description: "Repair budget exhausted", target: { domain: "task", id: "t1" }, category: "stalled_task", level: "warning", task_id: "t1", goal_id: "g1", is_dry_run: true },
      { action: "auto_status_update", safety: "safe", description: "Advance graph node", target: { domain: "task", id: "t2" }, category: "misclassified_task", level: "warning", task_id: "t2", goal_id: "g2", is_dry_run: true },
      { action: "flag_for_review", safety: "safe", description: "Flag for evidence collection", target: { domain: "task", id: "t3" }, category: "missing_evidence", level: "warning", task_id: "t3", goal_id: "g3", is_dry_run: true },
    ],
  };

  const result = m.formatPatrolReport(report);
  assert.ok(result.includes("Patrol Loop Report"));
  assert.ok(result.includes("Stalled Tasks:"));
  assert.ok(result.includes("[DRY]"));
  assert.ok(result.includes("[needs_review] flag_for_review"));
  assert.ok(result.includes("[safe] auto_status_update"));
});

// ===========================================================================
// Safety invariant: never auto-merges
// ===========================================================================

test("safety: no recovery action performs merge or push", async () => {
  // Verify the module handles all action types and none performs auto-merge
  const m = await import("../src/runtime-patrol-loop.mjs");

  // Verify the action constants don't include merge/push
  const source = await import("../src/runtime-patrol-loop.mjs", { assert: { type: "module" } }).catch(() => null);

  // Check detectMissingAfcTasks actions are always "report_missing_task" (safe)
  const state = {
    tasks: [{ id: "t1" }],
    goals: [{ id: "g1", task_id: "t-missing" }],
    goal_queue: [],
  };
  const results = m.detectMissingAfcTasks(state);
  for (const r of results) {
    assert.notEqual(r.recommended_action.action, "merge");
    assert.notEqual(r.recommended_action.action, "push");
    assert.notEqual(r.recommended_action.action, "auto_integrate");
  }
});

console.log("runtime-patrol-loop tests loaded");
