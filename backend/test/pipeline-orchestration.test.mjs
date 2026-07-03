import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

// Import module functions for sync tests
import {
  DEFAULT_AGENT_PIPELINE,
  REPAIRER_ROLE,
  LEGACY_ROLE_MAPPING,
  DEFAULT_AGENT_BACKEND_BY_ROLE,
  resolveDefaultBackendForRole,
  mapLegacyRole,
  isRecoveryBranchRole,
} from "../src/subagent-policy.mjs";

import {
  isLegacyTask,
  getEffectivePipelineRoles,
  resolveRoleBackend,
} from "../src/pipeline-orchestration.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "pipeline-orch-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();
  return store;
}

// ===========================================================================
// Tests: subagent-policy.mjs defaults
// ===========================================================================

test("pipeline-orch: DEFAULT_AGENT_PIPELINE includes all 7 required roles", () => {
  const expected = [
    "context_curator",
    "planner",
    "builder",
    "verifier",
    "reviewer",
    "integrator",
    "finalizer",
  ];
  assert.deepEqual([...DEFAULT_AGENT_PIPELINE], expected);
});

test("pipeline-orch: REPAIRER_ROLE is repairer (recovery branch)", () => {
  assert.equal(REPAIRER_ROLE, "repairer");
  assert.equal(isRecoveryBranchRole("repairer"), true);
  assert.equal(isRecoveryBranchRole("builder"), false);
});

test("pipeline-orch: LEGACY_ROLE_MAPPING maps old names to new", () => {
  assert.equal(LEGACY_ROLE_MAPPING.implementer, "builder");
  assert.equal(LEGACY_ROLE_MAPPING.tester, "verifier");
  assert.equal(LEGACY_ROLE_MAPPING.architect, "planner");
  assert.equal(LEGACY_ROLE_MAPPING.escalation_judge, "reviewer");
});

test("pipeline-orch: DEFAULT_AGENT_BACKEND_BY_ROLE maps builder/repairer to codex_exec", () => {
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.builder, "codex_exec");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.repairer, "codex_exec");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.context_curator, "null");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.verifier, "null");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.reviewer, "null");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.finalizer, "null");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.integrator, "null");
  assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE.planner, "null");
});

test("pipeline-orch: resolveDefaultBackendForRole returns correct defaults", () => {
  assert.equal(resolveDefaultBackendForRole("builder"), "codex_exec");
  assert.equal(resolveDefaultBackendForRole("verifier"), "null");
  assert.equal(resolveDefaultBackendForRole("repairer"), "codex_exec");
  // Legacy alias maps to canonical
  assert.equal(resolveDefaultBackendForRole("implementer"), "codex_exec");
  // Overrides work
  assert.equal(resolveDefaultBackendForRole("verifier", { verifier: "codex_exec" }), "codex_exec");
});

test("pipeline-orch: mapLegacyRole maps old names", () => {
  assert.equal(mapLegacyRole("implementer"), "builder");
  assert.equal(mapLegacyRole("tester"), "verifier");
  assert.equal(mapLegacyRole("architect"), "planner");
  assert.equal(mapLegacyRole("escalation_judge"), "reviewer");
  assert.equal(mapLegacyRole("builder"), "builder"); // canonical pass-through
  assert.equal(mapLegacyRole(""), "builder"); // empty fallback
});

// ===========================================================================
// Tests: pipeline-orchestration.mjs
// ===========================================================================

test("pipeline-orch: createDefaultAgentPipeline creates pipeline + agent runs", async () => {
  const { createDefaultAgentPipeline } = await import("../src/pipeline-orchestration.mjs");
  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const result = await createDefaultAgentPipeline(store, {
    goal_id: "g1",
    task_id: "t1",
  });

  assert.ok(result.pipeline, "should return pipeline");
  assert.equal(result.pipeline.goal_id, "g1");
  assert.equal(result.pipeline.task_id, "t1");
  assert.ok(Array.isArray(result.agent_runs), "should return agent_runs");
  assert.ok(result.agent_runs.length >= 7, "should create at least 7 agent runs");

  // Verify the runs are in the store
  const existing = await listAgentRuns(store, { task_id: "t1", limit: 100 });
  assert.ok(existing.agent_runs.length >= 7);

  // Check roles
  const roles = existing.agent_runs.map(r => r.role);
  ["context_curator", "planner", "builder", "verifier", "reviewer", "integrator", "finalizer"].forEach(role => {
    assert.ok(roles.includes(role), `should include ${role}`);
  });
});

test("pipeline-orch: ensurePipelineRunsForTask creates runs for missing roles", async () => {
  const { ensurePipelineRunsForTask } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  // Create one run first
  await createAgentRun(store, { goal_id: "g1", task_id: "t1", role: "builder", status: "queued" });

  // Ensure pipeline runs -- should skip builder and create the rest
  const result = await ensurePipelineRunsForTask(store, { task_id: "t1", goal_id: "g1" });
  assert.ok(result.created > 0, "should create new runs");
  assert.ok(result.skipped > 0, "should skip existing run");

  const existing = await listAgentRuns(store, { task_id: "t1", limit: 100 });
  assert.ok(existing.agent_runs.length >= 7);
});

test("pipeline-orch: evaluateTaskPipelineGates returns satisfied with no agent_runs (legacy)", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  const result = await evaluateTaskPipelineGates(store, { task_id: "t1", allowMissingGates: true });
  assert.equal(result.gates_satisfied, true, "legacy task gates should be satisfied");
  assert.equal(result.has_legacy_task, true);
  assert.equal(result.blocking_gates.length, 0);
});

test("pipeline-orch: evaluateTaskPipelineGates blocks on pending blocking roles", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  // Create runs for all roles but leave verifier pending
  for (const role of ["context_curator", "planner", "builder"]) {
    const run = await createAgentRun(store, { goal_id: "g1", task_id: "t1", role, status: "running" });
    await completeAgentRun(store, {
      agent_run_id: run.agent_run.id,
      status: "completed",
      output_artifacts: [{ kind: "context_bundle" }, { kind: "plan" }, { kind: "change_summary" }],
    });
  }

  // Verifier not completed
  await createAgentRun(store, { goal_id: "g1", task_id: "t1", role: "verifier", status: "running" });

  const result = await evaluateTaskPipelineGates(store, { task_id: "t1", allowMissingGates: false });
  assert.equal(result.gates_satisfied, false, "gates should not be satisfied");
  assert.ok(result.blocking_gates.includes("verifier"), "verifier should be blocking");
  assert.ok(result.blocking_reasons.some(r => r.includes("verifier")), "should give reason about verifier");
});

test("pipeline-orch: checkPipelineGateBlocking detects blocking", async () => {
  const { checkPipelineGateBlocking } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  // Create a run without completing it
  await createAgentRun(store, { goal_id: "g1", task_id: "t1", role: "builder", status: "running" });

  const result = await checkPipelineGateBlocking(store, { task_id: "t1", allowMissingGates: false });
  assert.ok(typeof result.blocked === "boolean", "should return blocked boolean");
});

test("pipeline-orch: applyPipelineGateBeforeClosure passes through for legacy tasks", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  const task = { id: "t1" };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, { allowMissingGates: true });
  assert.equal(result.taskStatus, "completed", "should keep completed for legacy task");
  assert.equal(result.gatesSatisfied, true);
});

test("pipeline-orch: applyPipelineGateBeforeClosure downgrades when gates block", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  // Create runs without completing them
  await createAgentRun(store, { goal_id: "g1", task_id: "t1", role: "verifier", status: "pending" });

  const task = { id: "t1" };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, { allowMissingGates: false });
  assert.equal(result.taskStatus, "waiting_for_review", "should downgrade to waiting_for_review");
  assert.equal(result.gatesSatisfied, false);
  assert.ok(result.taskResult.pipeline_gate_blocked, "should mark gate_blocked");
  assert.ok(Array.isArray(result.taskResult.acceptance_findings));
  assert.ok(result.taskResult.acceptance_findings.some(f => f.code === "pipeline_gate_blocking"));
});

// ===========================================================================
// Tests: Legacy compatibility
// ===========================================================================

test("pipeline-orch: isLegacyTask detects legacy tasks", () => {
  assert.equal(isLegacyTask({}), true, "empty task is legacy");
  assert.equal(isLegacyTask({ legacy: true }), true, "explicit legacy");
  assert.equal(isLegacyTask({ agent_pipeline: false }), true, "pipeline disabled");
  assert.equal(isLegacyTask({ skip_pipeline: true }), true, "skip pipeline");
  assert.equal(isLegacyTask({ pipeline_id: "p1" }), false, "has pipeline_id");
  assert.equal(isLegacyTask({ agent_runs: ["r1"] }), false, "has agent_runs");
});

test("pipeline-orch: getEffectivePipelineRoles returns default for legacy tasks", () => {
  const result = getEffectivePipelineRoles({});
  assert.deepEqual(result, [...DEFAULT_AGENT_PIPELINE]);
});

test("pipeline-orch: getEffectivePipelineRoles maps legacy roles", () => {
  const result = getEffectivePipelineRoles({ roles: ["implementer", "tester"] });
  assert.deepEqual(result, ["builder", "verifier"]);
});

test("pipeline-orch: resolveRoleBackend resolves correct backend", () => {
  assert.equal(resolveRoleBackend({}, {}, "builder"), "codex_exec");
  assert.equal(resolveRoleBackend({}, {}, "verifier"), "null");
  assert.equal(resolveRoleBackend({ role: "implementer" }, {}), "codex_exec");

  // Task-level override
  const taskWithOverride = { agent_backend_by_role: { builder: "local_command" } };
  assert.equal(resolveRoleBackend(taskWithOverride, {}, "builder"), "local_command");
});

// ===========================================================================
// Tests: Diagnostics
// ===========================================================================

test("pipeline-orch: getPipelineDiagnostics returns correct shape", async () => {
  const { getPipelineDiagnostics } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  // No task filter
  const result = await getPipelineDiagnostics(store, {});
  assert.ok(result.pipeline_enabled === true);
  assert.ok(Array.isArray(result.default_pipeline), "default_pipeline is array");
  assert.ok(result.default_pipeline.length >= 7, "default_pipeline has 7+ roles");
  assert.ok(result.backends, "backends object present");
  assert.ok(typeof result.agent_runs_count === "number");

  // With task_id
  const taskResult = await getPipelineDiagnostics(store, { task_id: "nonexistent" });
  assert.ok(taskResult.gate_status, "gate_status present for task_id");
  assert.ok(Array.isArray(taskResult.recent_agent_runs));
});
