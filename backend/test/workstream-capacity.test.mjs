/**
 * workstream-capacity.test.mjs — Tests for execution capacity limits.
 *
 * Covers:
 * 1. Global capacity counting
 * 2. Per-repo capacity counting
 * 3. Per-workstream capacity counting
 * 4. TUI session capacity
 * 5. Combined checkExecutionCapacity
 * 6. getCapacityStatus report
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import {
  DEFAULT_CAPACITY_LIMITS,
  countActiveExecutions,
  countActiveRepoExecutions,
  countActiveWorkstreamExecutions,
  countActiveTuiSessions,
  checkExecutionCapacity,
  checkTuiCapacity,
  getCapacityStatus,
} from "../src/orchestration/execution-capacity.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(dir) {
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.goal_queue = [];
  store.state.workstream_dag = { nodes: {}, edges: [] };
  store.state.tui_sessions = [];
  await store.save();
  return store;
}

function addRunningQueueItem(state, overrides = {}) {
  state.goal_queue.push({
    queue_id: "q_" + Math.random().toString(36).slice(2, 8),
    goal_id: "goal_" + Math.random().toString(36).slice(2, 8),
    status: "running",
    repo_id: overrides.repo_id || "default",
    workstream_id: overrides.workstream_id || null,
    position: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
}

function addDagRunningNode(state, workstreamId) {
  const nodeId = "node_" + Math.random().toString(36).slice(2, 8);
  state.workstream_dag.nodes[nodeId] = {
    id: nodeId,
    workstream_id: workstreamId,
    status: "running",
    node_type: "task",
  };
}

// ---------------------------------------------------------------------------
// Basic counting tests
// ---------------------------------------------------------------------------

test("countActiveExecutions — returns 0 when empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  assert.equal(countActiveExecutions(state), 0);
});

test("countActiveExecutions — counts running queue items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state);
  addRunningQueueItem(state);
  assert.equal(countActiveExecutions(state), 2);
});

test("countActiveRepoExecutions — filters by repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state, { repo_id: "repo_a" });
  addRunningQueueItem(state, { repo_id: "repo_a" });
  addRunningQueueItem(state, { repo_id: "repo_b" });
  assert.equal(countActiveRepoExecutions(state, "repo_a"), 2);
  assert.equal(countActiveRepoExecutions(state, "repo_b"), 1);
  assert.equal(countActiveRepoExecutions(state, "nonexistent"), 0);
});

test("countActiveRepoExecutions — null repo returns 0", () => {
  const state = { goal_queue: [{ status: "running", repo_id: "r1" }] };
  assert.equal(countActiveRepoExecutions(state, null), 0);
});

test("countActiveWorkstreamExecutions — counts queue and DAG nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state, { workstream_id: "ws_a" });
  addDagRunningNode(state, "ws_a");
  const count = countActiveWorkstreamExecutions(state, "ws_a");
  assert.equal(count, 2);
});

test("countActiveTuiSessions — counts active TUI sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  await store.load();
  const state = await store.load();
  
  state.tui_sessions = [];
  state.tui_sessions.push({ id: "t1", status: "running", workstream_id: "ws_a" });
  state.tui_sessions.push({ id: "t2", status: "running", workstream_id: "ws_a" });
  state.tui_sessions.push({ id: "t3", status: "idle" });
  
  assert.equal(countActiveTuiSessions(state), 2);
  assert.equal(countActiveTuiSessions(state, "ws_a"), 2);
  assert.equal(countActiveTuiSessions(state, "ws_b"), 0);
});

// ---------------------------------------------------------------------------
// Capacity check tests
// ---------------------------------------------------------------------------

test("checkExecutionCapacity — allows when under limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  const result = checkExecutionCapacity(state);
  assert.ok(result.allowed);
  assert.equal(result.reason, "Capacity available");
});

test("checkExecutionCapacity — blocks at global limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  // Fill up to max
  for (let i = 0; i < DEFAULT_CAPACITY_LIMITS.global_max_parallel; i++) {
    addRunningQueueItem(state);
  }
  const result = checkExecutionCapacity(state);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("capacity"));
  assert.equal(result.counts.global_active, DEFAULT_CAPACITY_LIMITS.global_max_parallel);
});

test("checkExecutionCapacity — checks per-repo limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  for (let i = 0; i < DEFAULT_CAPACITY_LIMITS.repo_max_parallel; i++) {
    addRunningQueueItem(state, { repo_id: "special_repo" });
  }
  const result = checkExecutionCapacity(state, { repo_id: "special_repo" });
  assert.equal(result.allowed, false);
});

test("checkExecutionCapacity — checks per-workstream limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  for (let i = 0; i < DEFAULT_CAPACITY_LIMITS.workstream_max_parallel; i++) {
    addRunningQueueItem(state, { workstream_id: "ws_over" });
  }
  const result = checkExecutionCapacity(state, { workstream_id: "ws_over" });
  assert.equal(result.allowed, false);
});

test("checkTuiCapacity — enforces limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  state.tui_sessions = [];
  for (let i = 0; i < DEFAULT_CAPACITY_LIMITS.global_max_tui; i++) {
    state.tui_sessions.push({ id: `t${i}`, status: "running", workstream_id: "ws_tui" });
  }
  const result = checkTuiCapacity(state);
  assert.equal(result.allowed, false);
});

test("checkTuiCapacity — per-workstream limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  state.tui_sessions = [];
  for (let i = 0; i < DEFAULT_CAPACITY_LIMITS.workstream_max_tui + 1; i++) {
    state.tui_sessions.push({ id: `t${i}`, status: "running", workstream_id: "ws_full" });
  }
  const result = checkTuiCapacity(state, { workstream_id: "ws_full" });
  assert.equal(result.allowed, false);
});

test("checkExecutionCapacity — custom limits override defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state);
  const result = checkExecutionCapacity(state, { limits: { global_max_parallel: 1 } });
  assert.equal(result.allowed, false);
});

test("checkExecutionCapacity — empty repo_id skips repo check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  const result = checkExecutionCapacity(state, { repo_id: null });
  assert.ok(result.allowed);
});

// ---------------------------------------------------------------------------
// getCapacityStatus tests
// ---------------------------------------------------------------------------

test("getCapacityStatus — returns structured report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state, { repo_id: "r1", workstream_id: "ws1" });
  addRunningQueueItem(state, { repo_id: "r1", workstream_id: "ws1" });
  addRunningQueueItem(state, { repo_id: "r2", workstream_id: "ws2" });

  const status = getCapacityStatus(state);
  assert.ok(status.global);
  assert.ok(status.per_repo);
  assert.ok(status.per_workstream);
  assert.equal(status.global.active, 3);
  assert.equal(status.per_repo.r1?.active, 2);
  assert.equal(status.per_workstream.ws1?.active, 2);
});

test("getCapacityStatus — with workstream DAG nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-cap-test-"));
  const store = await makeStore(dir);
  const state = await store.load();
  addRunningQueueItem(state, { workstream_id: "ws_dag" });
  addDagRunningNode(state, "ws_dag");
  addDagRunningNode(state, "ws_dag");

  const status = getCapacityStatus(state);
  assert.equal(status.per_workstream.ws_dag?.active, 3);
});
