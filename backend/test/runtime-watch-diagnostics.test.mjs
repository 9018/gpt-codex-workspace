/**
 * runtime-watch-diagnostics.test.mjs — AFC-10 Runtime Watch Self-Heal Tests
 *
 * Tests three domains:
 *   1. Stale lock detection (detectStaleLocks)
 *   2. Terminal tasks left running (detectTerminalTasksRunning)
 *   3. Stale queue blockers (detectStaleQueueBlockers)
 *   4. Recovery action generation and application
 *   5. Formatting helpers
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ===========================================================================
// Helpers — build minimal StateStore fixture
// ===========================================================================

async function createFixtureStore(tasks = [], queueItems = [], goalQueue = []) {
  const { StateStore } = await import("../src/state-store.mjs");
  const dir = await mkdtemp(join(tmpdir(), "watch-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.tasks = tasks;
  store.state.goal_queue = goalQueue.length > 0 ? goalQueue : queueItems;
  store.state.goals = [];
  await store.save();
  return { store, dir };
}

async function createLockFile(dir, taskId, overrides = {}) {
  const lockDir = join(dir, ".gptwork/locks/repos");
  await mkdir(lockDir, { recursive: true });
  const lockData = {
    safe_repo_id: "test-repo-001",
    task_id: taskId,
    status: "held",
    mode: "exclusive",
    acquired_at: new Date(Date.now() - 3600_000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 600_000).toISOString(),
    child_pid: 99999,
    pid: 88888,
    ...overrides,
  };
  const lockPath = join(lockDir, `${taskId || "unknown"}.json`);
  await writeFile(lockPath, JSON.stringify(lockData, null, 2));
  return lockPath;
}

async function createRunMetadata(dir, taskId, overrides = {}) {
  const runDir = join(dir, ".gptwork/tasks", taskId);
  await mkdir(runDir, { recursive: true });
  const runData = {
    run_id: `run-${taskId}`,
    task_id: taskId,
    last_heartbeat_at: new Date(Date.now() - 1200_000).toISOString(),
    codex_child_pid: 99999,
    phase: "running",
    ...overrides,
  };
  const runPath = join(runDir, `${runData.run_id}.json`);
  await writeFile(runPath, JSON.stringify(runData, null, 2));
  return runPath;
}

async function createResultJson(dir, goalId, status = "completed") {
  const resultDir = join(dir, ".gptwork/goals", goalId);
  await mkdir(resultDir, { recursive: true });
  const resultData = { status };
  const resultPath = join(resultDir, "result.json");
  await writeFile(resultPath, JSON.stringify(resultData, null, 2));
  return resultPath;
}

// ===========================================================================
// Domain 1: Stale lock detection
// ===========================================================================

test("detectStaleLocks: no locks dir returns empty", async () => {
  const { store, dir } = await createFixtureStore();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleLocks(join(dir, "nonexistent"), store)
  );
  assert.equal(result.stale_locks.length, 0);
  assert.equal(result.summary.total_locks, 0);
});

test("detectStaleLocks: lock for terminal task is stale", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-terminal", status: "completed" },
  ]);
  await createLockFile(dir, "task-terminal", { last_heartbeat_at: new Date(Date.now() - 600_000).toISOString() });

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleLocks(dir, store)
  );

  assert.equal(result.summary.total_locks, 1);
  assert.equal(result.summary.stale, 1);
  assert.equal(result.stale_locks.length, 1);
  assert.ok(result.stale_locks[0].stale_reasons.some(r => r.includes("terminal")));
  assert.equal(result.stale_locks[0].recovery.action, "release_lock");
});

test("detectStaleLocks: lock for non-existent task is stale", async () => {
  const { store, dir } = await createFixtureStore([]);
  await createLockFile(dir, "task-ghost");

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleLocks(dir, store)
  );

  assert.equal(result.stale_locks.length, 1);
  assert.ok(result.stale_locks[0].stale_reasons.some(r => r.includes("not found")));
});

test("detectStaleLocks: released lock is not stale", async () => {
  const { store, dir } = await createFixtureStore([]);
  await createLockFile(dir, "task-released", { status: "released" });

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleLocks(dir, store)
  );

  assert.equal(result.stale_locks.length, 0);
  assert.equal(result.summary.stale, 0);
});

test("detectStaleLocks: lock with recent heartbeat and alive PID is active", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-active", status: "running" },
  ]);
  await createLockFile(dir, "task-active", {
    last_heartbeat_at: new Date().toISOString(),
    pid: process.pid, // this process is alive
    child_pid: 0,
  });

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleLocks(dir, store)
  );

  assert.equal(result.stale_locks.length, 0);
  assert.equal(result.summary.active, 1);
  assert.equal(result.summary.stale, 0);
});

// ===========================================================================
// Domain 2: Terminal tasks left running
// ===========================================================================

test("detectTerminalTasksRunning: no running tasks returns empty", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-completed", status: "completed" },
    { id: "task-waiting", status: "waiting_for_review" },
  ]);

  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectTerminalTasksRunning(state, dir)
  );

  assert.equal(result.terminal_tasks_running.length, 0);
});

test("detectTerminalTasksRunning: running task with terminal result.json detected", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-running", status: "running", goal_id: "goal-done" },
  ]);
  await createResultJson(dir, "goal-done", "completed");

  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectTerminalTasksRunning(state, dir)
  );

  assert.equal(result.terminal_tasks_running.length, 1);
  const f = result.terminal_tasks_running[0];
  assert.equal(f.task_id, "task-running");
  assert.equal(f.recommended_status, "completed");
  assert.ok(f.reasons.some(r => r.includes("result.json")));
  assert.equal(f.recovery.action, "mark_task_terminal");
});

test("detectTerminalTasksRunning: running task with completed run phase detected", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-run-done", status: "running", goal_id: "goal-run" },
  ]);
  await createRunMetadata(dir, "task-run-done", { phase: "completed" });

  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectTerminalTasksRunning(state, dir)
  );

  assert.equal(result.terminal_tasks_running.length, 1);
  assert.ok(result.terminal_tasks_running[0].reasons.some(r => r.includes("phase")));
});

test("detectTerminalTasksRunning: running task with released lock detected", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-lock-rel", status: "running" },
  ]);
  await createLockFile(dir, "task-lock-rel", { status: "released" });

  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectTerminalTasksRunning(state, dir)
  );

  assert.equal(result.terminal_tasks_running.length, 1);
  assert.ok(result.terminal_tasks_running[0].reasons.some(r => r.includes("lock released")));
});

test("detectTerminalTasksRunning: running task with healthy run stays active", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-healthy", status: "running", goal_id: "goal-healthy" },
  ]);
  await createRunMetadata(dir, "task-healthy", {
    last_heartbeat_at: new Date().toISOString(),
    codex_child_pid: 0, // no child pid to check
    phase: "running",
  });

  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectTerminalTasksRunning(state, dir)
  );

  // Without a stale heartbeat or terminal phase, task stays as-is
  assert.equal(result.terminal_tasks_running.length, 0);
});

// ===========================================================================
// Domain 3: Stale queue blockers
// ===========================================================================

test("detectStaleQueueBlockers: no blocked items returns empty", async () => {
  const { store } = await createFixtureStore([], []);
  const state = await store.load();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleQueueBlockers(state, { stale_locks: [], summary: { stale: 0, active: 0 } })
  );
  assert.equal(result.stale_queue_blockers.length, 0);
});

test("detectStaleQueueBlockers: blocked item with resolved lock is stale", async () => {
  const { store } = await createFixtureStore([], [], [
    {
      queue_id: "queue-1",
      goal_id: "goal-1",
      status: "blocked",
      position: 1,
      blocked_reason: "repo lock: active lock on repo R",
      repo_id: "repo-R",
    },
  ]);

  const state = await store.load();
  const lockDiag = {
    stale_locks: [{ task_id: "task-1" }],
    summary: { stale: 1, active: 0, total_locks: 1 },
  };
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleQueueBlockers(state, lockDiag)
  );

  assert.equal(result.stale_queue_blockers.length, 1);
  const f = result.stale_queue_blockers[0];
  assert.equal(f.queue_id, "queue-1");
  assert.equal(f.recovery.action, "unblock_queue_item");
});

test("detectStaleQueueBlockers: blocked item with no active locks resolves", async () => {
  const { store } = await createFixtureStore([], [], [
    {
      queue_id: "queue-2",
      goal_id: "goal-2",
      status: "blocked",
      position: 2,
      blocked_reason: "repo: lock issue",
    },
  ]);

  const state = await store.load();
  const lockDiag = {
    stale_locks: [],
    summary: { stale: 1, active: 0, total_locks: 1 },
  };
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.detectStaleQueueBlockers(state, lockDiag)
  );

  assert.equal(result.stale_queue_blockers.length, 1);
});

// ===========================================================================
// Full watch diagnostics
// ===========================================================================

test("runWatchDiagnostics: empty workspace returns empty findings", async () => {
  const { store, dir } = await createFixtureStore();
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchDiagnostics({ store, workspaceRoot: dir, dryRun: true })
  );

  assert.ok(result.summary);
  assert.equal(result.summary.total_findings, 0);
  assert.equal(result.summary.dry_run, true);
  assert.equal(result.recovery_actions.length, 0);
});

test("runWatchDiagnostics: detects stale lock for terminal task", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-term", status: "completed" },
  ]);
  await createLockFile(dir, "task-term");

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchDiagnostics({ store, workspaceRoot: dir, dryRun: true })
  );

  assert.equal(result.summary.domains.locks.stale, 1);
  assert.equal(result.findings.stale_locks.length, 1);
  assert.equal(result.recovery_actions.length, 1);
});

test("runWatchDiagnostics: detects terminal task left running", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-running-term", status: "running", goal_id: "goal-term" },
  ]);
  await createResultJson(dir, "goal-term", "completed");

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchDiagnostics({ store, workspaceRoot: dir, dryRun: true })
  );

  assert.equal(result.summary.domains.tasks.terminal_tasks_running, 1);
  assert.equal(result.findings.terminal_tasks_running.length, 1);
});

test("runWatchDiagnostics: detects stale queue blocker", async () => {
  const { store, dir } = await createFixtureStore([], [], [
    {
      queue_id: "queue-stale",
      goal_id: "goal-stale",
      status: "blocked",
      position: 1,
      blocked_reason: "repo lock: active lock on repo R",
    },
  ]);

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchDiagnostics({ store, workspaceRoot: dir, dryRun: true })
  );

  assert.equal(result.summary.domains.queue.stale_blockers, 1);
  assert.equal(result.findings.stale_queue_blockers.length, 1);
});

// ===========================================================================
// Recovery actions
// ===========================================================================

test("applyRecoveryActions: dry-run does not mutate state", async () => {
  const { store } = await createFixtureStore([
    { id: "t1", status: "running", goal_id: "g1", logs: [] },
  ]);
  await createResultJson(store.defaultWorkspaceRoot, "g1", "completed");

  const actions = [{
    action: "mark_task_terminal",
    safety: "safe",
    description: "Mark task t1 as completed — test",
    target: { domain: "task", id: "t1" },
    is_dry_run: true,
  }];

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.applyRecoveryActions(store, store.defaultWorkspaceRoot, actions, { dryRun: true })
  );

  assert.equal(result.applied_actions.length, 1);
  assert.ok(result.applied_actions[0].is_dry_run);
  const state = await store.load();
  const task = state.tasks.find(t => t.id === "t1");
  assert.equal(task.status, "running"); // unchanged
});

test("applyRecoveryActions: mark_task_terminal mutates state", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "t-terminal", status: "running", goal_id: "g-terminal", logs: [] },
  ]);

  const actions = [{
    action: "mark_task_terminal",
    safety: "safe",
    description: "Mark task t-terminal as waiting_for_review — test",
    target: { domain: "task", id: "t-terminal" },
    is_dry_run: false,
  }];

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.applyRecoveryActions(store, dir, actions, { dryRun: false })
  );

  assert.equal(result.applied_actions.length, 1);
  const state = await store.load();
  const task = state.tasks.find(t => t.id === "t-terminal");
  assert.ok(["completed", "failed", "waiting_for_review"].includes(task.status));
  assert.ok(task.logs.length > 0);
  assert.ok(task.updated_at);
});

test("applyRecoveryActions: unblock_queue_item mutates queue state", async () => {
  const { store, dir } = await createFixtureStore([], [], [
    { queue_id: "q-blocked", goal_id: "g1", status: "blocked", position: 1 },
  ]);

  const actions = [{
    action: "unblock_queue_item",
    safety: "safe",
    description: "Unblock queue item q-blocked — test",
    target: { domain: "queue", id: "q-blocked" },
    is_dry_run: false,
  }];

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.applyRecoveryActions(store, dir, actions, { dryRun: false })
  );

  assert.equal(result.applied_actions.length, 1);
  const state = await store.load();
  const item = state.goal_queue.find(i => i.queue_id === "q-blocked");
  assert.equal(item.status, "waiting");
  assert.equal(item.blocked_reason, null);
});

// ===========================================================================
// runWatchWithRecovery
// ===========================================================================

test("runWatchWithRecovery: dry-run produces diagnostics without mutation", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-term", status: "completed" },
  ]);
  await createLockFile(dir, "task-term");

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchWithRecovery({ store, workspaceRoot: dir, config: {}, dryRun: true })
  );

  assert.ok(result.diagnostics);
  assert.ok(result.recovery);
  assert.ok(result.summary);
  assert.equal(result.summary.dry_run, true);
  assert.ok(result.summary.findings >= 1);
  assert.equal(result.summary.actions_applied, 1); // dry-run actions are still counted as applied
});

// ===========================================================================
// formatWatchDiagnosticsCard
// ===========================================================================

test("formatWatchDiagnosticsCard: null returns fallback", async () => {
  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.formatWatchDiagnosticsCard(null)
  );
  assert.ok(result.includes("No runtime watch data"));
});

test("formatWatchDiagnosticsCard: formats report with findings", async () => {
  const report = {
    summary: {
      timestamp: "2026-07-07T00:00:00Z",
      dry_run: true,
      total_findings: 2,
      domains: {
        locks: { total_locks: 2, stale: 1, active: 1 },
        tasks: { total_running: 1, terminal_tasks_running: 1 },
        queue: { total_blocked: 2, stale_blockers: 1 },
      },
      total_recovery_actions: 2,
      safe_actions: 2,
      needs_review: 0,
    },
    findings: {
      stale_locks: [
        { safe_repo_id: "repo-1", stale_reasons: ["terminal task"], recovery: { action: "release_lock", safety: "safe", description: "Release stale lock" } },
      ],
      terminal_tasks_running: [
        { task_id: "task-1", reasons: ["result.json terminal"], recommended_status: "completed", recovery: { action: "mark_task_terminal", safety: "safe", description: "Mark completed" } },
      ],
      stale_queue_blockers: [
        { queue_id: "queue-1", goal_id: "goal-1", stale_reasons: ["no active locks"], recovery: { action: "unblock_queue_item", safety: "safe", description: "Unblock queue item" } },
      ],
    },
    recovery_actions: [
      { action: "release_lock", safety: "safe", description: "Release stale lock", target: { domain: "lock", id: "repo-1" }, is_dry_run: true },
      { action: "mark_task_terminal", safety: "safe", description: "Mark completed", target: { domain: "task", id: "task-1" }, is_dry_run: true },
    ],
  };

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.formatWatchDiagnosticsCard(report)
  );

  assert.ok(result.includes("Runtime Watch Diagnostics"));
  assert.ok(result.includes("total_findings:"));
  assert.ok(result.includes("Release stale lock"));
  assert.ok(result.includes("Mark completed"));
  assert.ok(result.includes("[DRY]"));
});

// ===========================================================================
// Domain count correctness
// ===========================================================================

test("runWatchDiagnostics: counts are correct when multiple stale conditions present", async () => {
  const { store, dir } = await createFixtureStore([
    { id: "task-done", status: "completed" },
    { id: "task-running", status: "running", goal_id: "goal-running" },
  ]);
  await createLockFile(dir, "task-done");
  await createResultJson(dir, "goal-running", "completed");

  const result = await import("../src/runtime-watch-diagnostics.mjs").then(m =>
    m.runWatchDiagnostics({ store, workspaceRoot: dir, dryRun: true })
  );

  // Expected: 1 stale lock + 1 terminal task + 0 stale queue blockers
  assert.equal(result.summary.total_findings, 2);
  assert.equal(result.summary.domains.locks.stale, 1);
  assert.equal(result.summary.domains.tasks.terminal_tasks_running, 1);
  assert.equal(result.summary.domains.queue.stale_blockers, 0);
});

console.log("runtime-watch-diagnostics tests loaded");
