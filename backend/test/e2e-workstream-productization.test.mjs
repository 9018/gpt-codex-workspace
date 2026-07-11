/**
 * e2e-workstream-productization.test.mjs — End-to-end Workstream
 * productization scenario integrating G1–G6 APIs.
 *
 * Scenarios:
 *   1. Create a Workstream via workstream-service
 *   2. Bind multiple context links via context-links
 *   3. Fan-out three parallel tasks via task-fanout-service
 *   4. Verify independent worktree creation via worktree-service
 *   5. Structured subagent policy verification
 *   6. Auto-acceptance via acceptance controller
 *   7. Repair/convergence via repair-task-factory
 *   8. Join/integration via task-join-service
 *   9. Complete Workstream
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { StateStore } from "../src/state-store.mjs";

// -- G1: Workstream model & service imports --
import {
  createWorkstream,
  getWorkstream,
  listWorkstreams,
  updateWorkstream,
} from "../src/workstream/workstream-service.mjs";
import {
  createWorkstreamRecord,
  normalizeLegacyGoalWorkstream,
  normalizeLegacyTaskWorkstream,
} from "../src/workstream/workstream-model.mjs";

// -- G2: Worktree service imports --
import {
  checkWorktreeDirty,
} from "../src/worktree-service.mjs";

// -- G3: Subagent policy imports --
import {
  DEFAULT_AGENT_PIPELINE,
  ALL_PIPELINE_ROLES,
  REPAIRER_ROLE,
} from "../src/subagent-policy.mjs";

// -- G4: DAG fan-out/join imports --
import {
  createWorkstreamFanout,
  buildShardNodeId,
  buildFanoutParentNodeId,
} from "../src/orchestration/task-fanout-service.mjs";
import {
  createWorkstreamJoin,
  evaluateJoinCondition,
  manualReleaseJoin,
  buildJoinNodeId,
  getJoinStatus,
} from "../src/orchestration/task-join-service.mjs";
import { getExecutionGraph } from "../src/orchestration/task-dag-service.mjs";
import { JOIN_CONDITIONS } from "../src/orchestration/dependency-resolver.mjs";

// -- G5: Acceptance controller imports --
import {
  runAcceptanceController,
  CONTROLLER_ACTION,
} from "../src/acceptance/workstream-acceptance-controller.mjs";
import {
  evaluateAcceptance,
  quickAcceptanceCheck,
  VERDICT,
} from "../src/acceptance/workstream-acceptance-decision.mjs";
import {
  scheduleRepairAction,
  findExistingRepairRecord,
  buildRepairGoalPayload,
  buildConvergenceGoalPayload,
  buildChatGptEscalationPayload,
  buildDirectCorrectionPayload,
  MAX_REPAIR_ATTEMPTS,
  REPAIR_KIND,
} from "../src/acceptance/workstream-repair-task-factory.mjs";

// -- G6: Context links imports --
import {
  linkWorkstreamContext,
  listWorkstreamLinks,
  resolveWorkstreamsByContext,
} from "../src/workstream/workstream-context-links.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(dir) {
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.workstreams ??= [];
  store.state.context_links ??= [];
  store.state.workstream_dag ??= { nodes: {}, edges: [] };
  await store.save();
  return store;
}

// ---------------------------------------------------------------------------
// G1: Workstream Identity and Context Links
// ---------------------------------------------------------------------------

test("[G1] createWorkstream — creates a workstream with identity and default policies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g1-"));
  const store = await makeStore(dir);

  const ws = await createWorkstream(store, {
    title: "TUI Productization E2E",
    project_id: "default",
    workspace_id: "hosted-default",
    repo_id: "default",
    root_goal_id: "goal_e2e_root",
    workflow_id: "wf_e2e_productization",
  });

  assert.match(ws.id, /^ws_/);
  assert.equal(ws.status, "planned");
  assert.equal(ws.execution_policy.max_parallel_tasks, 3);
  assert.equal(ws.acceptance_policy.require_documentation_update, true);
  assert.ok(ws.id, "workstream ID is set");
});

test("[G1] linkWorkstreamContext — binds multiple external contexts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g1-links-"));
  const store = await makeStore(dir);

  const ws = await createWorkstream(store, { title: "Linked contexts" });

  await linkWorkstreamContext(store, {
    workstream_id: ws.id,
    kind: "chatgpt_conversation",
    external_id: "conv_e2e_1",
    relation: "originates",
    goal_id: "goal_e2e_1",
  });
  await linkWorkstreamContext(store, {
    workstream_id: ws.id,
    kind: "chatgpt_conversation",
    external_id: "conv_e2e_2",
    relation: "continues",
  });
  await linkWorkstreamContext(store, {
    workstream_id: ws.id,
    kind: "codex_thread",
    external_id: "thread_e2e_abc",
    task_id: "task_e2e_1",
  });

  const links = await listWorkstreamLinks(store, { workstream_id: ws.id });
  assert.equal(links.length, 3);

  const resolved = await resolveWorkstreamsByContext(store, "chatgpt_conversation", "conv_e2e_1");
  assert.deepEqual(resolved.workstreams.map((w) => w.id), [ws.id]);
});

test("[G1] createWorkstream — CRUD round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g1-crud-"));
  const store = await makeStore(dir);

  const ws = await createWorkstream(store, { title: "CRUD test" });
  const fetched = await getWorkstream(store, ws.id);
  assert.equal(fetched.title, "CRUD test");

  const updated = await updateWorkstream(store, ws.id, { status: "active" });
  assert.equal(updated.status, "active");
  assert.equal(updated.id, ws.id);

  const listed = await listWorkstreams(store, { status: "active" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, ws.id);
});

// ---------------------------------------------------------------------------
// G2: Task Worktree
// ---------------------------------------------------------------------------

test("[G2] checkWorktreeDirty — validates worktree state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g2-"));

  // Create a minimal git repo
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", timeout: 10000 });
  execFileSync("git", ["config", "user.email", "e2e@test"], { cwd: dir, encoding: "utf8", timeout: 10000 });
  execFileSync("git", ["config", "user.name", "E2E Test"], { cwd: dir, encoding: "utf8", timeout: 10000 });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir, encoding: "utf8", timeout: 10000 });

  // Test that clean repo is not dirty
  const dirtiness = await checkWorktreeDirty({ repoPath: dir });
  assert.equal(dirtiness.dirty, false);
  assert.ok(dirtiness.ok);

  // After adding an untracked file
  execFileSync("touch", ["untracked.txt"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  const dirty2 = await checkWorktreeDirty({ repoPath: dir });
  assert.equal(dirty2.dirty, true);
});

// ---------------------------------------------------------------------------
// G3: Structured Subagents
// ---------------------------------------------------------------------------

test("[G3] subagent policy — correct default pipeline and roles", () => {
  assert.deepEqual(DEFAULT_AGENT_PIPELINE, [
    "context_curator",
    "planner",
    "builder",
    "verifier",
    "reviewer",
    "integrator",
    "finalizer",
  ]);
  assert.equal(REPAIRER_ROLE, "repairer");
  assert.ok(ALL_PIPELINE_ROLES.length >= DEFAULT_AGENT_PIPELINE.length + 1);
  assert.ok(ALL_PIPELINE_ROLES.includes("repairer"));
});

// ---------------------------------------------------------------------------
// G4: Fan-out, Join, and DAG Orchestration
// ---------------------------------------------------------------------------

test("[G4] createWorkstreamFanout — fans out 3 parallel tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g4-"));
  const store = await makeStore(dir);
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();

  const wsId = "ws_e2e_fanout_3";
  const result = await createWorkstreamFanout(store, {
    workstream_id: wsId,
    phase: "build",
    shard_count: 3,
    shard_prefix: "feature",
    iteration: 0,
  });

  assert.ok(result.parent_node);
  assert.equal(result.parent_node.node_type, "fanout");
  assert.equal(result.parent_node.metadata.shard_count, 3);
  assert.equal(result.shard_nodes.length, 3);

  const expectedShards = ["feature_0", "feature_1", "feature_2"].map((sk) =>
    buildShardNodeId({ workstream_id: wsId, phase: "build", shard_key: sk, iteration: 0 })
  );
  const shardIds = result.shard_nodes.map((n) => n.id);
  for (const eid of expectedShards) {
    assert.ok(shardIds.includes(eid), `Expected shard ${eid} in ${shardIds}`);
  }

  assert.equal(result.edges.length, 3);

  const graph = await getExecutionGraph(store, wsId);
  assert.ok(graph.nodes.find((n) => n.id === result.parent_node.id));
});

test("[G4] createWorkstreamJoin — joins predecessor tasks with all_completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g4-join-"));
  const store = await makeStore(dir);
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();

  const wsId = "ws_e2e_join";
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: wsId, phase: "build", shard_count: 2, iteration: 0,
  });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  const joinResult = await createWorkstreamJoin(store, {
    workstream_id: wsId, phase: "build",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ALL_COMPLETED,
    shard_key: "integration", iteration: 0,
  });

  assert.ok(joinResult.join_node);
  assert.equal(joinResult.join_node.node_type, "join");
  assert.equal(joinResult.join_node.status, "waiting");
  assert.equal(joinResult.edges.length, 2);

  // Idempotent second call
  const second = await createWorkstreamJoin(store, {
    workstream_id: wsId, phase: "build",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ALL_COMPLETED,
    shard_key: "integration", iteration: 0,
  });
  assert.ok(second.idempotent);
  assert.equal(second.join_node.id, joinResult.join_node.id);
});

test("[G4] createWorkstreamJoin — manual_release join type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g4-manual-"));
  const store = await makeStore(dir);
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();

  const wsId = "ws_e2e_manual";
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: wsId, phase: "rel", shard_count: 1, iteration: 0,
  });
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  const joinResult = await createWorkstreamJoin(store, {
    workstream_id: wsId, phase: "rel",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.MANUAL_RELEASE,
    shard_key: "manual_join", iteration: 0,
  });

  const before = await evaluateJoinCondition(store, joinResult.join_node.id, null, { manualReleaseTriggered: false });
  assert.equal(before.satisfied, false);

  const released = await manualReleaseJoin(store, joinResult.join_node.id);
  assert.ok(released.metadata.manual_release_triggered);
});

test("[G4] fan-out is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-g4-idemp-"));
  const store = await makeStore(dir);
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();

  const first = await createWorkstreamFanout(store, {
    workstream_id: "ws_e2e_idemp", phase: "t", shard_count: 2, iteration: 0,
  });
  const second = await createWorkstreamFanout(store, {
    workstream_id: "ws_e2e_idemp", phase: "t", shard_count: 2, iteration: 0,
  });
  assert.ok(second.idempotent);
  assert.equal(second.shard_nodes.length, first.shard_nodes.length);
});

// ---------------------------------------------------------------------------
// G5: Acceptance Controller & Decision
// ---------------------------------------------------------------------------

test("[G5] evaluateAcceptance — task with all evidence passes", () => {
  const result = evaluateAcceptance({
    task: { id: "task_pass" },
    goal: { id: "goal_pass" },
    result: {
      summary: "Done",
      status: "completed",
      commit: "abc123",
      changed_files: ["src/foo.mjs"],
      tests: "all pass",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "implementation" } },
    gitState: { dirty: false, diff_empty: false },
  });
  assert.equal(result.verdict, VERDICT.PASSED);
  assert.equal(result.blocker_count, 0);
});

test("[G5] evaluateAcceptance — missing result artifact fails", () => {
  const result = evaluateAcceptance({
    task: { id: "task_fail" },
    goal: {},
    result: {},
    verification: {},
    contract: { intent: { operation_kind: "implementation" } },
    gitState: {},
  });
  assert.notEqual(result.verdict, VERDICT.PASSED);
  assert.ok(result.blocker_count > 0);
});

test("[G5] quickAcceptanceCheck — passes when all signals present", () => {
  const check = quickAcceptanceCheck({
    result: { status: "completed", summary: "ok", commit: "abc", changed_files: ["f"] },
    verification: { passed: true },
  });
  assert.equal(check.passed, true);
});

test("[G5] quickAcceptanceCheck — fails when signals missing", () => {
  const check = quickAcceptanceCheck({ result: {}, verification: {} });
  assert.equal(check.passed, false);
});

test("[G5] runAcceptanceController — passed task returns acceptance_passed", async () => {
  const result = await runAcceptanceController({
    task: { id: "task_pass" },
    goal: { id: "goal_pass" },
    result: {
      summary: "Done",
      status: "completed",
      commit: "abc123",
      changed_files: ["src/test.mjs"],
      tests: "pass",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "implementation" } },
    gitState: { dirty: false, diff_empty: false },
  });
  assert.equal(result.controller_verdict, "acceptance_passed");
});

test("[G5] runAcceptanceController — failed task creates repair action", async () => {
  const result = await runAcceptanceController({
    task: { id: "task_fail" },
    goal: {},
    result: {},
    verification: {},
    contract: { intent: { operation_kind: "implementation" } },
    gitState: {},
    state: { repair_records: [] },
  });
  assert.notEqual(result.controller_verdict, "acceptance_passed");
  assert.ok(result.action.action !== undefined);
});

test("[G5] buildRepairGoalPayload — creates structured repair goal", () => {
  const payload = buildRepairGoalPayload({
    task: { id: "task_repair", title: "Broken task" },
    goal: { id: "goal_repair" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "changed_files_mismatch", message: "No files" }],
    },
    attempt: 1,
  });
  assert.match(payload.title, /Repair/);
  assert.ok(payload.assign_to_codex);
  assert.equal(payload.repair_attempt, 1);
});

test("[G5] buildConvergenceGoalPayload — creates convergence goal", () => {
  const payload = buildConvergenceGoalPayload({
    task: { id: "task_conv", title: "Partial task" },
    goal: { id: "goal_conv" },
    acceptanceDecision: {
      verdict: "partial",
      findings: [{ severity: "blocker", code: "docs_updated", message: "Docs needed" }],
    },
    convergenceKey: "conv_key_123",
  });
  assert.match(payload.title, /Convergence/);
});

test("[G5] buildChatGptEscalationPayload — creates escalation", () => {
  const payload = buildChatGptEscalationPayload({
    task: { id: "task_esc", title: "Esc task" },
    goal: {},
    acceptanceDecision: { verdict: "blocked", findings: [] },
    attempt: 3,
  });
  assert.equal(payload.escalation_category, "acceptance_escalation");
  assert.ok(payload.default_if_no_response);
});

test("[G5] scheduleRepairAction — deduplicates repair records", () => {
  const repairRecords = [{
    id: "repair_1",
    root_task_id: "root_42",
    kind: REPAIR_KIND.REPAIR_TASK,
    attempt: 1,
  }];

  const first = scheduleRepairAction({
    task: { id: "task_1", root_task_id: "root_42" },
    goal: {},
    acceptanceDecision: { verdict: "failed", findings: [{ severity: "blocker", code: "test_fail", message: "fail" }] },
    repairRecords: [],
    currentAttempt: 0,
  });
  assert.equal(first.action, "create_repair_goal");
  assert.equal(first.deduplicated, false);

  const dup = scheduleRepairAction({
    task: { id: "task_1", root_task_id: "root_42" },
    goal: {},
    acceptanceDecision: { verdict: "failed", findings: [{ severity: "blocker", code: "test_fail", message: "fail" }] },
    repairRecords,
    currentAttempt: 0,
  });
  assert.equal(dup.action, "deduplicated");
  assert.equal(dup.deduplicated, true);
});

// ---------------------------------------------------------------------------
// G6: Workstream Product Experience
// ---------------------------------------------------------------------------

test("[G6] normalizeLegacyGoalWorkstream — preserves goal identity", () => {
  const goal = { id: "goal_legacy", conversation_id: "conv_legacy", title: "Legacy" };
  const normalized = normalizeLegacyGoalWorkstream(goal);
  assert.notEqual(normalized, goal);
  assert.equal(normalized.conversation_id, "conv_legacy");
  assert.equal(normalized.root_goal_id, "goal_legacy");
});

test("[G6] normalizeLegacyTaskWorkstream — preserves task workstream identity", () => {
  const goal = { id: "goal_ws", conversation_id: "conv_ws" };
  const task = { id: "task_ws", goal_id: goal.id };
  const normalized = normalizeLegacyTaskWorkstream(task, goal);
  assert.equal(normalized.root_goal_id, "goal_ws");
  assert.equal(normalized.goal_id, "goal_ws");
});

// ---------------------------------------------------------------------------
// Combined scenario: full Workstream productization flow
// ---------------------------------------------------------------------------

test("[G7] full workstream productization flow — create, link, fan-out, join, and complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-e2e-full-"));
  const store = await makeStore(dir);
  store.state.workstream_dag = { nodes: {}, edges: [] };
  await store.save();

  // 1. Create Workstream
  const ws = await createWorkstream(store, {
    title: "E2E Full Workstream Integration",
    project_id: "default",
    workspace_id: "hosted-default",
    root_goal_id: "goal_e2e_full_root",
  });
  assert.match(ws.id, /^ws_/);

  // 2. Bind context links
  const link1 = await linkWorkstreamContext(store, {
    workstream_id: ws.id,
    kind: "chatgpt_conversation",
    external_id: "conv_e2e_full",
    relation: "originates",
  });
  const link2 = await linkWorkstreamContext(store, {
    workstream_id: ws.id,
    kind: "codex_thread",
    external_id: "thread_e2e_full",
    relation: "executes",
  });
  assert.match(link1.id, /^link_/);
  assert.match(link2.id, /^link_/);

  // 3. Fan-out 3 parallel tasks
  const fanout = await createWorkstreamFanout(store, {
    workstream_id: ws.id,
    phase: "implementation",
    shard_count: 3,
    shard_prefix: "shard",
    iteration: 0,
    metadata: { workstream_id: ws.id },
  });
  assert.equal(fanout.shard_nodes.length, 3);
  const shardIds = fanout.shard_nodes.map((n) => n.id);

  // 4. Join all shards
  const joinResult = await createWorkstreamJoin(store, {
    workstream_id: ws.id,
    phase: "implementation",
    predecessor_ids: shardIds,
    join_condition: JOIN_CONDITIONS.ALL_COMPLETED,
    shard_key: "integration",
    iteration: 0,
  });
  assert.ok(joinResult.join_node);
  assert.equal(joinResult.join_node.join_condition, "all_completed");

  // 5. Verify execution graph has both fan-out and join nodes
  const graph = await getExecutionGraph(store, ws.id);
  const nodeTypes = graph.nodes.map((n) => n.node_type);
  assert.ok(nodeTypes.includes("fanout"), "Execution graph has fanout node");
  assert.ok(nodeTypes.includes("join"), "Execution graph has join node");

  // 6. Acceptance check for a completed task
  const fullResult = evaluateAcceptance({
    task: { id: "task_completed" },
    goal: { id: "goal_e2e_full_root" },
    result: {
      summary: "All shards completed successfully",
      status: "completed",
      commit: "abc123",
      changed_files: ["src/feature-a.mjs", "src/feature-b.mjs", "src/feature-c.mjs"],
      tests: "npm test passed",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "implementation" } },
    gitState: { dirty: false, diff_empty: false },
  });
  assert.equal(fullResult.verdict, VERDICT.PASSED,
    "Full workstream productization: all acceptance criteria satisfied");

  // 7. Update workstream to completed
  const completed = await updateWorkstream(store, ws.id, { status: "completed" });
  assert.equal(completed.status, "completed");
});
