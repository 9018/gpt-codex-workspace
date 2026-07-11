/**
 * workstream-dag.test.mjs — Tests for workstream DAG services.
 *
 * Covers:
 * 1. Cycle detection (no cycle, simple cycle, complex cycle)
 * 2. Stable topological sort (deterministic ordering)
 * 3. Cycle rejection on edge add
 * 4. DAG node CRUD
 * 5. Dependency graph validation
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { StateStore } from "../src/state-store.mjs";
import {
  detectCycle,
  stableTopologicalSort,
  validateDependencyGraph,
  checkJoinCondition,
  JOIN_CONDITIONS,
  isValidJoinCondition,
} from "../src/orchestration/dependency-resolver.mjs";
import {
  createDagNode,
  getDagNode,
  updateDagNode,
  listDagNodes,
  addDagEdge,
  removeDagEdge,
  getExecutionGraph,
  getReadyNodes,
  getPredecessors,
  getSuccessors,
  createDagBatch,
} from "../src/orchestration/task-dag-service.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(dir) {
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();
  return store;
}

const WS_ID = "ws_test_dag";
const TS = new Date().toISOString();

async function seedThreeNodes(store) {
  await createDagNode(store, {
    id: "node_a",
    workstream_id: WS_ID,
    phase: "phase1",
    node_type: "task",
    status: "pending",
  });
  await createDagNode(store, {
    id: "node_b",
    workstream_id: WS_ID,
    phase: "phase1",
    node_type: "task",
    status: "pending",
  });
  await createDagNode(store, {
    id: "node_c",
    workstream_id: WS_ID,
    phase: "phase1",
    node_type: "task",
    status: "pending",
  });
  // a → b → c
  await addDagEdge(store, "node_a", "node_b");
  await addDagEdge(store, "node_b", "node_c");
}

// ---------------------------------------------------------------------------
// Cycle detection tests
// ---------------------------------------------------------------------------

test("detectCycle — returns null for acyclic graph", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", []],
  ]);
  assert.equal(detectCycle(adjacency), null);
});

test("detectCycle — detects simple cycle a→b→a", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  const cycle = detectCycle(adjacency);
  assert.notEqual(cycle, null);
  assert.equal(cycle.length, 3); // a → b → a
  assert.equal(cycle[0], cycle[cycle.length - 1]); // starts and ends with same
});

test("detectCycle — detects chain with cycle a→b→c→b", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["b"]],
  ]);
  const cycle = detectCycle(adjacency);
  assert.notEqual(cycle, null);
  assert.ok(cycle.length >= 3);
});

test("detectCycle — isolated node without cycle", () => {
  const adjacency = new Map([["a", []]]);
  assert.equal(detectCycle(adjacency), null);
});

test("detectCycle — empty graph", () => {
  const adjacency = new Map();
  assert.equal(detectCycle(adjacency), null);
});

// ---------------------------------------------------------------------------
// Stable topological sort tests
// ---------------------------------------------------------------------------

test("stableTopologicalSort — simple linear order", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", []],
  ]);
  const order = stableTopologicalSort(adjacency, ["a", "b", "c"]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("stableTopologicalSort — diamond DAG is deterministic", () => {
  // a → b → d
  // a → c → d
  const adjacency = new Map([
    ["a", ["b", "c"]],
    ["b", ["d"]],
    ["c", ["d"]],
    ["d", []],
  ]);
  const order1 = stableTopologicalSort(adjacency, ["a", "b", "c", "d"]);
  const order2 = stableTopologicalSort(adjacency, ["a", "b", "c", "d"]);
  // Must produce same stable order every time
  assert.deepEqual(order1, order2);
  // a must be first, d must be last
  assert.equal(order1[0], "a");
  assert.equal(order1[order1.length - 1], "d");
});

test("stableTopologicalSort — throws on cycle", () => {
  const adjacency = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  assert.throws(() => stableTopologicalSort(adjacency, ["a", "b"]), /Cycle detected/);
});

test("stableTopologicalSort — deterministic with tied nodes", () => {
  // Three nodes with no edges — should sort alphabetically
  const adjacency = new Map([
    ["z", []],
    ["a", []],
    ["m", []],
  ]);
  const order = stableTopologicalSort(adjacency, ["z", "a", "m"]);
  assert.deepEqual(order, ["a", "m", "z"]);
});

// ---------------------------------------------------------------------------
// DAG node CRUD tests
// ---------------------------------------------------------------------------

test("createDagNode — creates node with required fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  const node = await createDagNode(store, { id: "n1", workstream_id: WS_ID, node_type: "task" });
  assert.equal(node.id, "n1");
  assert.equal(node.workstream_id, WS_ID);
  assert.equal(node.node_type, "task");
  assert.equal(node.status, "pending");
  assert.ok(node.created_at);
  assert.ok(node.updated_at);
});

test("getDagNode — returns existing node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await createDagNode(store, { id: "n1", workstream_id: WS_ID });
  const node = await getDagNode(store, "n1");
  assert.equal(node.id, "n1");
});

test("getDagNode — throws on missing node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await assert.rejects(async () => getDagNode(store, "nonexistent"), /not found/);
});

test("updateDagNode — updates mutable fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await createDagNode(store, { id: "n1", workstream_id: WS_ID, status: "pending" });
  const updated = await updateDagNode(store, "n1", { status: "running" });
  assert.equal(updated.status, "running");
});

test("listDagNodes — filters by workstream and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await seedThreeNodes(store);
  const nodes = await listDagNodes(store, WS_ID);
  assert.equal(nodes.length, 3);
  const pending = await listDagNodes(store, WS_ID, { status: "pending" });
  assert.equal(pending.length, 3);
});

test("addDagEdge — rejects cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await createDagNode(store, { id: "a", workstream_id: WS_ID });
  await createDagNode(store, { id: "b", workstream_id: WS_ID });
  await createDagNode(store, { id: "c", workstream_id: WS_ID });
  await addDagEdge(store, "a", "b");
  await addDagEdge(store, "b", "c");
  // Adding c → a would create a cycle
  await assert.rejects(
    async () => addDagEdge(store, "c", "a"),
    /cycle/i
  );
});

test("addDagEdge — idempotent duplicate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await createDagNode(store, { id: "a", workstream_id: WS_ID });
  await createDagNode(store, { id: "b", workstream_id: WS_ID });
  await addDagEdge(store, "a", "b");
  const second = await addDagEdge(store, "a", "b");
  assert.ok(second.from);
});

// ---------------------------------------------------------------------------
// Execution graph test
// ---------------------------------------------------------------------------

test("getExecutionGraph — returns full DAG with topo order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await seedThreeNodes(store);
  const graph = await getExecutionGraph(store, WS_ID);
  assert.equal(graph.node_count, 3);
  assert.equal(graph.edge_count, 2);
  assert.ok(graph.topological_order.length >= 3);
  assert.ok(graph.validation.valid);
  assert.equal(graph.workstream_id, WS_ID);
});

test("getReadyNodes — returns pending nodes with no unmet deps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  await seedThreeNodes(store);
  const ready = await getReadyNodes(store, WS_ID);
  // Only 'a' should be ready (no dependencies)
  assert.equal(ready.length, 1);
  assert.equal(ready[0], "node_a");
});

test("createDagBatch — creates nodes and edges atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-dag-test-"));
  const store = await makeStore(dir);
  const result = await createDagBatch(store, WS_ID, {
    nodes: [
      { id: "x", phase: "p1" },
      { id: "y", phase: "p1" },
    ],
    edges: [{ from: "x", to: "y" }],
  });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 1);
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

test("validateDependencyGraph — valid graph", () => {
  const adj = new Map([
    ["a", ["b"]],
    ["b", []],
  ]);
  const result = validateDependencyGraph(adj, ["a", "b"]);
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

test("validateDependencyGraph — detects cycle", () => {
  const adj = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  const result = validateDependencyGraph(adj, ["a", "b"]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validateDependencyGraph — warns about disconnected nodes", () => {
  const adj = new Map([
    ["a", ["b"]],
    ["b", []],
  ]);
  const result = validateDependencyGraph(adj, ["a", "b", "c"]);
  assert.ok(result.valid);
  assert.ok(result.warnings.length > 0); // c is disconnected
});

// ---------------------------------------------------------------------------
// Join condition tests
// ---------------------------------------------------------------------------

test("checkJoinCondition — all_completed satisfied", () => {
  const getState = (id) => ({
    id,
    status: "completed",
    terminal: true,
    acceptance_gate: { passed: true },
    passed: true,
  });
  const result = checkJoinCondition(["a", "b"], JOIN_CONDITIONS.ALL_COMPLETED, getState);
  assert.ok(result.satisfied);
});

test("checkJoinCondition — all_completed not satisfied", () => {
  const getState = (id) => ({ status: "running" });
  const result = checkJoinCondition(["a"], JOIN_CONDITIONS.ALL_COMPLETED, getState);
  assert.equal(result.satisfied, false);
});

test("checkJoinCondition — all_passed satisfied", () => {
  const getState = (id) => ({
    status: "completed",
    acceptance_gate: { passed: true },
    passed: true,
  });
  const result = checkJoinCondition(["a", "b"], JOIN_CONDITIONS.ALL_PASSED, getState);
  assert.ok(result.satisfied);
});

test("checkJoinCondition — all_passed fails when one fails", () => {
  const calls = { a: 0, b: 0 };
  const getState = (id) => {
    calls[id]++;
    return { status: id === "a" ? "completed" : "failed", acceptance_gate: { passed: id === "a" ? true : false }, passed: id === "a" };
  };
  const result = checkJoinCondition(["a", "b"], JOIN_CONDITIONS.ALL_PASSED, getState);
  assert.equal(result.satisfied, false);
});

test("checkJoinCondition — any_passed satisfied", () => {
  const getState = (id) => ({
    status: id === "a" ? "completed" : "running",
    acceptance_gate: { passed: id === "a" },
    passed: id === "a",
  });
  const result = checkJoinCondition(["a", "b"], JOIN_CONDITIONS.ANY_PASSED, getState);
  assert.ok(result.satisfied);
});

test("checkJoinCondition — manual_release requires explicit trigger", () => {
  const resultNo = checkJoinCondition(["a"], JOIN_CONDITIONS.MANUAL_RELEASE, () => ({}), { manualReleaseTriggered: false });
  assert.equal(resultNo.satisfied, false);
  const resultYes = checkJoinCondition(["a"], JOIN_CONDITIONS.MANUAL_RELEASE, () => ({}), { manualReleaseTriggered: true });
  assert.ok(resultYes.satisfied);
});

test("checkJoinCondition — empty predecessors is satisfied", () => {
  const result = checkJoinCondition([], JOIN_CONDITIONS.ALL_COMPLETED, () => ({ status: "completed" }));
  assert.ok(result.satisfied);
});

test("isValidJoinCondition", () => {
  assert.ok(isValidJoinCondition("all_completed"));
  assert.ok(isValidJoinCondition("all_passed"));
  assert.ok(isValidJoinCondition("any_passed"));
  assert.ok(isValidJoinCondition("manual_release"));
  assert.equal(isValidJoinCondition("bogus"), false);
});
