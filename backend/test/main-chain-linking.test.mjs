/**
 * main-chain-linking.test.mjs
 *
 * P0-MA12-G5: 全链路主链链接测试 — validates the end-to-end
 * Goal → Agent Pipeline → Subagent Progress → TUI structured data → Acceptance → Integration chain.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state-store.mjs";
import { ensurePipelineRunsForTask } from "../src/pipeline-orchestration.mjs";
import {
  writeBuilderAgentRun,
  writeVerifierAgentRun,
  writeReviewerAgentRun,
  writeIntegratorAgentRun,
  writeFinalizerAgentRun,
  writeContextCuratorAgentRun,
  writePlannerAgentRun,
} from "../src/agent-run-writeback.mjs";
import { syncAgentRunProgress, buildProgressFromAgentRuns } from "../src/subagent-progress-bridge.mjs";

const ctx = {
  user_id: "test_user",
  project_ids: ["*"],
  workspace_ids: ["*"],
  scopes: ["task:create", "task:update", "task:*", "workspace:*", "project:*"],
};

function nowISO() { return new Date().toISOString(); }

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mcl-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  store.state.workstreams = [];
  store.state.context_links = [];
  await store.save();
  return { store, root };
}

test("mcl: context_curator + planner agent runs created and synced to progress store", async (t) => {
  const { store, root } = await makeStore(t);
  const goalId = "goal_mcl_01";
  const taskId = "task_mcl_01";

  await store.mutate((s) => {
    s.goals.push({
      id: goalId, project_id: "default", workspace_id: "hosted-default",
      conversation_id: `conv_${goalId}`, user_request: "Main chain linking test",
      title: "MCL Test 1", created_by: "test_user", assignee: "codex",
      status: "assigned", mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
    s.tasks.push({
      id: taskId, goal_id: goalId, project_id: "default", workspace_id: "hosted-default",
      title: "MCL Test Task", assignee: "codex", status: "assigned",
      mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
  });

  // Step 1: Ensure pipeline runs are created
  const pipelineResult = await ensurePipelineRunsForTask(store, { task_id: taskId, goal_id: goalId });
  assert.ok(pipelineResult.runs.length >= 2, "At least context_curator and planner runs created");
  const roles = pipelineResult.runs.map((r) => r.role);
  assert.ok(roles.includes("context_curator"), "context_curator run created");
  assert.ok(roles.includes("planner"), "planner run created");

  // Step 2: Write context curator + planner agent runs
  await writeContextCuratorAgentRun(store, {
    task_id: taskId, goal_id: goalId,
    artifacts: { codex_entry: { path: "codex.entry.md", required: true, present: true } },
  });
  await writePlannerAgentRun(store, {
    task_id: taskId, goal_id: goalId,
    planEvidence: { plan: { path: "plan.md", present: true } },
  });

  // Step 3: Sync progress to the subagent progress store
  const { progress, subagents } = await syncAgentRunProgress({
    store, workspaceRoot: root, goalId, taskId,
  });
  assert.ok(progress !== null, "progress.json should be written");
  assert.ok(Array.isArray(subagents), "subagents.json should be an array");
  assert.ok(subagents.length >= 2, "At least 2 subagents entries");

  // Step 4: Verify progress structure
  assert.ok(progress.phase, "progress has a phase");
  assert.ok(progress.status, "progress has a status");
  assert.ok(Array.isArray(progress.subagents), "progress has subagents array");
  assert.equal(typeof progress.last_progress_at, "string", "progress has timestamp");
});

test("mcl: full pipeline lifecycle with progress tracking", async (t) => {
  const { store, root } = await makeStore(t);
  const goalId = "goal_mcl_02";
  const taskId = "task_mcl_02";

  await store.mutate((s) => {
    s.goals.push({
      id: goalId, project_id: "default", workspace_id: "hosted-default",
      conversation_id: `conv_${goalId}`, user_request: "Full pipeline test",
      title: "MCL Test 2", created_by: "test_user", assignee: "codex",
      status: "assigned", mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
    s.tasks.push({
      id: taskId, goal_id: goalId, project_id: "default", workspace_id: "hosted-default",
      title: "Full Pipeline Task", assignee: "codex", status: "assigned",
      mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
  });

  // Step 1: All pipeline runs
  await ensurePipelineRunsForTask(store, { task_id: taskId, goal_id: goalId });

  // Step 2: Simulate full pipeline execution
  await writeContextCuratorAgentRun(store, { task_id: taskId, goal_id: goalId, artifacts: { entry: { present: true } } });
  await writePlannerAgentRun(store, { task_id: taskId, goal_id: goalId, planEvidence: { plan: { present: true } } });
  await writeBuilderAgentRun(store, { task_id: taskId, goal_id: goalId, taskResult: { changed_files: ["src/main.js"], commit: "abc123", status: "completed" }, summary: "Builder completed" });
  await writeVerifierAgentRun(store, { task_id: taskId, goal_id: goalId, verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] } });
  await writeReviewerAgentRun(store, { task_id: taskId, goal_id: goalId, reviewer_decision: { passed: true } });
  await writeIntegratorAgentRun(store, { task_id: taskId, goal_id: goalId, integrationResult: { status: "merged" } });
  await writeFinalizerAgentRun(store, { task_id: taskId, goal_id: goalId, taskResult: { status: "completed" } });

  // Step 3: Sync progress
  const { progress, subagents } = await syncAgentRunProgress({
    store, workspaceRoot: root, goalId, taskId,
  });
  assert.ok(progress !== null, "progress.json written");
  assert.ok(subagents.length >= 7, "All 7 pipeline roles in subagents.json");

  // Step 4: Check pipeline status
  assert.equal(progress.status, "completed", "Pipeline status should be completed");
  const completedRoles = subagents.filter((s) => s.status === "completed").map((s) => s.role);
  assert.ok(completedRoles.includes("planner"), "planner completed");
  assert.ok(completedRoles.includes("builder"), "builder completed");
  assert.ok(completedRoles.includes("verifier"), "verifier completed");
  assert.ok(completedRoles.includes("reviewer"), "reviewer completed");
  assert.ok(completedRoles.includes("integrator"), "integrator completed");
  assert.ok(completedRoles.includes("finalizer"), "finalizer completed");

  // Step 5: Verify MCP tool-compatible output format
  assert.equal(typeof progress.phase, "string");
  assert.equal(typeof progress.current_action, "string");
  assert.ok(Array.isArray(progress.blockers));
  assert.ok(Array.isArray(progress.subagents));
});

test("mcl: buildProgressFromAgentRuns produces correct progress shape", () => {
  const agentRuns = [
    { role: "context_curator", status: "completed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z", output_artifacts: [{ kind: "context_bundle" }] },
    { role: "planner", status: "completed", created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T02:00:00Z", output_artifacts: [{ kind: "plan" }] },
    { role: "builder", status: "completed", created_at: "2026-01-01T02:00:00Z", updated_at: "2026-01-01T03:00:00Z", output_artifacts: [{ kind: "change_summary", path: "src/main.js" }] },
    { role: "verifier", status: "completed", created_at: "2026-01-01T03:00:00Z", updated_at: "2026-01-01T04:00:00Z", output_artifacts: [{ kind: "verification", passed: true }] },
  ];
  const progress = buildProgressFromAgentRuns(agentRuns);
  assert.equal(progress.status, "completed", "All completed = pipeline completed");
  assert.equal(progress.subagents.length, 4, "4 subagents mapped");
  assert.ok(progress.last_progress_at, "Has timestamp");
  assert.equal(progress.current_action, "idle", "No running agents");

  const partial = [
    { role: "context_curator", status: "completed" },
    { role: "builder", status: "running" },
  ];
  const partialProgress = buildProgressFromAgentRuns(partial);
  assert.equal(partialProgress.status, "running", "Running agent means pipeline running");
  assert.ok(partialProgress.current_action.includes("builder"), "Current action mentions running role");
});

test("mcl: subagent-progress-bridge handles empty agent runs gracefully", async (t) => {
  const { store, root } = await makeStore(t);
  const goalId = "goal_mcl_empty";

  await store.mutate((s) => {
    s.goals.push({
      id: goalId, project_id: "default", workspace_id: "hosted-default",
      conversation_id: `conv_${goalId}`, user_request: "Empty test",
      title: "MCL Empty", created_by: "test_user", assignee: "codex",
      status: "assigned", mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
  });

  // Sync with no task — should return nulls
  const { progress, subagents } = await syncAgentRunProgress({
    store, workspaceRoot: root, goalId, taskId: "nonexistent",
  });
  assert.equal(progress, null, "No progress with nonexistent task");
  assert.equal(subagents, null, "No subagents with nonexistent task");

  // Sync with non-existent goal — should not throw
  const noGoal = await syncAgentRunProgress({
    store, workspaceRoot: root, goalId: "nonexistent", taskId: "nonexistent",
  });
  assert.equal(noGoal.progress, null, "Non-existent goal returns null");
});

test("mcl: integrateAgentRunProgress is idempotent", async (t) => {
  const { store, root } = await makeStore(t);
  const goalId = "goal_mcl_idempotent";
  const taskId = "task_mcl_idempotent";

  await store.mutate((s) => {
    s.goals.push({
      id: goalId, project_id: "default", workspace_id: "hosted-default",
      conversation_id: `conv_${goalId}`, user_request: "Idempotent test",
      title: "MCL Idempotent", created_by: "test_user", assignee: "codex",
      status: "assigned", mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
    s.tasks.push({
      id: taskId, goal_id: goalId, project_id: "default", workspace_id: "hosted-default",
      title: "Idempotent Task", assignee: "codex", status: "assigned",
      mode: "full", created_at: nowISO(), updated_at: nowISO(),
    });
    s.agent_runs.push({
      id: "agent_run_existing", task_id: taskId, goal_id: goalId,
      role: "builder", contract_role: "builder",
      status: "completed", summary: "Builder done",
      output_artifacts: [{ kind: "change_summary", path: "src/main.js" }],
      created_at: nowISO(), updated_at: nowISO(),
    });
  });

  // First call
  const first = await syncAgentRunProgress({ store, workspaceRoot: root, goalId, taskId });
  assert.ok(first.progress !== null, "First call writes progress");

  // Second call — should merge, not duplicate
  const second = await syncAgentRunProgress({ store, workspaceRoot: root, goalId, taskId });
  assert.ok(second.progress !== null, "Second call writes progress");
  assert.equal(second.progress.subagents.length, 1, "No duplicate subagents after second call");

  // Verify each subagent is unique by role
  const roles = second.progress.subagents.map((s) => s.role);
  const uniqueRoles = new Set(roles);
  assert.equal(uniqueRoles.size, roles.length, "All subagents are unique by role");
});
