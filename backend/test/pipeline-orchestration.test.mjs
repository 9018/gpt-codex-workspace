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
  shouldEnforcePipelineGates,
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


// ===========================================================================
// Tests: P0-MA12-G1 Finalizer result artifact gate
// ===========================================================================

test("pipeline-orch: finalizer completed with result artifact satisfies gate", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_finalizer_result_${Date.now()}`;

  // Create all gate agent runs so gates_satisfied can be true
  // Create a finalizer agent run with result artifact
  const created = await createAgentRun(store, { task_id: taskId, goal_id: "g1", role: "finalizer", status: "queued" });
  await completeAgentRun(store, {
    agent_run_id: created.agent_run.id,
    status: "completed",
    output_artifacts: [{ kind: "result", path: null, status: "completed" }],
  });

  // Create other gate roles so the pipeline is complete
  const gateRoles = ["planner", "builder", "verifier", "reviewer", "integrator"];
  const roleArtifact = {
    planner: { kind: "plan", path: null },
    builder: { kind: "change_summary", path: null, changed_count: 1 },
    verifier: { kind: "verification", path: null, passed: true },
    reviewer: { kind: "reviewer_decision", path: null, passed: true },
    integrator: { kind: "integration", path: null, status: "merged", merged: true },
  };
  for (const role of gateRoles) {
    const r = await createAgentRun(store, { task_id: taskId, goal_id: "g1", role, status: "queued" });
    await completeAgentRun(store, {
      agent_run_id: r.agent_run.id,
      status: "completed",
      output_artifacts: [roleArtifact[role]],
    });
  }

  const result = await evaluateTaskPipelineGates(store, { task_id: taskId });
  assert.equal(result.gates_satisfied, true, "All gates should be satisfied when finalizer has result artifact");

  const finalizerGate = (result.gates || []).find(g => g.contract_role === "finalizer");
  assert.ok(finalizerGate, "finalizer gate should exist");
  assert.equal(finalizerGate.satisfied, true, "finalizer gate should be satisfied");
  assert.ok(Array.isArray(finalizerGate.missing_artifacts));
  assert.equal(finalizerGate.missing_artifacts.length, 0, "no missing artifacts when result artifact is present");
});

test("pipeline-orch: finalizer completed without result artifact blocks gate", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_finalizer_no_result_${Date.now()}`;
  // Create a finalizer agent run
  const created = await createAgentRun(store, { task_id: taskId, goal_id: "g1", role: "finalizer", status: "queued" });
  // Complete it WITHOUT result artifact (just change_summary kind, not 'result')
  await completeAgentRun(store, {
    agent_run_id: created.agent_run.id,
    status: "completed",
    output_artifacts: [{ kind: "change_summary", path: null }],
  });

  const result = await evaluateTaskPipelineGates(store, { task_id: taskId });
  const finalizerGate = (result.gates || []).find(g => g.contract_role === "finalizer");
  assert.ok(finalizerGate, "finalizer gate should exist");
  assert.equal(finalizerGate.satisfied, false, "finalizer gate should NOT be satisfied without result artifact");
  assert.ok(finalizerGate.missing_artifacts.includes("result"),
    "result should be in missing_artifacts");
});

test("pipeline-orch: stale finalizer-result pipeline_gate_blocking finding is cleared after artifact writeback", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_stale_clear_${Date.now()}`;
  const task = { id: taskId, status: "completed" };

  // Create a taskResult with stale pipeline_gate_blocking findings for finalizer
  const taskResult = {
    acceptance_findings: [
      {
        severity: "blocker",
        code: "pipeline_gate_blocking",
        message: "finalizer: missing required artifacts (result)",
        source: "pipeline_orchestration",
      },
      {
        severity: "blocker",
        code: "pipeline_gate_blocking",
        message: "verifier: gate not satisfied (status=completed)",
        source: "pipeline_orchestration",
      },
    ],
  };

  // Create a completed finalizer agent run WITH result artifact
  const created = await createAgentRun(store, { task_id: taskId, goal_id: "g1", role: "finalizer", status: "queued" });
  await completeAgentRun(store, {
    agent_run_id: created.agent_run.id,
    status: "completed",
    output_artifacts: [{ kind: "result", path: null, status: "completed" }],
  });

  // Also create other agent runs so the pipeline is not empty
  for (const role of ["builder", "verifier", "reviewer", "integrator"]) {
    const r = await createAgentRun(store, { task_id: taskId, goal_id: "g1", role, status: "queued" });
    const resultArtifact = role === "verifier" ? { kind: "verification", path: null, passed: true }
      : role === "reviewer" ? { kind: "reviewer_decision", path: null, passed: true }
      : role === "builder" ? { kind: "change_summary", path: null, changed_count: 1 }
      : { kind: "integration", path: null, status: "merged", merged: true };
    await completeAgentRun(store, { agent_run_id: r.agent_run.id, status: "completed", output_artifacts: [resultArtifact] });
  }

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, "completed", { allowMissingGates: false });

  // The stale finalizer finding should be cleared
  const remainingFinalizerFindings = (result.taskResult.acceptance_findings || []).filter(
    f => f && f.code === "pipeline_gate_blocking" && f.message && f.message.startsWith("finalizer:")
  );
  assert.equal(remainingFinalizerFindings.length, 0,
    "stale finalizer-result findings should be cleared when finalizer now has result artifact");
});

test("pipeline-orch: finalizer gate is satisfied when finalizer is skipped", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_finalizer_skipped_${Date.now()}`;
  // Create finalizer agent run that is skipped
  const created = await createAgentRun(store, {
    task_id: taskId, goal_id: "g1", role: "finalizer", status: "queued"
  });
  await completeAgentRun(store, {
    agent_run_id: created.agent_run.id,
    status: "skipped",
    output_artifacts: [],
  });

  const result = await evaluateTaskPipelineGates(store, { task_id: taskId });
  const finalizerGate = (result.gates || []).find(g => g.contract_role === "finalizer");
  assert.ok(finalizerGate, "finalizer gate should exist");
  assert.equal(finalizerGate.satisfied, true, "finalizer gate should be satisfied when skipped");
});

test("pipeline-orch: writeFinalizerAgentRun before gate check means gate sees result artifact", async () => {
  // This test validates the core fix: when writeFinalizerAgentRun is called
  // before evaluateTaskPipelineGates, the finalizer gate sees the result artifact.
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const { writeFinalizerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_order_test_${Date.now()}`;

  // Write finalizer agent run (simulating the new order: writeback before gate check)
  await writeFinalizerAgentRun(store, {
    task_id: taskId,
    goal_id: "g1",
    taskResult: { summary: "Task completed", status: "completed" },
    taskStatus: "completed",
  });

  // Verify the finalizer run has the result artifact
  const runs = await listAgentRuns(store, { task_id: taskId, limit: 10 });
  const finalizerRun = runs.agent_runs.find(r => r.role === "finalizer");
  assert.ok(finalizerRun, "finalizer run should exist after writeFinalizerAgentRun");
  assert.equal(finalizerRun.status, "completed", "finalizer should be completed");
  const hasResultArtifact = (finalizerRun.output_artifacts || []).some(
    a => a && (a.kind === "result" || (typeof a === "object" && a.kind === "result"))
  );
  assert.equal(hasResultArtifact, true, "finalizer output_artifacts should include kind=result");

  // Now evaluate gates - the finalizer gate should be satisfied
  const gateResult = await evaluateTaskPipelineGates(store, { task_id: taskId });
  const finalizerGate = (gateResult.gates || []).find(g => g.contract_role === "finalizer");
  assert.ok(finalizerGate, "finalizer gate should be present");
  assert.equal(finalizerGate.satisfied, true,
    "finalizer gate should be satisfied after writeFinalizerAgentRun");
  assert.equal(finalizerGate.missing_artifacts.length, 0,
    "no missing artifacts when finalizer has result artifact");
});

// ===========================================================================
// Tests: P0-04 Pipeline Gate Hardening
// ===========================================================================

test("P0-04: isLegacyTask with require_pipeline_gates=true returns false", () => {
  assert.equal(isLegacyTask({ require_pipeline_gates: true }), false,
    "task with require_pipeline_gates=true should NOT be legacy");
  assert.equal(isLegacyTask({ require_pipeline_gates: true, legacy: true }), false,
    "require_pipeline_gates=true takes precedence over explicit legacy=true");
  assert.equal(isLegacyTask({ require_pipeline_gates: true, skip_pipeline: true }), false,
    "require_pipeline_gates=true takes precedence over skip_pipeline=true");
  // Legacy markers still work for tasks without require_pipeline_gates
  assert.equal(isLegacyTask({}), true, "empty task is still legacy");
  assert.equal(isLegacyTask({ legacy: true }), true, "explicit legacy");
  assert.equal(isLegacyTask({ pipeline: false }), true, "pipeline disabled");
  assert.equal(isLegacyTask({ skip_pipeline: true }), true, "skip pipeline");
  assert.equal(isLegacyTask({ pipeline_id: "p1" }), false, "has pipeline_id");
});

test("P0-04: shouldEnforcePipelineGates returns correct values", () => {
  // New builder tasks should enforce gates
  assert.equal(shouldEnforcePipelineGates({ require_pipeline_gates: true }), true,
    "require_pipeline_gates=true should enforce gates");
  // Legacy tasks should not enforce gates
  assert.equal(shouldEnforcePipelineGates({ legacy: true }), false,
    "explicit legacy should not enforce gates");
  assert.equal(shouldEnforcePipelineGates({ skip_pipeline: true }), false,
    "skip_pipeline should not enforce gates");
  assert.equal(shouldEnforcePipelineGates({ pipeline: false }), false,
    "pipeline=false should not enforce gates");
  // Has pipeline metadata but no explicit require_pipeline_gates
  assert.equal(shouldEnforcePipelineGates({ pipeline_id: "p1" }), true,
    "has pipeline_id should enforce gates");
  // Empty task defaults to legacy = not enforced
  assert.equal(shouldEnforcePipelineGates({}), false,
    "empty task defaults to not enforcing gates");
});

test("P0-04: buildGoalTask adds require_pipeline_gates for builder mode", async () => {
  const { buildGoalTask } = await import("../src/goal-task-task-factory.mjs");
  const now = new Date().toISOString();

  const builderTask = buildGoalTask({
    id: "g_builder_p0_04",
    project_id: "default",
    workspace_id: "hosted-default",
    title: "Builder task",
    mode: "builder",
    user_request: "Do work",
    goal_prompt: "Do work",
    created_at: now,
  }, { id: "conv_builder_p0_04" }, "system");

  assert.equal(builderTask.require_pipeline_gates, true,
    "builder mode task should have require_pipeline_gates=true");

  const readonlyTask = buildGoalTask({
    id: "g_readonly_p0_04",
    project_id: "default",
    workspace_id: "hosted-default",
    title: "Readonly task",
    mode: "readonly",
    user_request: "Read only",
    goal_prompt: "Read only",
    created_at: now,
  }, { id: "conv_readonly_p0_04" }, "system");

  assert.equal(readonlyTask.require_pipeline_gates, false,
    "readonly mode task should have require_pipeline_gates=false");
});

test("P0-04: new task with no agent_runs and allowMissingGates=false blocks closure", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  // Test with a new task (require_pipeline_gates=true) that has no agent runs
  const result = await evaluateTaskPipelineGates(store, {
    task_id: "t_new_strict",
    allowMissingGates: false,
  });

  assert.equal(result.gates_satisfied, false,
    "new task with no agent runs and strict mode should have gates NOT satisfied");
  assert.ok(result.blocking_gates.includes("no_agent_runs"),
    "blocking_gates should include 'no_agent_runs'");
  assert.ok(result.blocking_reasons.some(r => r.includes("No agent runs found")),
    "should explain that no agent runs were found");
  assert.equal(result.has_legacy_task, true,
    "should still report has_legacy_task since no agent_runs found");
});

test("P0-04: legacy task (empty) passes through gate check with allowMissingGates=true", async () => {
  const { evaluateTaskPipelineGates } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  const result = await evaluateTaskPipelineGates(store, {
    task_id: "t_legacy",
    allowMissingGates: true,
  });

  assert.equal(result.gates_satisfied, true,
    "legacy task with allowMissingGates=true should have gates satisfied");
  assert.equal(result.blocking_gates.length, 0,
    "no blocking gates for legacy task");
  assert.equal(result.has_legacy_task, true,
    "should report legacy task");
});

test("P0-04: applyPipelineGateBeforeClosure blocks new task missing required artifacts", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_block_missing_artifact_${Date.now()}`;
  const task = { id: taskId, require_pipeline_gates: true };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  // Create a builder agent run WITHOUT the required change_summary artifact
  const builderRun = await createAgentRun(store, {
    task_id: taskId, goal_id: "g1", role: "builder", status: "queued",
  });
  await completeAgentRun(store, {
    agent_run_id: builderRun.agent_run.id,
    status: "completed",
    output_artifacts: [{ kind: "unrelated", path: null }],  // missing change_summary!
  });

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, {
    allowMissingGates: false,
  });

  assert.equal(result.gatesSatisfied, false,
    "should not be satisfied when builder is missing change_summary artifact");
  assert.equal(result.taskStatus, "waiting_for_review",
    "should downgrade to waiting_for_review for gate blocking");
  assert.ok(result.taskResult.pipeline_gate_blocked,
    "should mark pipeline_gate_blocked");

  // Verify the acceptance finding message includes artifact details
  const gateFindings = (result.taskResult.acceptance_findings || []).filter(
    f => f.code === "pipeline_gate_blocking"
  );
  assert.ok(gateFindings.length > 0,
    "should include pipeline_gate_blocking findings");
});

test("P0-04: applyPipelineGateBeforeClosure passes through for legacy task with allowMissingGates=true", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const store = await makeStore();

  const task = { id: "t_legacy_gate" };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, {
    allowMissingGates: true,
  });

  assert.equal(result.taskStatus, "completed",
    "legacy task with allowMissingGates=true should keep completed");
  assert.equal(result.gatesSatisfied, true,
    "gates should be satisfied for legacy task");
});

test("P0-04: applyPipelineGateBeforeClosure does NOT block for legacy task with missing artifacts", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_legacy_miss_${Date.now()}`;
  const task = { id: taskId, legacy: true };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  // Create an agent run (but without required artifacts)
  await createAgentRun(store, {
    task_id: taskId, goal_id: "g1", role: "builder", status: "queued",
  });

  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, {
    allowMissingGates: true,
  });

  // Legacy task with allowMissingGates=true should pass through
  assert.equal(result.taskStatus, "completed",
    "legacy task should pass through even with agent runs missing artifacts");
  assert.equal(result.gatesSatisfied, true,
    "gates satisfied for legacy task with allowMissingGates=true");
  assert.equal(result.gateChecked, true,
    "gate should be checked");
});

test("P0-04: review packet includes pipeline_gate info when blocked", async () => {
  const { applyPipelineGateBeforeClosure } = await import("../src/pipeline-orchestration.mjs");
  const { createAgentRun, completeAgentRun } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  const taskId = `t_review_gate_${Date.now()}`;
  const task = { id: taskId, require_pipeline_gates: true };
  const taskResult = { summary: "test", acceptance_findings: [] };
  const taskStatus = "completed";

  // Create a verifier agent run WITHOUT the required verification artifact
  const verifierRun = await createAgentRun(store, {
    task_id: taskId, goal_id: "g1", role: "verifier", status: "queued",
  });
  await completeAgentRun(store, {
    agent_run_id: verifierRun.agent_run.id,
    status: "completed",
    output_artifacts: [{ kind: "unrelated", path: null }],  // missing verification!
  });

  // Apply gate check
  const gateResult = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, {
    allowMissingGates: false,
  });

  assert.equal(gateResult.gatesSatisfied, false,
    "gate should be unsatisfied");

  // Simulate the task having the gate result for review packet
  const reviewTaskResult = {
    ...taskResult,
    ...gateResult.taskResult,
  };

  // Verify pipeline_gate_blocked is set
  assert.equal(reviewTaskResult.pipeline_gate_blocked, true,
    "pipeline_gate_blocked should be set");
  assert.ok(Array.isArray(reviewTaskResult.pipeline_gate_reasons),
    "pipeline_gate_reasons should be an array");
  assert.ok(reviewTaskResult.pipeline_gate_reasons.length > 0,
    "should have at least one gate reason");
});
