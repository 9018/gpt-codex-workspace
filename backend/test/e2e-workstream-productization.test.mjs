/**
 * e2e-workstream-productization.test.mjs
 *
 * End-to-end Workstream productization scenario integrating G1–G6.
 *
 * Validates:
 *   1. Creating a Workstream with identity
 *   2. Binding multiple context links (G1)
 *   3. Fan-out three tasks into DAG (G4)
 *   4. Independent worktrees for each shard (G2)
 *   5. Structured subagents via progress store (G3)
 *   6. Automatic acceptance evaluation (G5)
 *   7. Repair/convergence handling (G5)
 *   8. Join node integration (G4)
 *   9. Completing the Workstream lifecycle
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state-store.mjs";
import {
  createWorkstream,
  getWorkstream,
  updateWorkstream,
  listWorkstreams,
} from "../src/workstream/workstream-service.mjs";
import {
  linkWorkstreamContext,
  listWorkstreamLinks,
  resolveWorkstreamsByContext,
} from "../src/workstream/workstream-context-links.mjs";
import {
  createWorkstreamFanout,
  buildShardNodeId,
  buildFanoutParentNodeId,
} from "../src/orchestration/task-fanout-service.mjs";
import {
  createWorkstreamJoin,
  evaluateJoinCondition,
  buildJoinNodeId,
} from "../src/orchestration/task-join-service.mjs";
import {
  createDagNode,
  getDagNode,
  updateDagNode,
  getExecutionGraph,
} from "../src/orchestration/task-dag-service.mjs";
import {
  evaluateAcceptance,
  VERDICT,
} from "../src/acceptance/workstream-acceptance-decision.mjs";
import {
  scheduleRepairAction,
  findExistingRepairRecord,
  MAX_REPAIR_ATTEMPTS,
} from "../src/acceptance/workstream-repair-task-factory.mjs";
import {
  runAcceptanceController,
} from "../src/acceptance/workstream-acceptance-controller.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_ID = "ws_e2e_productization";
const PHASE = "build";

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-e2e-productization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
  });
  await store.load();
  store.state.workstream_dag = { nodes: {}, edges: [] };
  store.state.repair_records = [];
  store.state.workstream_repair_records = [];
  await store.save();
  return store;
}

function enforceDagState(state) {
  if (!state.workstream_dag) state.workstream_dag = { nodes: {}, edges: [] };
  if (!state.workstream_dag.nodes) state.workstream_dag.nodes = {};
  if (!Array.isArray(state.workstream_dag.edges)) state.workstream_dag.edges = [];
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("G7-e2e-1: Create Workstream with identity", async (t) => {
  const store = await makeStore(t);
  const ws = await createWorkstream(store, {
    id: WS_ID,
    title: "TUI Productization E2E",
    project_id: "default",
    workspace_id: "hosted-default",
    root_goal_id: "goal_48d055ee",
    workflow_id: "wf_tui_pz_e2e",
    status: "active",
    execution_policy: { max_parallel_tasks: 5 },
    acceptance_policy: { require_documentation_update: true },
  });

  assert.equal(ws.id, WS_ID);
  assert.equal(ws.title, "TUI Productization E2E");
  assert.equal(ws.status, "active");
  assert.equal(ws.execution_policy.max_parallel_tasks, 5);
  assert.equal(ws.acceptance_policy.require_documentation_update, true);
  assert.match(ws.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // Reject duplicate
  await assert.rejects(
    () => createWorkstream(store, { id: WS_ID, title: "dup" }),
    /workstream already exists/i,
  );
});

test("G7-e2e-2: Bind multiple context links (G1)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Linked E2E" });

  const link1 = await linkWorkstreamContext(store, {
    workstream_id: WS_ID,
    kind: "chatgpt_conversation",
    external_id: "conv_e2e_1",
    relation: "originates",
    goal_id: "goal_1",
  });
  const link2 = await linkWorkstreamContext(store, {
    workstream_id: WS_ID,
    kind: "codex_thread",
    external_id: "thread_e2e_1",
    relation: "executes",
    task_id: "task_1",
  });
  const link3 = await linkWorkstreamContext(store, {
    workstream_id: WS_ID,
    kind: "github_issue",
    external_id: "issue_42",
    relation: "tracks",
    metadata: { repo: "org/repo" },
  });

  assert.match(link1.id, /^link_/);
  assert.match(link2.id, /^link_/);
  assert.match(link3.id, /^link_/);

  const allLinks = await listWorkstreamLinks(store, { workstream_id: WS_ID });
  assert.equal(allLinks.length, 3);

  const resolved = await resolveWorkstreamsByContext(store, "chatgpt_conversation", "conv_e2e_1");
  assert.equal(resolved.workstreams.length, 1);
  assert.equal(resolved.workstreams[0].id, WS_ID);
  assert.equal(resolved.links.length, 1);
  assert.equal(resolved.links[0].external_id, "conv_e2e_1");

  // Idempotent re-link (updates metadata)
  const relink = await linkWorkstreamContext(store, {
    workstream_id: WS_ID,
    kind: "chatgpt_conversation",
    external_id: "conv_e2e_1",
    relation: "originates",
    goal_id: "goal_1",
  });
  assert.equal(relink.id, link1.id); // same record updated
});

test("G7-e2e-3: Fan-out three tasks into DAG (G4)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Fan-out E2E" });
  enforceDagState(store.state);

  const SHARD_COUNT = 3;
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    shard_count: SHARD_COUNT,
    shard_prefix: "s",
    iteration: 0,
  });

  assert.ok(fanout.parent_node);
  assert.equal(fanout.parent_node.node_type, "fanout");
  assert.equal(fanout.shard_nodes.length, SHARD_COUNT);
  assert.equal(fanout.edges.length, SHARD_COUNT);

  const shardIds = fanout.shard_nodes.map((n) => n.id);
  for (let i = 0; i < SHARD_COUNT; i++) {
    const expectedId = buildShardNodeId({
      workstream_id: WS_ID,
      phase: PHASE,
      shard_key: `s_${i}`,
      iteration: 0,
    });
    assert.ok(shardIds.includes(expectedId), `Expected shard ${expectedId}`);
  }

  // Confirm idempotent fan-out
  const fanout2 = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    shard_count: SHARD_COUNT,
    iteration: 0,
  });
  assert.ok(fanout2.idempotent);
  assert.equal(fanout2.shard_nodes.length, SHARD_COUNT);

  // Verify graph structure
  const graph = await getExecutionGraph(store, WS_ID);
  assert.ok(graph.nodes.find((n) => n.id === fanout.parent_node.id));
  for (const shard of fanout.shard_nodes) {
    assert.ok(graph.nodes.find((n) => n.id === shard.id));
  }
});

test("G7-e2e-4: Independent worktrees for each shard (G2)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Worktrees E2E" });
  enforceDagState(store.state);

  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    shard_count: 3,
    iteration: 0,
  });

  // Each shard node acts as an independent worktree anchor.
  // Verify each shard has a unique ID and can be tracked separately.
  const shardIds = fanout.shard_nodes.map((n) => n.id);
  const uniqueIds = new Set(shardIds);
  assert.equal(uniqueIds.size, 3);

  // Mark each shard as having a dedicated worktree via metadata
  for (const shard of fanout.shard_nodes) {
    const updated = await updateDagNode(store, shard.id, {
      status: "running",
      metadata: {
        worktree_root: `/tmp/worktrees/${shard.id}`,
        task_id: `task_${shard.id}`,
      },
    });
    assert.equal(updated.status, "running");
    assert.ok(updated.metadata.worktree_root);
    assert.ok(updated.metadata.task_id);
  }

  // Verify all shards in execution graph
  const graph = await getExecutionGraph(store, WS_ID);
  for (const sid of shardIds) {
    const node = graph.nodes.find((n) => n.id === sid);
    assert.ok(node, `Shard ${sid} should exist in graph`);
    assert.equal(node.status, "running");
    assert.ok(node.metadata.worktree_root);
  }
});

test("G7-e2e-5: Structured subagents via progress (G3)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Subagents E2E" });
  enforceDagState(store.state);

  // Simulate structured subagent progress feed for each shard.
  const shardProgress = [
    {
      shard_key: "s_0",
      phase: "context_curation",
      status: "completed",
      subagents: [
        { role: "analyst", status: "completed", summary: "Analyzed requirements" },
        { role: "architect", status: "completed", summary: "Designed solution" },
      ],
    },
    {
      shard_key: "s_1",
      phase: "building",
      status: "running",
      subagents: [
        { role: "implementer", status: "running", summary: "Writing code" },
      ],
    },
    {
      shard_key: "s_2",
      phase: "planning",
      status: "completed",
      subagents: [
        { role: "analyst", status: "completed", summary: "Scoped work" },
        { role: "planner", status: "completed", summary: "Planned tasks" },
      ],
    },
  ];

  // Store progress as DAG node metadata for each shard
  for (const sp of shardProgress) {
    const nodeId = buildShardNodeId({
      workstream_id: WS_ID,
      phase: PHASE,
      shard_key: sp.shard_key,
      iteration: 0,
    });
    await createDagNode(store, {
      id: nodeId,
      workstream_id: WS_ID,
      phase: PHASE,
      shard_key: sp.shard_key,
      node_type: "task",
      status: sp.status === "completed" ? "completed" : "running",
      metadata: {
        progress: {
          phase: sp.phase,
          status: sp.status,
          subagents: sp.subagents,
        },
      },
    });
  }

  // Verify subagent progress is retrievable per shard
  for (const sp of shardProgress) {
    const nodeId = buildShardNodeId({
      workstream_id: WS_ID,
      phase: PHASE,
      shard_key: sp.shard_key,
      iteration: 0,
    });
    const node = await getDagNode(store, nodeId);
    assert.ok(node, `Node ${nodeId} should exist`);
    assert.ok(node.metadata.progress, `Node ${nodeId} should have progress`);
    assert.ok(Array.isArray(node.metadata.progress.subagents));
    assert.equal(node.metadata.progress.subagents.length, sp.subagents.length);
  }

  // Simulate completion of running shard
  const runningNodeId = buildShardNodeId({
    workstream_id: WS_ID,
    phase: PHASE,
    shard_key: "s_1",
    iteration: 0,
  });
  await updateDagNode(store, runningNodeId, {
    status: "completed",
    metadata: {
      progress: {
        phase: "building",
        status: "completed",
        subagents: [
          { role: "implementer", status: "completed", summary: "Completed code" },
          { role: "verifier", status: "completed", summary: "Verified" },
        ],
      },
    },
  });
  const updatedNode = await getDagNode(store, runningNodeId);
  assert.equal(updatedNode.status, "completed");
  assert.equal(updatedNode.metadata.progress.subagents.length, 2);
});

test("G7-e2e-6: Automatic acceptance evaluation (G5)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Acceptance E2E" });

  const task = {
    id: "task_e2e_accept",
    status: "completed",
    commit: "abc123def456",
    changed_files: ["src/test.mjs", "docs/test.md"],
    title: "E2E acceptance task",
    project_id: "default",
    workspace_id: "hosted-default",
  };

  const result = {
    status: "completed",
    summary: "E2E acceptance task completed",
    commit: "abc123def456",
    changed_files: ["src/test.mjs", "docs/test.md"],
    tests: "node --test passes",
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    reviewer_decision: { status: "accepted", passed: true },
  };

  const verification = { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] };
  const contract = { intent: { operation_kind: "code_change", mutation_scope: "repo" } };
  const gitState = { dirty: false, diff_empty: true, commit: "abc123def456" };

  const decision = evaluateAcceptance({
    task,
    result,
    verification,
    contract,
    gitState,
  });

  assert.equal(decision.verdict, VERDICT.PASSED);
  assert.equal(decision.blocker_count, 0);
  assert.ok(decision.dimensions.length >= 6);

  const controllerResult = await runAcceptanceController({
    task,
    goal: { id: "goal_e2e", acceptance_contract: contract },
    result,
    verification,
    contract,
    gitState,
    state: store.state,
  });

  assert.equal(controllerResult.controller_verdict, "acceptance_passed");
  assert.equal(controllerResult.action.action, "none");

  const failedResult = evaluateAcceptance({
    task: { id: "task_fail", status: "running" },
    result: { status: "running", changed_files: [] },
    contract: { intent: { operation_kind: "code_change", mutation_scope: "repo" } },
    gitState: { dirty: true, diff_empty: false },
  });
  assert.notEqual(failedResult.verdict, VERDICT.PASSED);
});

test("G7-e2e-7: Repair budget and convergence handling (G5)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Repair E2E" });

  const rootTaskId = "task_repair_root";
  const goal = { id: "goal_repair" };
  const task = { id: rootTaskId, title: "Repair test task" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [
      { code: "missing_test", severity: "blocker", message: "No test evidence" },
    ],
    idempotency_key: "acceptance:failed:test",
  };

  // First repair attempt
  const action1 = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [],
    currentAttempt: 0,
  });
  assert.equal(action1.action, "create_repair_goal");
  assert.ok(action1.payload);
  assert.equal(action1.payload.attempt, 1);

  // Second repair attempt
  const action2 = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [action1.record].filter(Boolean),
    currentAttempt: 1,
  });
  assert.equal(action2.action, "create_repair_goal");
  assert.equal(action2.payload.attempt, 2);

  // Third attempt -> budget exhausted -> escalation
  const action3 = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [action1.record, action2.record].filter(Boolean),
    currentAttempt: 2,
  });
  assert.equal(action3.action, "chatgpt_escalation");

  // Verify dedup
  const dedupCheck = findExistingRepairRecord({
    repairRecords: [action1.record].filter(Boolean),
    rootTaskId,
    kind: "repair_task",
    attempt: 1,
  });
  assert.ok(dedupCheck.exists);

  // Partial acceptance -> convergence
  const partialDecision = {
    verdict: VERDICT.PARTIAL,
    findings: [
      { code: "doc_pending", severity: "non_blocker", message: "Documentation pending" },
    ],
    idempotency_key: "acceptance:partial:doc",
  };
  const convergenceAction = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision: partialDecision,
    repairRecords: [],
    currentAttempt: 0,
  });
  assert.equal(convergenceAction.action, "create_convergence_goal");
  assert.ok(convergenceAction.payload);
});

test("G7-e2e-8: Join node integration (G4)", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Join E2E" });
  enforceDagState(store.state);

  // Create fan-out first
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    shard_count: 3,
    iteration: 0,
  });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  // Mark all shards completed
  for (const sid of shardIds) {
    await updateDagNode(store, sid, { status: "completed" });
  }

  // Create join node that waits for all predecessors
  const joinResult = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    predecessor_ids: shardIds,
    join_condition: "all_completed",
    shard_key: "integration",
    iteration: 0,
  });

  assert.ok(joinResult.join_node);
  assert.equal(joinResult.join_node.node_type, "join");
  assert.equal(joinResult.join_node.status, "waiting");
  assert.equal(joinResult.edges.length, 3);

  // Use a SYNCHRONOUS node state resolver that reads from the in-memory state
  const dagNodes = store.state.workstream_dag.nodes;
  const syncResolver = (nodeId) => {
    const node = dagNodes[nodeId];
    if (!node) return { id: nodeId, status: null, terminal: false, acceptance_gate: null, passed: false };
    const terminal = node.status === "completed" || node.status === "failed" || node.status === "cancelled";
    return {
      id: node.id,
      status: node.status,
      terminal,
      acceptance_gate: null,
      passed: terminal && node.status === "completed",
    };
  };

  const evalResult = await evaluateJoinCondition(store, joinResult.join_node.id, syncResolver);
  assert.ok(evalResult.satisfied, `Join condition not satisfied: ${evalResult.reason}`);
  assert.ok(evalResult.reason.includes("all_completed"), evalResult.reason);
  assert.ok(evalResult.reason.includes("3 predecessors"), evalResult.reason);

  // Create integration node (manual release) for downstream join
  const integrationResult = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    predecessor_ids: [joinResult.join_node.id],
    join_condition: "manual_release",
    shard_key: "final_integration",
    iteration: 0,
  });

  assert.equal(integrationResult.join_node.node_type, "integration");
  assert.equal(integrationResult.join_node.join_condition, "manual_release");

  // Idempotency of join creation
  const joinResult2 = await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    predecessor_ids: shardIds,
    join_condition: "all_completed",
    shard_key: "integration",
    iteration: 0,
  });
  assert.ok(joinResult2.idempotent);
  assert.equal(joinResult2.join_node.id, joinResult.join_node.id);
});

test("G7-e2e-9: Complete Workstream lifecycle", async (t) => {
  const store = await makeStore(t);

  // Step 1: Create workstream
  const ws = await createWorkstream(store, {
    id: WS_ID,
    title: "Full Lifecycle E2E",
    status: "planned",
  });
  assert.equal(ws.status, "planned");

  // Step 2: Update to active
  const activated = await updateWorkstream(store, WS_ID, { status: "active" });
  assert.equal(activated.status, "active");

  // Step 3: Add context links
  await linkWorkstreamContext(store, {
    workstream_id: WS_ID,
    kind: "chatgpt_conversation",
    external_id: "conv_lifecycle",
  });

  // Step 4: Fan-out and complete tasks
  enforceDagState(store.state);
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    shard_count: 2,
    iteration: 0,
  });
  for (const shard of fanout.shard_nodes) {
    await updateDagNode(store, shard.id, { status: "completed" });
  }

  // Step 5: Join
  const shardIds = fanout.shard_nodes.map((n) => n.id);
  await createWorkstreamJoin(store, {
    workstream_id: WS_ID,
    phase: PHASE,
    predecessor_ids: shardIds,
    shard_key: "lifecycle_join",
    iteration: 0,
  });

  // Step 6: Update to completed
  const completed = await updateWorkstream(store, WS_ID, { status: "completed" });
  assert.equal(completed.status, "completed");

  // Step 7: List workstreams
  const listed = await listWorkstreams(store, { status: "completed" });
  assert.ok(listed.some((w) => w.id === WS_ID));

  // Step 8: Verify workstream can be re-queried
  const fetched = await getWorkstream(store, WS_ID);
  assert.equal(fetched.id, WS_ID);
  assert.equal(fetched.status, "completed");
  assert.equal(fetched.title, "Full Lifecycle E2E");
});

test("G7-e2e-10: Acceptance controller direct correction flow", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Direct Correction E2E" });

  const task = {
    id: "task_dc",
    root_task_id: "task_dc_root",
    title: "Direct correction task",
    status: "completed",
  };
  const goal = { id: "goal_dc" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [
      { code: "missing_doc", severity: "blocker", message: "Documentation missing" },
    ],
    idempotency_key: "acceptance:failed:doc",
  };

  const corrections = [
    { file: "docs/readme.md", patch: "Add documentation", description: "Add missing doc" },
  ];

  const action = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [],
    currentAttempt: 0,
    corrections,
  });

  // Direct correction should be preferred before creating a repair goal
  assert.equal(action.action, "direct_correction");
  assert.ok(action.payload);
  assert.equal(action.payload.corrections.length, 1);
  assert.equal(action.payload.corrections[0].file, "docs/readme.md");
});

test("G7-e2e-11: Idempotent acceptance controller", async (t) => {
  const store = await makeStore(t);
  await createWorkstream(store, { id: WS_ID, title: "Idempotent E2E" });

  const input = {
    task: { id: "task_idemp", status: "completed", commit: "abc", changed_files: ["src/a.mjs"] },
    result: {
      status: "completed",
      summary: "Done",
      commit: "abc",
      changed_files: ["src/a.mjs"],
      tests: "ok",
      verification: { passed: true, commands: [] },
    },
    verification: { passed: true, commands: [] },
    contract: { intent: { operation_kind: "code_change" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc" },
  };

  const r1 = evaluateAcceptance(input);
  const r2 = evaluateAcceptance(input);
  assert.equal(r1.verdict, r2.verdict);
  assert.equal(r1.idempotency_key, r2.idempotency_key);
  assert.equal(r1.findings.length, r2.findings.length);
});
