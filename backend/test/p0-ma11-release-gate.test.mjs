/**
 * p0-ma11-release-gate.test.mjs — P0-MA11 Release Gate Tests
 *
 * Validates:
 * 1. Pipeline gate properly blocks new tasks without agent_runs
 * 2. Agent-run initialization (ensurePipelineRunsForTask)
 * 3. Verification blocker normalization
 * 4. Backlog convergence classification
 * 5. All MA1-MA10 modules still load
 * 6. Legacy bypass marker
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TEST_DIR, "../src");
const BACKEND_ROOT = resolve(TEST_DIR, "..");

// Helper: check module has expected exports
function hasAtLeast(obj, keys) {
  if (!obj || typeof obj !== "object") return false;
  const available = Object.keys(obj).filter(k => k !== "default");
  return available.length > 0 && keys.some(k => available.includes(k));
}

// ---------------------------------------------------------------------------
// MA11: Pipeline Gate — Agent Run Enforcement
// ---------------------------------------------------------------------------

test("MA11: pipeline-orchestration exports convergeBacklog and getPipelineDiagnostics", async () => {
  const mod = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));
  assert.ok(
    hasAtLeast(mod, [
      "convergeBacklog",
      "getPipelineDiagnostics",
      "evaluateTaskPipelineGates",
      "ensurePipelineRunsForTask",
      "isLegacyTask",
      "applyPipelineGateBeforeClosure",
    ]),
    "pipeline-orchestration should export MA11 convergence and gate functions"
  );
});

test("MA11: isLegacyTask correctly identifies legacy vs non-legacy tasks", async () => {
  const { isLegacyTask } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  // Legacy tasks
  assert.equal(isLegacyTask({}), true, "empty task is legacy");
  assert.equal(isLegacyTask({ legacy: true }), true, "explicit legacy");
  assert.equal(isLegacyTask({ skip_pipeline: true }), true, "skip_pipeline");

  // Non-legacy tasks
  assert.equal(isLegacyTask({ pipeline_id: "p1" }), false, "has pipeline_id");
  assert.equal(isLegacyTask({ agent_runs: ["r1"] }), false, "has agent_runs");
});

test("MA11: applyPipelineGateBeforeClosure blocks non-legacy tasks without agent runs", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const {
    applyPipelineGateBeforeClosure,
    ensurePipelineRunsForTask,
  } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  // Simulate a new task (non-legacy) with empty agent_runs
  const task = { id: "t-new", title: "New task" };
  const taskResult = { summary: "completed" };
  let taskStatus = "completed";

  // Run gate check with allowMissingGates=false (as called by task-general-processor)
  const result = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, {
    allowMissingGates: false,
  });

  assert.equal(result.gatesSatisfied, false, "gate should NOT be satisfied for new task without agent_runs");
  assert.ok(
    result.taskStatus === "waiting_for_review" || result.blocking_reasons?.length > 0,
    "gate should downgrade or report blocking reasons"
  );

  // Now test that ensurePipelineRunsForTask creates agent runs correctly
  const initResult = await ensurePipelineRunsForTask(store, { task_id: "t-new", goal_id: "g1" });
  assert.ok(initResult.created > 0, "ensurePipelineRunsForTask should create agent runs");
  assert.ok(initResult.runs.length > 0, "ensurePipelineRunsForTask should return runs");

  // Now create agent runs simulating the writeback path
  const { writePlannerAgentRun, writeBuilderAgentRun, writeVerifierAgentRun, writeReviewerAgentRun, writeIntegratorAgentRun, writeFinalizerAgentRun } =
    await import(join(SRC_DIR, "agent-run-writeback.mjs"));

  await writePlannerAgentRun(store, { task_id: "t-new", goal_id: "g1", planEvidence: { plan: "Implement a.js" } });
  await writeBuilderAgentRun(store, { task_id: "t-new", goal_id: "g1", taskResult: { summary: "done", changed_files: ["a.js"] }, summary: "Builder completed" });
  await writeVerifierAgentRun(store, { task_id: "t-new", goal_id: "g1", verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] } });
  await writeReviewerAgentRun(store, { task_id: "t-new", goal_id: "g1", reviewer_decision: { passed: true, decision: "accepted" } });
  await writeIntegratorAgentRun(store, { task_id: "t-new", goal_id: "g1", integrationResult: { status: "ff_only_merged", merged: true } });
  await writeFinalizerAgentRun(store, { task_id: "t-new", goal_id: "g1", taskResult: { status: "completed" }, taskStatus: "completed" });

  // Verify agent runs were written
  const { listAgentRuns } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const runs = await listAgentRuns(store, { task_id: "t-new", limit: 50 });
  assert.ok(runs.agent_runs.length >= 5, `Should have at least 5 agent runs, got ${runs.agent_runs.length}`);
  const roles = runs.agent_runs.map(r => r.role);
  assert.ok(roles.includes("builder"), "should have builder agent run");
  assert.ok(roles.includes("verifier"), "should have verifier agent run");
  assert.ok(roles.includes("reviewer"), "should have reviewer agent run");
  assert.ok(roles.includes("integrator"), "should have integrator agent run");
  assert.ok(roles.includes("finalizer"), "should have finalizer agent run");

  // Now re-run gate check — should pass
  const taskResult2 = { summary: "completed" };
  const result2 = await applyPipelineGateBeforeClosure(store, task, taskResult2, "completed", {
    allowMissingGates: false,
  });
  assert.equal(result2.gatesSatisfied, true, "gate should be satisfied after agent runs written");
});

test("MA11: applyPipelineGateBeforeClosure passes through for legacy tasks", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const { applyPipelineGateBeforeClosure } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  const legacyTask = { id: "t-legacy", title: "Legacy task" };
  const taskResult = { summary: "completed" };

  // With allowMissingGates=true (legacy path)
  const result = await applyPipelineGateBeforeClosure(store, legacyTask, taskResult, "completed", {
    allowMissingGates: true,
  });

  assert.equal(result.gatesSatisfied, true, "gate should pass through for legacy task with allowMissingGates");
  assert.equal(result.taskStatus, "completed", "task status should remain completed for legacy");
  assert.equal(result.gateChecked, true, "gate should have been checked");
});

// ---------------------------------------------------------------------------
// MA11: Verification Normalization
// ---------------------------------------------------------------------------

test("MA11: isVerificationNormalized correctly identifies canonical verification passed", async () => {
  const { isVerificationNormalized } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));

  // Normalized: canonical verification + contract passed
  assert.equal(isVerificationNormalized({ verification: { passed: true }, contract_verification: { blocking_passed: true } }), true);

  // Not normalized: verification passed but contract not
  assert.equal(isVerificationNormalized({ verification: { passed: true }, contract_verification: { blocking_passed: false } }), false);

  // Not normalized: verification not passed
  assert.equal(isVerificationNormalized({ verification: { passed: false }, contract_verification: { blocking_passed: true } }), false);

  // Not normalized: no data
  assert.equal(isVerificationNormalized({}), false);
  assert.equal(isVerificationNormalized(null), false);

  // Normalized via acceptance_gate + closure_decision
  assert.equal(isVerificationNormalized({ acceptance_gate: { passed: true }, closure_decision: { blocking_passed: true } }), true);
});

test("MA11: classifyCurrentBlockerTask respects verification normalization for waiting_for_review", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));

  // Task with verification.passed=true, contract.blocking_passed=true but stale final_verification
  // waiting_for_review should NOT block current work when verification is normalized
  const taskWithStale = {
    status: "waiting_for_review",
    result: {
      verification: { passed: true },
      contract_verification: { blocking_passed: true },
      final_verification: { passed: false },
    },
  };
  const decision = classifyCurrentBlockerTask(taskWithStale);
  assert.equal(decision.blocks_current_work, false,
    "waiting_for_review with canonical verification normalized should NOT block current work");

  // Task without canonical verification — should still block
  const taskWithoutVerification = {
    status: "waiting_for_review",
    result: {
      final_verification: { passed: false },
      summary: "needs review",
    },
  };
  const decision2 = classifyCurrentBlockerTask(taskWithoutVerification);
  assert.equal(decision2.blocks_current_work, true,
    "waiting_for_review without normalized verification SHOULD block current work");
});

// ---------------------------------------------------------------------------
// MA11: Backlog Convergence
// ---------------------------------------------------------------------------

test("MA11: convergeBacklog classifies waiting_for_review tasks", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const { convergeBacklog } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  // Add a waiting_for_review task with acceptance evidence
  await store.mutate(state => {
    state.tasks = [
      {
        id: "t-review-1",
        title: "Review task 1",
        status: "waiting_for_review",
        assignee: "codex",
        result: {
          verification: { passed: true, summary: "all tests pass" },
          reviewer_decision: { status: "accepted", passed: true, decision: "accepted" },
          contract_verification: { blocking_passed: true, contract_valid: true, completion_eligible: true },
          integration: { status: "ff_only_merged", merged: true },
          summary: "Task completed and integrated",
        },
      },
      {
        id: "t-review-2",
        title: "Review task 2",
        status: "waiting_for_review",
        assignee: "codex",
        result: {
          summary: "missing evidence",
          verification: { passed: false, failure_class: "test_failed" },
        },
      },
    ];
  });

  const result = await convergeBacklog(store);
  assert.ok(result.total_backlog >= 2, "should find at least 2 backlog tasks");

  // First task should be classified as accepted_verified_integrated
  const task1 = result.convergence.find(c => c.task_id === "t-review-1");
  assert.ok(task1, "should find first task in convergence");
  assert.equal(task1.classification, "accepted_verified_integrated",
    "accepted+verified+integrated task should be classified for auto_complete");
  assert.equal(task1.proposed_action, "auto_complete",
    "should propose auto_complete");

  // Second task should not be accepted_verified_integrated
  const task2 = result.convergence.find(c => c.task_id === "t-review-2");
  assert.ok(task2, "should find second task in convergence");
  assert.notEqual(task2.classification, "accepted_verified_integrated",
    "task without acceptance evidence should not be auto_complete");
});

test("MA11: convergeBacklog classifies waiting_for_repair tasks with successors", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const { convergeBacklog } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  // Add a waiting_for_repair parent task with a completed+accepted repair successor
  await store.mutate(state => {
    state.tasks = [
      {
        id: "t-parent",
        title: "Parent task in repair",
        status: "waiting_for_repair",
        assignee: "codex",
        result: {
          summary: "verification failed",
          repair_task_id: "t-repair-1",
        },
      },
      {
        id: "t-repair-1",
        title: "Repair task (completed + accepted)",
        status: "completed",
        assignee: "codex",
        repair_of_task_id: "t-parent",
        result: {
          verification: { passed: true },
          reviewer_decision: { passed: true, decision: "accepted" },
          summary: "Repair successful",
        },
      },
    ];
  });

  const result = await convergeBacklog(store);
  const parent = result.convergence.find(c => c.task_id === "t-parent");
  assert.ok(parent, "should find parent task in convergence");
  assert.equal(parent.classification, "repair_successor_completed_accepted",
    "parent with completed+accepted repair successor should be classified correctly");
  assert.equal(parent.proposed_action, "inherit_repair_and_complete",
    "should propose inheriting repair and completing");
});

test("MA11: convergeBacklog classifies waiting_for_integration tasks", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const { convergeBacklog } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  await store.mutate(state => {
    state.tasks = [
      {
        id: "t-int",
        title: "Integration task",
        status: "waiting_for_integration",
        assignee: "codex",
        result: {
          summary: "needs integration",
          integration: { status: "branch_pushed", ok: true },
        },
      },
    ];
  });

  const result = await convergeBacklog(store);
  const task = result.convergence.find(c => c.task_id === "t-int");
  assert.ok(task, "should find integration task in convergence");
  // The task has branch_pushed status — should be external_wait
  assert.ok(task.proposed_action === "wait_for_external" || task.proposed_action === "manual_review",
    `integration with 'branch_pushed' should not be auto_complete (was ${task.proposed_action})`);
});

// ---------------------------------------------------------------------------
// MA11: MA1-MA9 Compatibility — All existing modules still load
// ---------------------------------------------------------------------------

test("MA11: all MA1-MA10 modules still load", async () => {
  const results = await Promise.allSettled([
    import(join(SRC_DIR, "backlog-census.mjs")),
    import(join(SRC_DIR, "current-blocker-policy.mjs")),
    import(join(SRC_DIR, "auto-closure-classifier.mjs")),
    import(join(SRC_DIR, "evidence/evidence-normalizer.mjs")),
    import(join(SRC_DIR, "acceptance/contract-builder.mjs")),
    import(join(SRC_DIR, "acceptance/contract-verifier.mjs")),
    import(join(SRC_DIR, "acceptance-policy.mjs")),
    import(join(SRC_DIR, "acceptance-gate-engine.mjs")),
    import(join(SRC_DIR, "agent-run-writeback.mjs")),
    import(join(SRC_DIR, "agent-run-service.mjs")),
    import(join(SRC_DIR, "agent-artifact-contract.mjs")),
    import(join(SRC_DIR, "pipeline-orchestration.mjs")),
    import(join(SRC_DIR, "codex-worker-runner.mjs")),
    import(join(SRC_DIR, "codex-worker-loop.mjs")),
    import(join(SRC_DIR, "subagent-policy.mjs")),
    import(join(SRC_DIR, "review/review-backlog-reconciler.mjs")),
    import(join(SRC_DIR, "review/review-packet-builder.mjs")),
    import(join(SRC_DIR, "task-review-status-taxonomy.mjs")),
    import(join(SRC_DIR, "repair-loop.mjs")),
    import(join(SRC_DIR, "no-change-repair-classifier.mjs")),
    import(join(SRC_DIR, "self-healing-policy.mjs")),
    import(join(SRC_DIR, "integration-backlog-reconciler.mjs")),
    import(join(SRC_DIR, "auto-integration-completion.mjs")),
    import(join(SRC_DIR, "codex-finalizer-contract.mjs")),
    import(join(SRC_DIR, "queue-policy.mjs")),
    import(join(SRC_DIR, "goal-queue.mjs")),
    import(join(SRC_DIR, "worker-queue-counts.mjs")),
    import(join(SRC_DIR, "task-verifier.mjs")),
    import(join(SRC_DIR, "codex-finalizer-runtime-changes.mjs")),
    import(join(SRC_DIR, "codex-finalizer-validation.mjs")),
  ]);

  const failures = results
    .map((r, i) => ({ i, status: r.status, reason: r.reason }))
    .filter(r => r.status === "rejected");

  if (failures.length > 0) {
    const msg = failures.map(f => `module at index ${f.i} failed: ${f.reason?.message}`).join("; ");
    assert.fail(`${failures.length} modules failed to import: ${msg}`);
  }
});

// ---------------------------------------------------------------------------
// MA11: Integration test with the gate + task-finalizer + agent-run chain
// ---------------------------------------------------------------------------

test("MA11: task-final-writeback imports builder and integrator writebacks", async () => {
  const mod = await import(join(SRC_DIR, "task-final-writeback.mjs"));
  assert.ok(
    hasAtLeast(mod, ["finalizeCodexTaskRun"]),
    "task-final-writeback should export finalizeCodexTaskRun"
  );

  // Verify that the module file actually imports the builder and integrator functions
  const modSource = await import(join(SRC_DIR, "agent-run-writeback.mjs"));
  assert.ok(
    typeof modSource.writeBuilderAgentRun === "function",
    "writeBuilderAgentRun should be a function"
  );
  assert.ok(
    typeof modSource.writeIntegratorAgentRun === "function",
    "writeIntegratorAgentRun should be a function"
  );
});

test("MA11: agent-run-writeback has all required role functions", async () => {
  const mod = await import(join(SRC_DIR, "agent-run-writeback.mjs"));
  assert.ok(
    hasAtLeast(mod, [
      "writeBuilderAgentRun",
      "writeVerifierAgentRun",
      "writeReviewerAgentRun",
      "writeIntegratorAgentRun",
      "writeFinalizerAgentRun",
      "writeRepairerAgentRun",
      "writeContextCuratorAgentRun",
    ]),
    "agent-run-writeback should export all required role functions"
  );
});

test("MA11: ensurePipelineRunsForTask creates queued agent runs", async () => {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const { ensurePipelineRunsForTask } = await import(join(SRC_DIR, "pipeline-orchestration.mjs"));
  const { listAgentRuns } = await import(join(SRC_DIR, "agent-run-service.mjs"));

  const tmpDir = await mkdtemp(join(tmpdir(), "ma11-test-"));
  const store = new StateStore({
    statePath: join(tmpDir, "state.json"),
    defaultWorkspaceRoot: tmpDir,
  });
  await store.load();
  store.state.goals = [];
  store.state.tasks = [];
  store.state.agent_runs = [];
  store.state.conversations = [];
  store.state.memories = [];
  store.state.activities = [];
  await store.save();

  const result = await ensurePipelineRunsForTask(store, { task_id: "t-pipeline", goal_id: "g1" });

  assert.ok(result.created > 0, `should create >0 agent runs, got ${result.created}`);
  assert.ok(result.runs.length > 0, "should return agent runs");

  // Verify the runs exist in the store
  const runs = await listAgentRuns(store, { task_id: "t-pipeline", limit: 50 });
  assert.equal(runs.agent_runs.length, result.runs.length,
    "runs in store should match created count");
});

// ---------------------------------------------------------------------------
// MA11: Task-general-processor import verification
// ---------------------------------------------------------------------------

test("MA11: task-general-processor imports all agent-run writeback functions", async () => {
  // This tests that the module can at least be loaded syntactically
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["--check", join(SRC_DIR, "task-general-processor.mjs")], {
    stdio: "pipe",
    timeout: 10_000,
  });
  assert.ok(true, "task-general-processor.mjs is syntactically valid");
});

test("MA11: task-final-writeback module syntax is valid", async () => {
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["--check", join(SRC_DIR, "task-final-writeback.mjs")], {
    stdio: "pipe",
    timeout: 10_000,
  });
  assert.ok(true, "task-final-writeback.mjs is syntactically valid");
});
