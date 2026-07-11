/**
 * workstream-fanout-join.test.mjs — Tests for fan-out and join services.
 *
 * Covers:
 * 1. Fan-out creation with idempotent key
 * 2. Shard node creation and metadata inheritance
 * 3. Join node creation with all condition types
 * 4. Join condition evaluation
 * 5. Manual release flow
 * 6. Idempotent re-invocation
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { createWorkstreamFanout, buildShardNodeId, buildFanoutParentNodeId } from "../src/orchestration/task-fanout-service.mjs";
import {
  createWorkstreamJoin,
  evaluateJoinCondition,
  manualReleaseJoin,
  buildJoinNodeId,
  getJoinStatus,
} from "../src/orchestration/task-join-service.mjs";
import { getDagNode, getExecutionGraph } from "../src/orchestration/task-dag-service.mjs";
import { JOIN_CONDITIONS } from "../src/orchestration/dependency-resolver.mjs";

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

const WS_ID = "ws_test_fanout";

// ---------------------------------------------------------------------------
// Fan-out tests
// ---------------------------------------------------------------------------

test("createWorkstreamFanout — creates parent and shard nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-fanout-test-"));
  const store = await makeStore(dir);
  const result = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: "build",
    shard_count: 3,
    shard_prefix: "s",
    iteration: 0,
  });

  assert.ok(result.parent_node);
  assert.equal(result.parent_node.node_type, "fanout");
  assert.equal(result.shard_nodes.length, 3);
  assert.equal(result.edges.length, 3);

  // Verify shard node IDs
  const expectedIds = ["s_0", "s_1", "s_2"].map((sk) =>
    buildShardNodeId({ workstream_id: WS_ID, phase: "build", shard_key: sk, iteration: 0 })
  );
  const shardIds = result.shard_nodes.map((n) => n.id);
  for (const eid of expectedIds) {
    assert.ok(shardIds.includes(eid), `Expected shard ${eid} in ${shardIds}`);
  }
});

test("createWorkstreamFanout — idempotent re-invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-fanout-test-"));
  const store = await makeStore(dir);
  const first = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: "test",
    shard_count: 2,
    iteration: 0,
  });
  const second = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: "test",
    shard_count: 2,
    iteration: 0,
  });
  assert.ok(second.idempotent);
  assert.equal(second.shard_nodes.length, first.shard_nodes.length);
});

test("createWorkstreamFanout — validates shard_count bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-fanout-test-"));
  const store = await makeStore(dir);
  await assert.rejects(
    () => createWorkstreamFanout(store, { workstream_id: WS_ID, shard_count: 0 }),
    /shard_count/
  );
  await assert.rejects(
    () => createWorkstreamFanout(store, { workstream_id: WS_ID, shard_count: 101 }),
    /shard_count/
  );
});

test("createWorkstreamFanout — requires workstream_id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-fanout-test-"));
  const store = await makeStore(dir);
  await assert.rejects(
    () => createWorkstreamFanout(store, {}),
    /workstream_id/
  );
});

test("buildShardNodeId — correct format", () => {
  const id = buildShardNodeId({ workstream_id: "ws_abc", phase: "p1", shard_key: "s_0", iteration: 0 });
  assert.equal(id, "ws_abc:p1:s_0:0");
});

test("buildFanoutParentNodeId — correct format", () => {
  const id = buildFanoutParentNodeId({ workstream_id: "ws_abc", phase: "p1", iteration: 0 });
  assert.equal(id, "ws_abc:p1:fanout:0");
});

// ---------------------------------------------------------------------------
// Join tests
// ---------------------------------------------------------------------------

test("createWorkstreamJoin — creates join node with edges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);

  // Create predecessor shards
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: "build",
    shard_count: 2,
    iteration: 0,
  });

  const shardIds = fanout.shard_nodes.map((n) => n.id);

  // Create join
  const result = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "build",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ALL_COMPLETED,
    shard_key: "integration",
    iteration: 0,
  });

  assert.ok(result.join_node);
  assert.equal(result.join_node.node_type, "join");
  assert.equal(result.join_node.status, "waiting");
  assert.equal(result.edges.length, 2);

  // Verify join node appears in execution graph
  const graph = await getExecutionGraph(store, WS_ID);
  assert.ok(graph.nodes.find((n) => n.id === result.join_node.id));
});

test("createWorkstreamJoin — all condition types", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);

  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: "multi",
    shard_count: 1,
    iteration: 0,
  });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  // all_passed
  const r1 = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "multi",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ALL_PASSED,
    shard_key: "join_passed",
    iteration: 0,
  });
  assert.equal(r1.join_node.join_condition, "all_passed");

  // any_passed
  const r2 = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "multi",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ANY_PASSED,
    shard_key: "join_any",
    iteration: 0,
  });
  assert.equal(r2.join_node.join_condition, "any_passed");

  // manual_release → node_type becomes "integration"
  const r3 = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "multi",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.MANUAL_RELEASE,
    shard_key: "join_manual",
    iteration: 0,
  });
  assert.equal(r3.join_node.join_condition, "manual_release");
  assert.equal(r3.join_node.node_type, "integration");
});

test("createWorkstreamJoin — idempotent re-invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);
  const fanout = await createWorkstreamFanout(store, { workstream_id: WS_ID, phase: "idemp", shard_count: 1, iteration: 0 });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  const first = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "idemp",
    predecessor_ids: shardIds,
    shard_key: "join_test",
    iteration: 0,
  });
  const second = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "idemp",
    predecessor_ids: shardIds,
    shard_key: "join_test",
    iteration: 0,
  });
  assert.ok(second.idempotent);
  assert.equal(second.join_node.id, first.join_node.id);
});

test("createWorkstreamJoin — requires workstream_id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);
  await assert.rejects(
    () => createWorkstreamJoin(store, { predecessor_ids: ["a"] }),
    /workstream_id/
  );
});

test("createWorkstreamJoin — requires predecessor_ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);
  await assert.rejects(
    () => createWorkstreamJoin(store, { workstream_id: WS_ID, predecessor_ids: [] }),
    /predecessor_ids/
  );
});

test("manualReleaseJoin — triggers manual release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);
  const fanout = await createWorkstreamFanout(store, { workstream_id: WS_ID, phase: "rel", shard_count: 1, iteration: 0 });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  const joinResult = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "rel",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.MANUAL_RELEASE,
    shard_key: "rel_join",
    iteration: 0,
  });

  // Before release
  const evalResult = await evaluateJoinCondition(store, joinResult.join_node.id, null, { manualReleaseTriggered: false });
  assert.equal(evalResult.satisfied, false);

  // Release
  const released = await manualReleaseJoin(store, joinResult.join_node.id);
  assert.ok(released.metadata.manual_release_triggered);
});

test("buildJoinNodeId — correct format", () => {
  const id = buildJoinNodeId({ workstream_id: "ws_abc", phase: "p1", shard_key: "join", iteration: 0 });
  assert.equal(id, "ws_abc:p1:join:0");
});

test("getJoinStatus — returns summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-join-test-"));
  const store = await makeStore(dir);
  const fanout = await createWorkstreamFanout(store, { workstream_id: WS_ID, phase: "st", shard_count: 1, iteration: 0 });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: "st",
    predecessor_ids: shardIds,
    shard_key: "st_join",
    iteration: 0,
  });

  const status = await getJoinStatus(store, WS_ID);
  assert.ok(status.total >= 1);
  assert.ok(status.waiting >= 1);
  assert.ok(status.by_condition.all_completed >= 1);
});
