/**
 * p0-ma11-r2.test.mjs — P0-MA11-R2 Historical State Convergence Tests
 *
 * Tests:
 * 1. isCommitAncestorOfHead correctly identifies reachable/not-reachable commits
 * 2. isVerificationNormalized accepts legacy result.commit reachable from HEAD
 * 3. classifyCurrentBlockerTask does not block waiting_for_repair with already-integrated commit
 * 4. classifyCurrentBlockerTask still blocks waiting_for_repair with no commit or failed verification
 * 5. sweepWaitingForRepair completes tasks with reachable commit
 * 6. completeQueuedAgentRuns resolves queued agent_runs for tasks with result evidence
 * 7. convergeStaleTaskStates integrates sweep + agent_run completion
 * 8. No regression: true failures without commit remain blocking
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const SRC_DIR = resolve(__dirname, "../src");
const REPO_DIR = resolve(SRC_DIR, ".."); // canonical repo root

// ---------------------------------------------------------------------------
// Helper: create a minimal mock store
// ---------------------------------------------------------------------------
async function makeStore() {
  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const dir = await mkdtemp(join(tmpdir(), "p0-ma11-r2-test-"));
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

// Use the current HEAD as the "already integrated" commit reference
const HEAD_COMMIT = execSync("git rev-parse HEAD", { cwd: REPO_DIR, encoding: "utf8" }).trim();
const NON_EXISTENT_COMMIT = "0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Test 1: isCommitAncestorOfHead
// ---------------------------------------------------------------------------
test("MA11-R2: isCommitAncestorOfHead returns true for HEAD commit", async () => {
  const { isCommitAncestorOfHead } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  assert.equal(isCommitAncestorOfHead(HEAD_COMMIT, REPO_DIR), true,
    "HEAD commit should be an ancestor of HEAD");
});

test("MA11-R2: isCommitAncestorOfHead returns false for non-existent commit", async () => {
  const { isCommitAncestorOfHead } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  assert.equal(isCommitAncestorOfHead(NON_EXISTENT_COMMIT, REPO_DIR), false,
    "non-existent commit should not be reachable");
});

test("MA11-R2: isCommitAncestorOfHead returns false for invalid input", async () => {
  const { isCommitAncestorOfHead } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  assert.equal(isCommitAncestorOfHead("", REPO_DIR), false, "empty string");
  assert.equal(isCommitAncestorOfHead(null, REPO_DIR), false, "null");
  assert.equal(isCommitAncestorOfHead(undefined, REPO_DIR), false, "undefined");
  assert.equal(isCommitAncestorOfHead("abc", REPO_DIR), false, "too short (3 chars)");
  assert.equal(isCommitAncestorOfHead("abcdef", REPO_DIR), false, "too short (6 chars)");
});

// ---------------------------------------------------------------------------
// Test 2: isVerificationNormalized with legacy commit reachability
// ---------------------------------------------------------------------------
test("MA11-R2: isVerificationNormalized detects already-integrated via HEAD reachability", async () => {
  const { isVerificationNormalized } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  // Legacy result with commit that IS reachable from HEAD + verification passed
  const result = {
    commit: HEAD_COMMIT,
    verification: { passed: true },
    tests: "node --test all passed",
  };
  assert.equal(isVerificationNormalized(result), true,
    "should be normalized when commit is reachable from HEAD and verification passed");
  
  // Should have populated delivery_result_recovery
  assert.ok(result.delivery_result_recovery, "should populate delivery_result_recovery");
  assert.equal(result.delivery_result_recovery.reason, "already_integrated");
  assert.equal(result.delivery_result_recovery.recovered, true);
});

test("MA11-R2: isVerificationNormalized returns false for non-reachable commit", async () => {
  const { isVerificationNormalized } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  const result = {
    commit: NON_EXISTENT_COMMIT,
    verification: { passed: true },
    tests: "node --test all passed",
  };
  assert.equal(isVerificationNormalized(result), false,
    "non-reachable commit should not normalize");
});

test("MA11-R2: isVerificationNormalized returns false without verification evidence", async () => {
  const { isVerificationNormalized } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  // Commit reachable but no verification/tests passed
  assert.equal(isVerificationNormalized({ commit: HEAD_COMMIT }), false,
    "no verification should not normalize");
  assert.equal(isVerificationNormalized({ commit: HEAD_COMMIT, verification: { passed: false } }), false,
    "failed verification should not normalize");
});

// ---------------------------------------------------------------------------
// Test 3: classifyCurrentBlockerTask — waiting_for_repair with integrated commit
// ---------------------------------------------------------------------------
test("MA11-R2: classifyCurrentBlockerTask waiting_for_repair with integrated commit is non-blocking", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  // Simulate a MA11-style task: waiting_for_repair with commit reachable + verification passed
  const task = {
    status: "waiting_for_repair",
    result: {
      commit: HEAD_COMMIT,
      verification: { passed: true },
      tests: "node --test all passed",
      execution_cwd: REPO_DIR,
    },
  };
  
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, false,
    "waiting_for_repair with already-integrated commit should NOT block current work");
  assert.equal(decision.label, "review",
    "should be classified as review (non-blocking)");
});

test("MA11-R2: classifyCurrentBlockerTask waiting_for_repair without commit still blocks", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  const task = {
    status: "waiting_for_repair",
    result: {
      summary: "verification failed",
      verification: { passed: false, failure_class: "test_failed" },
    },
  };
  
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true,
    "waiting_for_repair without integrated commit should still block");
});

test("MA11-R2: classifyCurrentBlockerTask waiting_for_repair with commit but failed verification blocks", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  
  const task = {
    status: "waiting_for_repair",
    result: {
      commit: HEAD_COMMIT,
      verification: { passed: false, failure_class: "test_failed" },
    },
  };
  
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true,
    "waiting_for_repair with commit but failed verification should still block");
});

// ---------------------------------------------------------------------------
// Test 4: completeQueuedAgentRuns (mock or unit)
// ---------------------------------------------------------------------------
test("MA11-R2: completeQueuedAgentRuns completes queued runs for task with result", async () => {
  const { completeQueuedAgentRuns } = await import(join(SRC_DIR, "agent-run-writeback.mjs"));
  const { createAgentRun } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const store = await makeStore();

  // Create queued agent runs (simulating legacy MA11 state)
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "context_curator", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "planner", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "builder", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "verifier", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "reviewer", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "integrator", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11", goal_id: "g1", role: "finalizer", status: "queued" });

  // Complete them from task result evidence
  const result = await completeQueuedAgentRuns(store, {
    task_id: "t-ma11",
    goal_id: "g1",
    taskResult: {
      commit: HEAD_COMMIT,
      verification: { passed: true },
      changed_files: ["test.js"],
      tests: "node --test passed",
    },
  });

  assert.equal(result.completed, 7, "should complete all 7 queued agent runs");

  // Verify they're now completed/skipped in the store
  const { listAgentRuns } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const runs = await listAgentRuns(store, { task_id: "t-ma11", limit: 50 });
  for (const run of runs.agent_runs) {
    assert.ok(
      run.status === "completed" || run.status === "skipped",
      `agent run ${run.role} should be completed or skipped, got ${run.status}`
    );
  }
});

test("MA11-R2: completeQueuedAgentRuns handles no queued runs gracefully", async () => {
  const { completeQueuedAgentRuns } = await import(join(SRC_DIR, "agent-run-writeback.mjs"));
  const store = await makeStore();

  const result = await completeQueuedAgentRuns(store, {
    task_id: "t-no-runs",
    taskResult: { commit: HEAD_COMMIT },
  });

  assert.equal(result.skipped, 0, "no runs to skip");
  assert.equal(result.completed, 0, "no runs to complete");
});

// ---------------------------------------------------------------------------
// Test 5: sweepStaleTaskStates with commit reachability
// ---------------------------------------------------------------------------
test("MA11-R2: sweepStaleTaskStates waiting_for_repair with reachable commit → completed", async () => {
  const { sweepStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));
  const now = Date.now();

  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_ma11_parent",
      status: "waiting_for_repair",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        commit: HEAD_COMMIT,
        verification: { passed: true },
        tests: "node --test all passed",
      },
    }],
    now,
  });

  assert.equal(actions.length, 1, "should produce one sweep action");
  assert.equal(actions[0].taskId, "task_ma11_parent");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("already integrated") || actions[0].reason.includes("reachable"),
    `reason should mention integrated: ${actions[0].reason}`);
});

test("MA11-R2: sweepStaleTaskStates waiting_for_repair with non-reachable commit → no action for non-stale", async () => {
  const { sweepStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));
  const now = Date.now();

  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_no_commit",
      status: "waiting_for_repair",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        verification: { passed: false, failure_class: "test_failed" },
      },
    }],
    now,
  });

  // No commit, no parent, not stale → no action
  assert.equal(actions.length, 0, "non-stale repair without commit evidence should yield no action");
});

// ---------------------------------------------------------------------------
// Test 6: convergeStaleTaskStates — integration test
// ---------------------------------------------------------------------------
test("MA11-R2: convergeStaleTaskStates sweeps stale states and completes queued runs", async () => {
  const { convergeStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));
  const { createAgentRun } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const store = await makeStore();
  const now = Date.now();

  // Add MA11-style task: waiting_for_repair with integrated commit + queued agent_runs
  await store.mutate(state => {
    state.tasks = [
      {
        id: "t-ma11-parent",
        status: "waiting_for_repair",
        result: {
          commit: HEAD_COMMIT,
          verification: { passed: true },
          tests: "node --test passed",
        },
      },
    ];
  });

  // Create queued agent runs
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "context_curator", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "planner", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "builder", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "verifier", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "reviewer", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "integrator", status: "queued" });
  await createAgentRun(store, { task_id: "t-ma11-parent", goal_id: "g1", role: "finalizer", status: "queued" });

  // Also add a "true failure" task with no commit (should remain untouched by sweep)
  await store.mutate(state => {
    state.tasks.push({
      id: "t-real-failure",
      status: "waiting_for_repair",
      result: {
        verification: { passed: false, failure_class: "test_failed" },
        summary: "Real failure - tests are failing",
      },
    });
  });

  // Run convergence dry-run
  const result = await convergeStaleTaskStates(store, { now, dryRun: true });

  // The MA11-style task should have a sweep action
  const ma11Sweep = result.sweepActions.find(a => a.taskId === "t-ma11-parent");
  assert.ok(ma11Sweep, "should have sweep action for MA11 parent task, got " + JSON.stringify(result.sweepActions));
  assert.equal(ma11Sweep.recommendedStatus, "completed");

  // It should also have agent run completions
  const ma11Completion = result.agentRunCompletions.find(c => c.task_id === "t-ma11-parent");
  assert.ok(ma11Completion, "should have agent run completions for MA11 parent task, got " + JSON.stringify(result.agentRunCompletions));
  assert.equal(ma11Completion.completed, 7, "should complete 7 queued agent runs");

  // The real failure task should NOT have sweep actions (no commit, no verification)
  // Note: the sweeper may still produce a stale-failure action if the task is old enough.
  // We just check it's not marked as completed.
  const failureSweep = result.sweepActions.find(a => a.taskId === "t-real-failure");
  assert.ok(!failureSweep || failureSweep.recommendedStatus !== "completed",
    "real failure task should not be swept to completed");
});

// ---------------------------------------------------------------------------
// Test 7: No regression — existing blocker policy still blocks true failures
// ---------------------------------------------------------------------------
test("MA11-R2: existing blocker policy still blocks true failures", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));

  // True failure: failed + no commit + verification failed
  const failureTask = {
    status: "failed",
    result: {
      verification: { passed: false, failure_class: "test_failed" },
      changed_files: ["src/broken.js"],
    },
  };
  assert.equal(classifyCurrentBlockerTask(failureTask).blocks_current_work, true,
    "true failure with code evidence should block");

  // Non-failure: completed task
  const completedTask = {
    status: "completed",
    result: {
      verification: { passed: true },
      commit: HEAD_COMMIT,
    },
  };
  assert.equal(classifyCurrentBlockerTask(completedTask).blocks_current_work, false,
    "completed task should not block");
});

// ---------------------------------------------------------------------------
// Test 8: Convergence through convergeStaleTaskStates (non-dry-run, verify state changes)
// ---------------------------------------------------------------------------
test("MA11-R2: convergeStaleTaskStates applied sweeps mutate store state", async () => {
  const { convergeStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));
  const { createAgentRun } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const { listAgentRuns } = await import(join(SRC_DIR, "agent-run-service.mjs"));
  const store = await makeStore();
  const now = Date.now();

  await store.mutate(state => {
    state.tasks = [
      {
        id: "t-sweep-apply",
        status: "waiting_for_repair",
        result: {
          commit: HEAD_COMMIT,
          verification: { passed: true },
          tests: "node --test passed",
        },
      },
    ];
  });

  await createAgentRun(store, { task_id: "t-sweep-apply", goal_id: "g1", role: "builder", status: "queued" });

  // Apply convergence (not dry run)
  const result = await convergeStaleTaskStates(store, { now, dryRun: false });

  // Should have either applied sweeps (completed) or at least completed agent runs
  const hasSweeps = result.applied > 0;
  const hasCompletions = result.agentRunCompletions.length > 0;
  assert.ok(hasSweeps || hasCompletions,
    "should have either applied sweeps or completed agent runs: applied=" + result.applied + " completions=" + result.agentRunCompletions.length);

  // Agent runs should be completed
  const runs = await listAgentRuns(store, { task_id: "t-sweep-apply", limit: 10 });
  const completedRuns = runs.agent_runs.filter(r => r.status === "completed" || r.status === "skipped");
  assert.ok(completedRuns.length > 0, "agent runs should be completed after convergence");
  assert.equal(runs.agent_runs.length, 1, "should still have 1 total agent run");
});
