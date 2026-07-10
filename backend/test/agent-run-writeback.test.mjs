import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "agent-run-writeback-test-"));
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
// Tests: writeIdempotentAgentRun
// ===========================================================================

test("agent-run-writeback: writeIdempotentAgentRun creates a new agent run", async () => {
  const { writeIdempotentAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeIdempotentAgentRun(store, {
    task_id: "t1", goal_id: "g1", role: "builder", status: "completed",
    output_artifacts: [{ kind: "change_summary" }],
    summary: "Build completed",
  });

  assert.equal(result.created, true, "should create a new agent run");
  assert.ok(result.agent_run, "should return agent_run");
  assert.equal(result.agent_run.role, "builder");
  assert.equal(result.agent_run.status, "completed");
  assert.equal(result.agent_run.task_id, "t1");
  assert.equal(result.agent_run.goal_id, "g1");
  assert.ok(Array.isArray(result.agent_run.output_artifacts));
  assert.equal(result.agent_run.output_artifacts.length, 1);
});

test("agent-run-writeback: writeIdempotentAgentRun skips duplicate (task_id+role)", async () => {
  const { writeIdempotentAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const first = await writeIdempotentAgentRun(store, {
    task_id: "t1", goal_id: "g1", role: "builder", status: "completed",
    output_artifacts: [{ kind: "change_summary" }],
    summary: "Build completed",
  });
  assert.equal(first.created, true, "first call should create");

  const second = await writeIdempotentAgentRun(store, {
    task_id: "t1", goal_id: "g1", role: "builder", status: "completed",
    output_artifacts: [{ kind: "change_summary" }],
    summary: "Build completed again",
  });
  assert.equal(second.skipped, true, "second call should skip");
  assert.equal(second.reason, "already_completed");
});

test("agent-run-writeback: writeIdempotentAgentRun skips when no task_id", async () => {
  const { writeIdempotentAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeIdempotentAgentRun(store, {
    goal_id: "g1", role: "builder", status: "completed",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no task_id");
});

test("agent-run-writeback: writeIdempotentAgentRun non-blocking on store error", async () => {
  const { writeIdempotentAgentRun } = await import("../src/agent-run-writeback.mjs");
  const brokenStore = { load: () => { throw new Error("store broken"); }, mutate: () => { throw new Error("store broken"); } };

  const result = await writeIdempotentAgentRun(brokenStore, {
    task_id: "t1", goal_id: "g1", role: "builder", status: "completed",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.error, true);
});

// ===========================================================================
// Tests: writeBuilderAgentRun
// ===========================================================================

test("agent-run-writeback: writeBuilderAgentRun creates builder agent run", async () => {
  const { writeBuilderAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeBuilderAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    taskResult: { status: "completed", summary: "Built", changed_files: ["a.js"], commit: "abc123" },
    summary: "Builder summary",
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "builder");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeBuilderAgentRun handles failed result", async () => {
  const { writeBuilderAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeBuilderAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    taskResult: { status: "failed" },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "builder");
  assert.equal(result.agent_run.status, "failed");
});

// ===========================================================================
// Tests: writeVerifierAgentRun
// ===========================================================================

test("agent-run-writeback: writeVerifierAgentRun creates verifier agent run", async () => {
  const { writeVerifierAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeVerifierAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "verifier");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeVerifierAgentRun handles failed verification", async () => {
  const { writeVerifierAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeVerifierAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    verification: { passed: false, failure_class: "test_failed" },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "verifier");
  assert.equal(result.agent_run.status, "failed");
});

test("agent-run-writeback: writeVerifierAgentRun fails passed verification without command evidence", async () => {
  const { writeVerifierAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeVerifierAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    verification: { passed: true, commands: [] },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "verifier");
  assert.equal(result.agent_run.status, "failed");
  assert.match(result.agent_run.summary, /verification_commands_missing/);
  assert.equal(result.agent_run.output_artifacts[0].commands_count, 0);
  assert.equal(result.agent_run.output_artifacts[0].passed, false);
  assert.equal(result.agent_run.output_artifacts[0].failure_class, "verification_commands_missing");
  assert.deepEqual(result.agent_run.output_artifacts[0].missing_evidence, ["verification.commands"]);
  assert.equal(result.agent_run.output_artifacts[0].findings[0].code, "verification_commands_missing");
  assert.match(result.agent_run.output_artifacts[0].next_action, /verification command/i);
});

test("agent-run-writeback: provider blocker skips downstream acceptance roles", async () => {
  const { skipDownstreamAgentRunsForBlocker } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await skipDownstreamAgentRunsForBlocker(store, {
    task_id: "t_provider_404",
    goal_id: "g_provider_404",
    finding: {
      severity: "blocker",
      code: "provider_endpoint_not_found",
      message: "The configured provider returned 404 for /v1/responses.",
    },
    next_action: "Configure a provider endpoint that implements the Codex Responses transport, then requeue the task.",
  });

  assert.deepEqual(result.roles, ["verifier", "reviewer", "integrator"]);
  assert.equal(result.skipped, 3);

  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const runs = await listAgentRuns(store, { task_id: "t_provider_404", limit: 10 });
  assert.deepEqual(runs.agent_runs.map((run) => run.role).sort(), ["integrator", "reviewer", "verifier"]);
  assert.ok(runs.agent_runs.every((run) => run.status === "skipped"));
  assert.ok(runs.agent_runs.every((run) => run.output_artifacts[0].code === "provider_endpoint_not_found"));
});

// ===========================================================================
// Tests: writeReviewerAgentRun
// ===========================================================================

test("agent-run-writeback: writeReviewerAgentRun creates reviewer agent run", async () => {
  const { writeReviewerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeReviewerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    reviewer_decision: { decision: { passed: true, status: "accepted" } },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "reviewer");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeReviewerAgentRun handles rejection", async () => {
  const { writeReviewerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeReviewerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    reviewer_decision: { passed: false, status: "rejected" },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "reviewer");
  assert.equal(result.agent_run.status, "failed");
});

test("agent-run-writeback: writeReviewerAgentRun handles simple decision format", async () => {
  const { writeReviewerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeReviewerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    reviewer_decision: { passed: true },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "reviewer");
  assert.equal(result.agent_run.status, "completed");
});

// ===========================================================================
// Tests: writeFinalizerAgentRun
// ===========================================================================

test("agent-run-writeback: writeFinalizerAgentRun creates finalizer agent run", async () => {
  const { writeFinalizerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeFinalizerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    taskResult: { summary: "Task completed successfully" },
    taskStatus: "completed",
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "finalizer");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeFinalizerAgentRun handles failed status", async () => {
  const { writeFinalizerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeFinalizerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    taskResult: { reason: "Something went wrong" },
    taskStatus: "failed",
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "finalizer");
  assert.equal(result.agent_run.status, "failed");
});

// ===========================================================================
// Tests: writeIntegratorAgentRun
// ===========================================================================

test("agent-run-writeback: writeIntegratorAgentRun creates integrator agent run", async () => {
  const { writeIntegratorAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeIntegratorAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    integrationResult: { status: "merged", merged: true },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "integrator");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeIntegratorAgentRun handles 'not_required' as completed", async () => {
  const { writeIntegratorAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeIntegratorAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    integrationResult: { status: "not_required", merged: false },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "integrator");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeIntegratorAgentRun handles failed integration", async () => {
  const { writeIntegratorAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeIntegratorAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    integrationResult: { status: "conflict", merged: false },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "integrator");
  assert.equal(result.agent_run.status, "failed");
});

// ===========================================================================
// Tests: writeRepairerAgentRun
// ===========================================================================

test("agent-run-writeback: writeRepairerAgentRun creates repairer agent run (success)", async () => {
  const { writeRepairerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeRepairerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    repairOutcome: { passed: true, repair_outcome: "repaired", reason: "Fix applied" },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "repairer");
  assert.equal(result.agent_run.status, "completed");
});

test("agent-run-writeback: writeRepairerAgentRun creates repairer agent run (failure)", async () => {
  const { writeRepairerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeRepairerAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    repairOutcome: { passed: false, repair_outcome: "failed", reason: "Could not fix" },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "repairer");
  assert.equal(result.agent_run.status, "failed");
});

// ===========================================================================
// Tests: writeContextCuratorAgentRun
// ===========================================================================

test("agent-run-writeback: writeContextCuratorAgentRun creates context_curator agent run", async () => {
  const { writeContextCuratorAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeContextCuratorAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    artifacts: {
      codex_entry: { path: ".gptwork/goals/g1/codex.entry.md", required: true, present: true },
      context_bundle: { path: ".gptwork/goals/g1/context.bundle.md", required: true, present: true },
    },
  });

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "context_curator");
  assert.equal(result.agent_run.status, "completed");
  assert.ok(result.agent_run.output_artifacts.length >= 2);
});

// ===========================================================================
// Tests: writeAllAgentRuns
// ===========================================================================

test("agent-run-writeback: writeAllAgentRuns runs multiple writebacks concurrently", async () => {
  const { writeBuilderAgentRun, writeVerifierAgentRun, writeAllAgentRuns } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const results = await writeAllAgentRuns(store, [
    { fn: writeBuilderAgentRun, opts: { task_id: "t1", goal_id: "g1", taskResult: { status: "completed", summary: "Built" } } },
    { fn: writeVerifierAgentRun, opts: { task_id: "t1", goal_id: "g1", verification: { passed: true } } },
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");

  // Verify the runs were created in the store
  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const list = await listAgentRuns(store, { task_id: "t1", limit: 10 });
  assert.ok(list.agent_runs.length >= 2, "should have at least 2 agent runs");
});

test("agent-run-writeback: completeQueuedAgentRuns fails queued verifier when task result has no command evidence", async () => {
  const { completeQueuedAgentRuns } = await import("../src/agent-run-writeback.mjs");
  const { createAgentRun, listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  await createAgentRun(store, { task_id: "t-empty-verifier", goal_id: "g1", role: "verifier", status: "queued" });

  const result = await completeQueuedAgentRuns(store, {
    task_id: "t-empty-verifier",
    goal_id: "g1",
    taskResult: { verification: { passed: true, commands: [] } },
  });

  assert.equal(result.completed, 1);
  const runs = await listAgentRuns(store, { task_id: "t-empty-verifier", limit: 10 });
  assert.equal(runs.agent_runs.length, 1);
  assert.equal(runs.agent_runs[0].role, "verifier");
  assert.equal(runs.agent_runs[0].status, "failed");
  assert.equal(runs.agent_runs[0].output_artifacts[0].commands_count, 0);
  assert.equal(runs.agent_runs[0].output_artifacts[0].failure_class, "verification_commands_missing");
});

// ===========================================================================
// Tests: legacy compatibility and edge cases
// ===========================================================================

test("agent-run-writeback: handles missing task_id gracefully", async () => {
  const { writeBuilderAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  const result = await writeBuilderAgentRun(store, {
    goal_id: "g1",
    taskResult: { status: "completed", summary: "Built" },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no task_id");
});

test("agent-run-writeback: handles context without eventLogger", async () => {
  const { writeBuilderAgentRun } = await import("../src/agent-run-writeback.mjs");
  const store = await makeStore();

  // Should not throw when context is minimal
  const result = await writeBuilderAgentRun(store, {
    task_id: "t1", goal_id: "g1",
    taskResult: { status: "completed", summary: "Built" },
  }, {});

  assert.equal(result.created, true);
  assert.equal(result.agent_run.role, "builder");
});

test("agent-run-writeback: can list all agent runs for a task", async () => {
  const { writeBuilderAgentRun, writeVerifierAgentRun, writeReviewerAgentRun, writeFinalizerAgentRun } = await import("../src/agent-run-writeback.mjs");
  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  await writeBuilderAgentRun(store, { task_id: "t1", goal_id: "g1", taskResult: { status: "completed", summary: "Built" } });
  await writeVerifierAgentRun(store, { task_id: "t1", goal_id: "g1", verification: { passed: true } });
  await writeReviewerAgentRun(store, { task_id: "t1", goal_id: "g1", reviewer_decision: { decision: { passed: true } } });
  await writeFinalizerAgentRun(store, { task_id: "t1", goal_id: "g1", taskResult: { summary: "Done" }, taskStatus: "completed" });

  const list = await listAgentRuns(store, { task_id: "t1", limit: 10 });
  assert.ok(list.agent_runs.length >= 4, "should have at least 4 agent runs for builder, verifier, reviewer, finalizer");

  const roles = list.agent_runs.map(r => r.role);
  assert.ok(roles.includes("builder"), "should include builder");
  assert.ok(roles.includes("verifier"), "should include verifier");
  assert.ok(roles.includes("reviewer"), "should include reviewer");
  assert.ok(roles.includes("finalizer"), "should include finalizer");
});

test("agent-run-writeback: agent runs are never empty after writeback", async () => {
  const { writeBuilderAgentRun } = await import("../src/agent-run-writeback.mjs");
  const { listAgentRuns } = await import("../src/agent-run-service.mjs");
  const store = await makeStore();

  await writeBuilderAgentRun(store, { task_id: "t1", goal_id: "g1", taskResult: { status: "completed", summary: "Built" } });

  const list = await listAgentRuns(store, { task_id: "t1", limit: 10 });
  assert.ok(list.agent_runs.length > 0, "agent_runs should not be empty");
});
