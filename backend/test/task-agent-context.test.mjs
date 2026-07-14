import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { createTaskContextStore } from "../src/context-contract/task-context-store.mjs";
import { prepareTaskAgentContext } from "../src/subagents/task-agent-context.mjs";
import { createSubagentProgressStore } from "../src/subagents/subagent-progress-store.mjs";

test("prepareTaskAgentContext persists role views and non-blocking advisory runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-agent-context-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  store.state.goals = [{ id: "goal_ctx", workstream_id: "ws_ctx", task_context: { contract_digest: "sha256:ctx" } }];
  store.state.tasks = [{ id: "task_ctx", goal_id: "goal_ctx", workstream_id: "ws_ctx", task_context_digest: "sha256:ctx", pipeline_version: "task_pipeline_v2" }];
  await store.save();
  const packet = {
    schema_version: "gptwork.task_context.v1",
    identity: { workstream_id: "ws_ctx", goal_id: "goal_ctx", task_id: "task_ctx", context_revision: 1 },
    objective: "Wire role views", background: [], confirmed_findings: [],
    scope: { include: ["backend/**"], exclude: [] }, required_changes: [],
    acceptance_criteria: [{ id: "ac", description: "works", blocking: true, verification_hint: null }],
    constraints: [], open_questions: [], carry_forward: [], source_provenance: [],
    raw_conversation_policy: { stored: true, indexed: false, injected: false, targeted_lookup_allowed: true }
  };
  await createTaskContextStore({ workspaceRoot: root }).writePacket(".gptwork/goals/goal_ctx", packet);
  const result = await prepareTaskAgentContext(store, { task_id: "task_ctx", goal_id: "goal_ctx" });
  assert.equal(result.prepared, true);
  assert.deepEqual(result.advisory_runs.map((run) => run.role).sort(), ["architect", "explorer", "test_analyst"]);
  assert.ok(result.advisory_runs.every((run) => run.blocking === false));
  assert.ok(result.role_views.builder.path.endsWith("roles/builder.view.json"));
  assert.equal(result.role_views.builder.view.permissions.write_product_code, true);
  assert.equal(result.role_views.reviewer.view.permissions.write_product_code, false);
  assert.ok(result.role_views.planner.view.payload.advisory_artifacts.length === 3);
  assert.ok(result.role_views.builder.view.excluded_sources.includes("raw_chatgpt_transcript"));
});

test("task_pipeline_v2 creates advisory runs and context-bound formal runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-agent-pipeline-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  store.state.goals = [{ id: "goal_pipe", workstream_id: "ws_pipe", task_context: { contract_digest: "sha256:pipe", revision: 1 } }];
  store.state.tasks = [{
    id: "task_pipe", goal_id: "goal_pipe", workstream_id: "ws_pipe",
    task_context_digest: "sha256:pipe", task_context_revision: 1,
    pipeline_version: "task_pipeline_v2", require_pipeline_gates: true
  }];
  await store.save();
  const packet = {
    schema_version: "gptwork.task_context.v1",
    identity: { workstream_id: "ws_pipe", goal_id: "goal_pipe", task_id: "task_pipe", context_revision: 1 },
    objective: "Create context-bound pipeline", background: [], confirmed_findings: [],
    scope: { include: ["backend/**"], exclude: [] }, required_changes: [],
    acceptance_criteria: [{ id: "ac", description: "works", blocking: true, verification_hint: null }],
    constraints: [], open_questions: [], carry_forward: [], source_provenance: [],
    raw_conversation_policy: { stored: true, indexed: false, injected: false, targeted_lookup_allowed: true }
  };
  await createTaskContextStore({ workspaceRoot: root }).writePacket(".gptwork/goals/goal_pipe", packet);
  const { createDefaultAgentPipeline } = await import("../src/pipeline-orchestration.mjs");
  const result = await createDefaultAgentPipeline(store, { task_id: "task_pipe", goal_id: "goal_pipe" });
  assert.deepEqual(result.agent_runs.map((run) => run.contract_role), [
    "context_curator", "planner", "builder", "verifier", "reviewer", "finalizer"
  ]);
  assert.ok(result.agent_runs.every((run) => run.input_context_digest === "sha256:pipe"));
  assert.ok(result.agent_runs.every((run) => run.role_view_path?.includes("/roles/")));
  assert.ok(result.agent_runs.every((run) => run.require_fresh_artifacts === true));
  const state = await store.load();
  assert.equal(state.advisory_runs.length, 3);
  const progress = await createSubagentProgressStore({ workspaceRoot: root }).readProgress("goal_pipe");
  assert.ok(progress, "pipeline creation should synchronously materialize progress.json");
  assert.deepEqual(
    progress.subagents.map((item) => item.role).sort(),
    ["architect", "builder", "context_curator", "explorer", "finalizer", "planner", "reviewer", "test_analyst", "verifier"].sort()
  );
  assert.equal(progress.subagents.find((item) => item.role === "explorer").blocking, false);
  assert.ok(progress.subagents.every((item) => item.input_context_digest === "sha256:pipe"));
});
