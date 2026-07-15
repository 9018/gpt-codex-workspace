/**
 * retention-productization.test.mjs — Tests for retention productization.
 *
 * Tests:
 * - getRecentRetentionCleanups reads from admin audit log
 * - dry-run cleanup makes no state mutations
 * - apply cleanup only touches terminal eligible items
 * - active items preserved even when over limit
 * - audit log written after apply
 * - product_status view includes retention fields
 * - productStatusCard renders retention cleanup history
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { getRecentRetentionCleanups, retentionCleanup } from "../src/retention-service.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createStore(state) {
  const dir = track(mkdtempSync(join(tmpdir(), "retention-prod-test-")));
  const statePath = join(dir, "state.json");
  const s = new StateStore({ statePath, defaultWorkspaceRoot: dir });
  s.state = state;
  await s.save();
  return { store: s, dir };
}

function makeTask(id, status, date) {
  return { id, status, assignee: "codex", title: "Test " + id, created_at: date, updated_at: date, attempt: 0, max_attempts: 2, logs: [] };
}

function makeGoal(id, status, date) {
  return { id, status, created_at: date, updated_at: date, title: "Goal " + id };
}

async function createGoalDir(root, goalId, status, date) {
  const gd = join(root, ".gptwork", "goals", goalId);
  await mkdir(gd, { recursive: true });
  await writeFile(join(gd, "context.json"), JSON.stringify({
    goal: { id: goalId, status, created_at: date, updated_at: date },
  }), "utf8");
  await writeFile(join(gd, "transcript.md"), "test transcript\n".repeat(3), "utf8");
  await writeFile(join(gd, "result.md"), "test result\n", "utf8");
}

async function writeAdminAudit(dir, entries) {
  const auditPath = join(dir, ".gptwork", "admin-audit.jsonl");
  await mkdir(join(dir, ".gptwork"), { recursive: true });
  for (const entry of entries) {
    writeFileSync(auditPath, JSON.stringify(entry) + "\n", { flag: "a" });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("getRecentRetentionCleanups returns empty when no audit log", async () => {
  const dir = track(mkdtempSync(join(tmpdir(), "retention-empty-")));
  const result = await getRecentRetentionCleanups({ workspaceRoot: dir });
  assert.equal(result.count, 0);
  assert.deepEqual(result.cleanups, []);
});

test("getRecentRetentionCleanups reads retention entries from audit log", async () => {
  const dir = track(mkdtempSync(join(tmpdir(), "retention-audit-")));
  await mkdir(join(dir, ".gptwork"), { recursive: true });

  // Write some audit entries
  await writeAdminAudit(dir, [
    { audit_id: "audit_1", timestamp: "2026-07-01T00:00:00Z", tool: "retention_cleanup", dry_run: true, apply: false, limit: 50, result: "ok", summary: "changes=5 skipped=3 elapsed=100ms" },
    { audit_id: "audit_2", timestamp: "2026-07-02T00:00:00Z", tool: "retention_cleanup", dry_run: false, apply: true, limit: 50, result: "ok", summary: "changes=3 skipped=5 elapsed=200ms" },
    { audit_id: "audit_3", timestamp: "2026-07-03T00:00:00Z", tool: "other_tool", result: "ok", summary: "unrelated" },
  ]);

  const result = await getRecentRetentionCleanups({ workspaceRoot: dir });

  assert.equal(result.count, 2);
  assert.equal(result.cleanups[0].audit_id, "audit_2", "Newest first");
  assert.equal(result.cleanups[1].audit_id, "audit_1");
  assert.equal(result.cleanups[0].dry_run, false);
  assert.equal(result.cleanups[0].applied, true);
  assert.equal(result.cleanups[0].changes_count, 3);
  assert.equal(result.cleanups[1].dry_run, true);
  assert.equal(result.cleanups[1].applied, false);
  assert.equal(result.cleanups[1].changes_count, 5);
});

test("getRecentRetentionCleanups respects maxRecords", async () => {
  const dir = track(mkdtempSync(join(tmpdir(), "retention-max-")));
  await mkdir(join(dir, ".gptwork"), { recursive: true });

  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push({
      audit_id: `audit_${i}`,
      timestamp: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      tool: "retention_cleanup",
      dry_run: i % 2 === 0,
      apply: i % 2 === 1,
      result: "ok",
      summary: `changes=${i} skipped=0 elapsed=50ms`,
    });
  }
  await writeAdminAudit(dir, entries);

  const allResult = await getRecentRetentionCleanups({ workspaceRoot: dir, maxRecords: 20 });
  assert.equal(allResult.count, 20);

  const limitedResult = await getRecentRetentionCleanups({ workspaceRoot: dir, maxRecords: 3 });
  assert.equal(limitedResult.count, 3);
  assert.equal(limitedResult.cleanups[0].audit_id, "audit_19");
  assert.equal(limitedResult.cleanups[2].audit_id, "audit_17");
});

test("retentionCleanup dry-run does not mutate state or files", async () => {
  const { store, dir } = await createStore({
    tasks: [makeTask("t1", "completed", "2025-01-01T00:00:00Z"), makeTask("t2", "running", "2026-07-01T00:00:00Z")],
    goals: [makeGoal("g1", "completed", "2025-01-01T00:00:00Z"), makeGoal("g2", "open", "2026-07-01T00:00:00Z")],
    goal_queue: [],
    conversations: [],
    memories: [],
    agent_runs: [],
    chatgpt_requests: [],
    activities: [],
    audit: [],
  });

  // Create a terminal goal directory
  await createGoalDir(dir, "goal_g1", "completed", "2025-01-01T00:00:00Z");
  const goalDirPath = join(dir, ".gptwork", "goals", "goal_g1");
  assert.ok(existsSync(goalDirPath), "Goal dir should exist before dry-run");

  const result = await retentionCleanup({
    store,
    workspaceRoot: dir,
    limit: 1,
    dryRun: true,
    archiveBeforeDelete: false,
  });

  // Dry-run should report changes but NOT mutate
  assert.equal(result.dry_run, true, "Should be dry run");
  assert.equal(result.applied, false, "Should not be applied");
  assert.ok(result.changes_count > 0 || result.skipped_count > 0, "Should report changes/skipped");

  // State should be unchanged
  const stateAfter = await store.load();
  assert.equal(stateAfter.tasks.length, 2, "Tasks unchanged after dry-run");
  assert.equal(stateAfter.tasks[0].status, "completed", "Task status unchanged");
  assert.equal(stateAfter.tasks[1].status, "running", "Running task unchanged");

  // Goal directory should still exist
  assert.ok(existsSync(goalDirPath), "Goal dir should still exist after dry-run");
});

test("retentionCleanup apply only removes terminal eligible items, preserves active", async () => {
  const { store, dir } = await createStore({
    tasks: [
      makeTask("t_old_completed", "completed", "2025-01-01T00:00:00Z"),
      makeTask("t_running", "running", "2026-07-01T00:00:00Z"),
      makeTask("t_new_completed", "completed", "2026-07-01T00:00:00Z"),
      makeTask("t_queued", "queued", "2026-07-01T00:00:00Z"),
    ],
    goals: [],
    goal_queue: [],
    conversations: [],
    memories: [],
    agent_runs: [],
    chatgpt_requests: [],
    activities: [],
    audit: [],
  });

  const result = await retentionCleanup({
    store,
    workspaceRoot: dir,
    limit: 1,  // keep only 1 terminal item per category
    dryRun: false,
    archiveBeforeDelete: false,
  });

  assert.equal(result.dry_run, false);
  assert.equal(result.applied, true);

  // Running/queued tasks should be preserved
  const stateAfter = await store.load();
  const runningTask = stateAfter.tasks.find(t => t.id === "t_running");
  const queuedTask = stateAfter.tasks.find(t => t.id === "t_queued");
  assert.ok(runningTask, "Running task should be preserved");
  assert.ok(queuedTask, "Queued task should be preserved");
  assert.equal(runningTask.status, "running");

  // At least one terminal item may be removed if over limit
  const fullCompletedCount = stateAfter.tasks.filter(t => t.status === "completed" && t.retention_compacted !== true).length;
  const compactedCount = stateAfter.tasks.filter(t => t.status === "completed" && t.retention_compacted === true).length;
  // With limit=1, at most 1 full terminal task remains; older history is retained as safe tombstones.
  assert.ok(fullCompletedCount <= 1, "At most 1 full terminal task should remain after apply with limit=1");
  assert.ok(compactedCount >= 1, "Older terminal tasks should be compacted into historical tombstones");

  // Audit log should have been written
  const auditResult = await getRecentRetentionCleanups({ workspaceRoot: dir });
  assert.ok(auditResult.count > 0, "Audit log should have recent retention cleanup entry");
  const lastCleanup = auditResult.cleanups[0];
  assert.equal(lastCleanup.applied, true, "Last cleanup should be applied");
  assert.equal(lastCleanup.dry_run, false, "Last cleanup should not be dry-run");
});

test("retentionCleanup audit has before/after counts", async () => {
  const { store, dir } = await createStore({
    tasks: [
      makeTask("t1", "completed", "2025-01-01T00:00:00Z"),
      makeTask("t2", "completed", "2025-06-01T00:00:00Z"),
      makeTask("t3", "running", "2026-07-01T00:00:00Z"),
    ],
    goals: [],
    goal_queue: [],
    conversations: [],
    memories: [],
    agent_runs: [],
    chatgpt_requests: [],
    activities: [],
    audit: [],
  });

  const result = await retentionCleanup({
    store,
    workspaceRoot: dir,
    limit: 1,
    dryRun: false,
    archiveBeforeDelete: false,
  });

  // Result should have before/after counts
  assert.ok(result.before, "Should have before state");
  assert.ok(result.after, "Should have after state");
  assert.ok(typeof result.before.tasks === "number", "before.tasks should be a number");
  assert.ok(typeof result.after.tasks === "number", "after.tasks should be a number");
  assert.equal(result.before.tasks, 3, "Before should have 3 tasks");
  assert.equal(result.after.tasks, 3, "Compaction preserves task identity while reducing historical payload");
  const compacted = (await store.load()).tasks.filter((task) => task.retention_compacted === true);
  assert.ok(compacted.length >= 1, "At least one old terminal task should be compacted");
});

test("product_status view includes retention_recent_cleanups field shape", async () => {
  // Test that the expected field names exist in the data shape
  // We import and test the data shape contract
  const { collectProductStatus } = await import("../src/product-status-view.mjs");

  // We can't easily call collectProductStatus without full services,
  // but we can test the formatProductStatus shape expectations

  // Verify the product-status card handles retention_recent_cleanups gracefully
  const { productStatusCard } = await import("../src/product-status-view.mjs");

  // Test with null cleanups
  const dataWithNullCleanups = {
    scanned_at: "2026-07-06T10:00:00.000Z",
    elapsed_ms: 12,
    summary: "test",
    system: { pid: 1, worktree_dirty: false, dirty_paths: [], runtime_env_loaded: true, tool_mode: "standard" },
    worker: { enabled: true, running: true, health_phase: "running" },
    queue: { assigned: 0, queued: 0, running: 0, completed: 0, failed: 0 },
    current_blockers: { raw: 0, policy_filtered: 0, policy_excluded: 0 },
    review_classification: { categories: { human_required: 0, machine_repairable: 0, resolved_history: 0 }, total: 0, actionable_review: 0 },
    raw_historical: { raw_legacy_resolved: 0, raw_unresolved: 0, total_codex_tasks: 0, total_tasks: 0, total_goals: 0 },
    retention: { pressure: "none", limit: 50, tasks: 0, goals: 0, details: [] },
    retention_recent_cleanups: null,
    retention_last_cleanup: null,
    canonical_outcome_health: { tasks_with_unified_decision: 0, tasks_without_unified_decision: 0, canonical_outcome_counts: {}, tasks_with_canonical_blockers: 0, tasks_degraded_outcome: 0, total_codex_tasks: 0 },
    context_bundle_health: { healthy: 0, degraded: 0, stale: 0, total_codex_tasks: 0 },
    config: { bark_enabled: false, github_enabled: false, agent_backend: "codex_exec" },
    next_actions: [],
    _diagnostics: { warnings: [] },
  };

  // Should render without error
  const card = productStatusCard(dataWithNullCleanups);
  assert.ok(typeof card === "string", "Product status card should render as string");
  assert.ok(card.includes("Retention"), "Card should include Retention section");

  // Test with actual cleanups
  const dataWithCleanups = {
    ...dataWithNullCleanups,
    retention_recent_cleanups: [
      { audit_id: "audit_1", timestamp: "2026-07-02T00:00:00Z", dry_run: false, applied: true, summary: "changes=3 skipped=5", changes_count: 3 },
    ],
    retention_last_cleanup: "2026-07-02T00:00:00Z",
  };

  const card2 = productStatusCard(dataWithCleanups);
  assert.ok(typeof card2 === "string", "Card should render with cleanups");
  assert.ok(card2.includes("Recent Cleanups"), "Should include Recent Cleanups section");
});
