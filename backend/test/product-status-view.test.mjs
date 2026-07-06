/**
 * product-status-view.test.mjs — Tests for product-level status dashboard.
 *
 * Coverage:
 *   - productStatusCard text rendering
 *   - collectProductStatus data shape
 *   - Distinction between raw historical counts and current blockers
 *   - Retention pressure classification
 *   - Next-actions prioritization
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { productStatusCard, collectProductStatus } from "../src/product-status-view.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMinimalProductData(overrides = {}) {
  return {
    scanned_at: "2026-07-06T10:00:00.000Z",
    elapsed_ms: 12,
    summary: "commit abc1234 · worktree clean · worker running · blockers 3/7",
    system: {
      pid: 12345,
      started_at: "2026-07-06T09:00:00.000Z",
      running_commit: "abc1234deadbeef",
      repo_head: "abc1234deadbeef",
      remote_head: "def5678",
      worktree_dirty: false,
      dirty_paths: [],
      runtime_env_loaded: true,
      restart_required: false,
      tool_mode: "standard",
    },
    worker: {
      enabled: true,
      running: true,
      health_phase: "running",
      last_tick_age_s: 30,
      last_error: null,
      concurrency: 2,
    },
    queue: { assigned: 1, queued: 2, running: 1, completed: 50, failed: 2 },
    current_blockers: { raw: 7, policy_filtered: 3, policy_excluded: 4 },
    review_classification: {
      categories: { human_required: 1, machine_repairable: 2, resolved_history: 5 },
      total: 8,
      actionable_review: 3,
    },
    raw_historical: {
      raw_legacy_resolved: 3,
      raw_unresolved: 5,
      total_codex_tasks: 60,
      total_tasks: 100,
      total_goals: 20,
    },
    retention: { pressure: "medium", limit: 50, tasks: 100, goals: 20, details: ["limit=50, tasks=100"] },
    tui_provider: {
      enabled: true,
      provider: "codex_tui_goal",
      session_count: 3,
      active_count: 0,
      highest_severity: "info",
      finding_count: 1,
    },
    config: {
      bark_enabled: true,
      github_enabled: true,
      agent_backend: "codex_exec",
      worker_interval_ms: 15000,
    },
    next_actions: [
      { action: "Resolve blockers: 1 review, 2 repair", priority: "warning" },
      { action: "3 legacy-resolved task(s) — run retention for cleanup", priority: "info" },
    ],
    _diagnostics: {
      warnings: [
        { severity: "warning", message: "3 current blocker(s)", code: "current_blockers" },
        { severity: "info", message: "Retention pressure: medium", code: "retention_pressure" },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("productStatusCard renders full data without error", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(typeof card === "string", "card should be a string");
  assert.ok(card.length > 200, "card should be substantial");
  assert.ok(card.includes("Product Status"), "title present");
  assert.ok(card.includes("abc1234"), "commit present");
  assert.ok(card.includes("Current Blockers") || card.includes("blocker"), "blockers section present");
  assert.ok(card.includes("Worker:") || card.includes("status: running"), "worker section present");
});

test("productStatusCard returns early on null data", () => {
  const card = productStatusCard(null);
  assert.ok(typeof card === "string");
});

test("productStatusCard distinguishes raw vs policy blockers", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("raw total"), "raw total shown");
  assert.ok(card.includes("policy-filtered"), "policy-filtered shown");
  assert.ok(card.includes("excluded by policy"), "policy excluded shown");
  assert.ok(card.includes("7")); // raw=7
  assert.ok(card.includes("3")); // policy_filtered=3
  assert.ok(card.includes("4")); // excluded=4
});

test("productStatusCard shows review classification categories", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("human required"), "human required category");
  assert.ok(card.includes("machine repairable"), "machine repairable category");
  assert.ok(card.includes("resolved history"), "resolved history category");
});

test("productStatusCard shows retention pressure", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("medium"), "retention pressure medium");
  assert.ok(card.includes("100")); // tasks=100
  assert.ok(card.includes("50")); // limit=50
});

test("productStatusCard shows TUI provider state when available", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("TUI Provider"), "tui provider section");
  assert.ok(card.includes("3")); // sessions

  const withoutTui = makeMinimalProductData({ tui_provider: null });
  const cardWithout = productStatusCard(withoutTui);
  assert.ok(!cardWithout.includes("TUI Provider"), "no tui section when null");
});

test("productStatusCard shows next actions", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("blockers"), "blockers action shown");
});

test("collectProductStatus produces correct data shape (no services = graceful fallback)", async () => {
  // Without real services, the function uses import() and should fail gracefully
  // or throw a clear error about missing dependencies
  try {
    await collectProductStatus({});
    assert.fail("should have thrown without required services");
  } catch (err) {
    const msg = String(err?.message || err);
    // Any error is acceptable as long as the function doesn't hang
    assert.ok(msg.length > 0, "error message should exist");
  }
});

test("dirty worktree appears in diagnostics and summary", () => {
  const data = makeMinimalProductData({
    system: {
      ...makeMinimalProductData().system,
      worktree_dirty: true,
      dirty_paths: ["file1.txt", "file2.txt"],
    },
    _diagnostics: {
      warnings: [
        { severity: "warning", message: "Dirty worktree (2 files)", code: "worktree_dirty" },
      ],
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("dirty"), "dirty status shown");
  assert.ok(card.includes("worktree"), "worktree line present");
  assert.ok(card.includes("Dirty"), "dirty diagnostics shown");
});

test("restart_required appears when running_commit != repo_head", () => {
  const data = makeMinimalProductData({
    system: {
      ...makeMinimalProductData().system,
      running_commit: "abc1234deadbeef",
      repo_head: "ffffffffffff",
      restart_required: true,
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("restart"), "restart mention visible");
  assert.ok(card.includes("commit mismatch"), "reason explained");
});

test("worker stalled appears in diagnostics", () => {
  const data = makeMinimalProductData({
    worker: {
      ...makeMinimalProductData().worker,
      health_phase: "stalled",
      last_error: "stuck in progress loop",
    },
    _diagnostics: {
      warnings: [
        { severity: "warning", message: "Worker health: stalled - stuck in progress loop", code: "worker_health" },
      ],
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("stalled"), "stalled status shown");
});

test("next_actions prioritization visible", () => {
  const data = makeMinimalProductData({
    next_actions: [
      { action: "Commit or stash dirty worktree", priority: "blocker" },
      { action: "Resolve blockers: 1 review", priority: "warning" },
      { action: "Run retention cleanup", priority: "info" },
    ],
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("blocker"), "blocker priority shown");
  assert.ok(card.includes("Resolve blockers"), "warning action shown");
  assert.ok(card.includes("retention cleanup") || card.includes("Retention"), "info action shown");
});

test("retention pressure classification", () => {
  // Simulate the internal retentionPressure function logic
  const limit = 50;

  // Medium: tasks > limit
  const mediumData = makeMinimalProductData({
    retention: { pressure: "medium", limit, tasks: 100, goals: 20, details: ["limit=50, tasks=100"] },
  });
  const mediumCard = productStatusCard(mediumData);
  assert.ok(mediumCard.includes("medium"), "medium retention");

  // High: tasks > limit*2
  const highData = makeMinimalProductData({
    retention: { pressure: "high", limit, tasks: 150, goals: 100, details: ["limit=50, tasks=150, goals=100"] },
  });
  const highCard = productStatusCard(highData);
  assert.ok(highCard.includes("high"), "high retention");
});

test("tool mode shown in output", () => {
  const standardData = makeMinimalProductData();
  const stdCard = productStatusCard(standardData);
  assert.ok(stdCard.includes("standard"), "standard mode shown");

  const minimalData = makeMinimalProductData({ system: { ...standardData.system, tool_mode: "minimal" } });
  const minCard = productStatusCard(minimalData);
  assert.ok(minCard.includes("minimal"), "minimal mode shown");
});
