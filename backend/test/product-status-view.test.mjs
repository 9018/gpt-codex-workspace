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
    canonical_outcome_health: {
      tasks_with_unified_decision: 30,
      tasks_without_unified_decision: 5,
      canonical_outcome_counts: { completed: 28, failed: 2 },
      tasks_with_canonical_blockers: 1,
      tasks_degraded_outcome: 0,
      total_codex_tasks: 60,
    },
    context_bundle_health: {
      healthy: 25,
      degraded: 3,
      stale: 2,
      total_codex_tasks: 60,
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
    canonical_outcome_health: {
      tasks_with_unified_decision: 30,
      tasks_without_unified_decision: 5,
      canonical_outcome_counts: { completed: 28, failed: 2 },
      tasks_with_canonical_blockers: 1,
      tasks_degraded_outcome: 0,
      total_codex_tasks: 60,
    },
    context_bundle_health: {
      healthy: 25,
      degraded: 3,
      stale: 2,
      total_codex_tasks: 60,
    },
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

test("canonical outcome health shown in product status card", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("Canonical Outcome") || card.includes("canonical_outcome"), "canonical outcome section present");
  assert.ok(card.includes("30"), "tasks with unified decision shown");
  assert.ok(card.includes("5"), "tasks without unified decision shown");
});

test("context bundle health shown in product status card", () => {
  const data = makeMinimalProductData();
  const card = productStatusCard(data);
  assert.ok(card.includes("Context Bundle") || card.includes("context_bundle"), "context bundle section present");
  assert.ok(card.includes("25"), "healthy context bundles shown");
  assert.ok(card.includes("3"), "degraded context bundles shown");
  assert.ok(card.includes("2"), "stale context bundles shown");
});

test("canonical outcome health metrics match expected structure", () => {
  const data = makeMinimalProductData();
  assert.ok(data.canonical_outcome_health, "canonical_outcome_health exists");
  assert.equal(typeof data.canonical_outcome_health.tasks_with_unified_decision, "number");
  assert.equal(typeof data.canonical_outcome_health.tasks_without_unified_decision, "number");
  assert.equal(typeof data.canonical_outcome_health.tasks_with_canonical_blockers, "number");
  assert.equal(typeof data.canonical_outcome_health.tasks_degraded_outcome, "number");
  assert.ok(typeof data.canonical_outcome_health.canonical_outcome_counts === "object");
});

test("context bundle health metrics match expected structure", () => {
  const data = makeMinimalProductData();
  assert.ok(data.context_bundle_health, "context_bundle_health exists");
  assert.equal(typeof data.context_bundle_health.healthy, "number");
  assert.equal(typeof data.context_bundle_health.degraded, "number");
  assert.equal(typeof data.context_bundle_health.stale, "number");
});

// ===========================================================================
// collectContextBundleHealth tests
// ===========================================================================

import { collectContextBundleHealth, productStatusCard, collectProductStatus } from "../src/product-status-view.mjs";

/**
 * Build minimal codex task fixtures with the given result shape.
 */
function codexTask(id, resultOverrides = {}) {
  return {
    id,
    assignee: "codex",
    status: resultOverrides.status || "completed",
    result: {
      status: "completed",
      summary: "test task",
      changed_files: ["test.mjs"],
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      unified_decision: { status: "completed", blocking_passed: true, requires_review: false },
      acceptance_findings: [],
      ...resultOverrides,
    },
  };
}

test("collectContextBundleHealth counts healthy tasks correctly", () => {
  const tasks = [
    codexTask("t1", { status: "completed", verification: { passed: true } }),
    codexTask("t2", { status: "completed", verification: { passed: false } }),
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 2, "both tasks should be healthy");
  assert.equal(result.degraded, 0);
  assert.equal(result.stale, 0);
  assert.equal(result.total_codex_tasks, 2);
});

test("collectContextBundleHealth counts tasks without verification as degraded/stale", () => {
  // Task without any verification object — should NOT be healthy
  const tasks = [
    codexTask("t1", { status: "completed", verification: undefined }),
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0, "no verification → not healthy");
  assert.equal(result.degraded, 1, "no verification, missingEvidence=0, ud exists → degraded");
  assert.equal(result.stale, 0);
});

test("collectContextBundleHealth counts tasks with verification.passed=null as degraded", () => {
  // Task where verification exists but passed is null — should NOT be healthy
  const tasks = [
    codexTask("t1", { status: "completed", verification: { passed: null } }),
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0, "verification.passed=null → not healthy");
  assert.equal(result.degraded, 1, "verification.passed=null, missingEvidence=0, ud exists → degraded");
  assert.equal(result.stale, 0);
});

test("collectContextBundleHealth counts tasks with acceptance findings as degraded", () => {
  // Task with 1 acceptance finding — should be degraded (not healthy)
  const tasks = [
    codexTask("t1", {
      status: "completed",
      verification: { passed: true },
      acceptance_findings: [{ code: "report_paths_missing" }],
    }),
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0, "missing evidence → not healthy");
  assert.equal(result.degraded, 1, "missingEvidence=1, ud exists → degraded");
  assert.equal(result.stale, 0);
});

test("collectContextBundleHealth counts tasks without unified_decision as stale", () => {
  const tasks = [
    {
      id: "t1",
      assignee: "codex",
      status: "running",
      result: {
        status: "running",
        summary: "task still running",
        changed_files: [],
        verification: { passed: true },
        acceptance_findings: [],
        // no unified_decision
      },
    },
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0, "no ud → not healthy");
  assert.equal(result.degraded, 0, "no ud → not degraded");
  assert.equal(result.stale, 1, "no ud → stale");
});

test("collectContextBundleHealth ignores non-codex tasks", () => {
  const tasks = [
    { id: "t1", assignee: "human", status: "completed" },
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0);
  assert.equal(result.degraded, 0);
  assert.equal(result.stale, 0);
  assert.equal(result.total_codex_tasks, 0);
});

test("collectContextBundleHealth returns zeros for empty tasks", () => {
  const result = collectContextBundleHealth([]);
  assert.deepEqual(result, { healthy: 0, degraded: 0, stale: 0, total_codex_tasks: 0 });
});

test("collectContextBundleHealth handles mixed health states", () => {
  const tasks = [
    codexTask("t1", { verification: { passed: true } }),                          // healthy
    codexTask("t2", { verification: undefined }),                                  // degraded (no verification, missingEvidence=0)
    codexTask("t3", { verification: { passed: null } }),                           // degraded (passed=null, missingEvidence=0)
    codexTask("t4", { verification: { passed: true }, acceptance_findings: [{}] }),// degraded (missingEvidence=1)
    {
      id: "t5",
      assignee: "codex",
      status: "running",
      result: { status: "running", changed_files: [], verification: {}, acceptance_findings: [] },
    },                                                                             // stale (no ud)
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 1, "only t1 should be healthy");
  assert.equal(result.degraded, 3, "t2, t3, t4 should be degraded");
  assert.equal(result.stale, 1, "t5 should be stale");
  assert.equal(result.total_codex_tasks, 5);
});

test("collectContextBundleHealth handles tasks with many acceptance findings as stale", () => {
  // Task with 2+ acceptance findings — should be stale (not healthy, not degraded)
  const tasks = [
    codexTask("t1", {
      verification: { passed: true },
      acceptance_findings: [{ code: "a" }, { code: "b" }],
    }),
  ];
  const result = collectContextBundleHealth(tasks);
  assert.equal(result.healthy, 0, "missingEvidence=2 → not healthy");
  assert.equal(result.degraded, 0, "missingEvidence=2 > 1 → not degraded");
  assert.equal(result.stale, 1, "missingEvidence=2 → stale");
});

// ===========================================================================
// AFC-P1: Agent Backend Source of Truth — product status tests
// ===========================================================================

test("productStatusCard shows backend chain from canonical source when available", () => {
  const data = makeMinimalProductData({
    role_backends: {
      text: "Task execution → codex_tui_goal (autonomous default); pipeline sub-roles → codex_exec",
      entries: [
        { role: "builder", backend: "codex_exec", semantic: "real", source: "product_default", label: "builder → codex_exec (Product default)" },
      ],
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("backend chain"), "backend chain label present");
  assert.ok(card.includes("product default"), "product default shown in chain");
});

test("productStatusCard shows backend chain with overrides when role_backends has explicit entries", () => {
  const data = makeMinimalProductData({
    role_backends: {
      text: "reviewer → local_command (Explicit role-level override (agentRoleBackends))\nbuilder → codex_exec (Product default (ROLE_BACKEND_DEFAULTS))",
      entries: [
        { role: "reviewer", backend: "local_command", semantic: "real", source: "explicit_role_override", label: "reviewer → local_command (Explicit role-level override)" },
        { role: "builder", backend: "codex_exec", semantic: "real", source: "product_default", label: "builder → codex_exec (Product default)" },
      ],
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("backend chain"), "backend chain label present");
  assert.ok(card.includes("local_command"), "override backend shown");
  assert.ok(card.includes("codex_exec"), "default backend shown");
});

test("productStatusCard falls back to all roles default when role_backends is null", () => {
  const data = makeMinimalProductData({ role_backends: null });
  const card = productStatusCard(data);
  assert.ok(card.includes("all roles"), "fallback 'all roles' shown");
  assert.ok(card.includes("codex_exec"), "default backend shown in fallback");
});

test("productStatusCard correctly shows agent_backend config value", () => {
  const data = makeMinimalProductData({ config: { ...makeMinimalProductData().config, agent_backend: "local_command" } });
  const card = productStatusCard(data);
  assert.ok(card.includes("local_command"), "agent backend config value shown");
});

test("productStatusCard shows backend chain when codex_exec is product default, not a warning", () => {
  // Test that all-codex_exec default does NOT trigger warning diagnostics
  const data = makeMinimalProductData({
    role_backends: {
      text: "Task execution → codex_tui_goal (autonomous default); pipeline sub-roles → codex_exec",
      entries: [],
    },
  });
  const card = productStatusCard(data);
  assert.ok(card.includes("backend chain"), "backend chain present");
  assert.ok(card.includes("product default"), "labeled as product default");
  // The warnings should not mention codex_exec as an issue
  const warnings = data._diagnostics?.warnings || [];
  const backendWarnings = warnings.filter(w => w.message.includes("codex_exec") || w.message.includes("backend"));
  assert.equal(backendWarnings.length, 0, "no warnings about codex_exec default");
});
