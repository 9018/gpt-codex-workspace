import test from "node:test";
import assert from "node:assert/strict";

import { createDagBatch, getExecutionGraph, getReadyNodes, updateDagNode } from "../src/orchestration/task-dag-service.mjs";
import { createMemoryStateStore } from "./helpers/fault-injection-harness.mjs";

test("parallel agents converge through a deterministic integration join", async () => {
  const store = createMemoryStateStore();
  await createDagBatch(store, "ws_e2e", {
    nodes: [
      { id: "agent_a" },
      { id: "agent_b" },
      { id: "integration", node_type: "integration", status: "waiting" },
    ],
    edges: [{ from: "agent_a", to: "integration" }, { from: "agent_b", to: "integration" }],
  });
  assert.deepEqual(await getReadyNodes(store, "ws_e2e"), ["agent_a", "agent_b"]);
  await updateDagNode(store, "agent_a", { status: "completed" });
  assert.deepEqual(await getReadyNodes(store, "ws_e2e"), ["agent_b"]);
  await updateDagNode(store, "agent_b", { status: "completed" });
  assert.deepEqual(await getReadyNodes(store, "ws_e2e"), ["integration"]);
  const graph = await getExecutionGraph(store, "ws_e2e");
  assert.deepEqual(graph.topological_order, ["agent_a", "agent_b", "integration"]);
});
