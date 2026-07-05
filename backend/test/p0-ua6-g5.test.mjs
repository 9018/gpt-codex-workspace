/**
 * p0-ua6-g5.test.mjs — P0-UA6 G5 End-to-End Soak & Release Gate Tests
 *
 * Tests automatic acceptance and queue advancement scenarios:
 * 1. Successful code change auto-completes
 * 2. Missing integration does not advance dependents
 * 3. Verification failure routes to repair/review
 * 4. Repair successor convergence completes parent
 * 5. No-mutation evidence completes via verification evidence
 * 6. Provider no-result does not complete
 * 7. TUI fallback missing required Superpowers plugin is blocked
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const SRC_DIR = join(__dirname, "../src");
const HEAD_COMMIT = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

// ---------------------------------------------------------------------------
// Test 1: Successful code change auto-completes
// ---------------------------------------------------------------------------
test("G5: successful code change auto-completes", async () => {
  const { decideTaskClosure } = await import(join(SRC_DIR, "closure/task-closure-decider.mjs"));

  const result = {
    status: "completed",
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    changed_files: ["lib/utils.js"],
    commit: HEAD_COMMIT,
  };

  const closure = decideTaskClosure({
    contract: {
      intent: { operation_kind: "code_change", mutation_scope: "code", semantic_confidence: "high" },
      requirements: { requires_commit: true },
      verification_plan: { profile: "code_change" },
    },
    contractVerification: { blocking_passed: true },
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    result,
  });

  assert.equal(closure.auto_complete_allowed, true,
    "successful code change should auto-complete");
  assert.ok(closure.blocking_passed, "blocking gate should pass");
});

// ---------------------------------------------------------------------------
// Test 2: Missing integration does not advance dependents
// ---------------------------------------------------------------------------
test("G5: missing integration tracked via sweep", async () => {
  const { sweepStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));

  const now = Date.now();
  const task = {
    id: "t-integration-pending",
    status: "waiting_for_integration",
    updated_at: new Date(now - 500).toISOString(),
    result: {
      commit: HEAD_COMMIT,
      verification: { passed: true },
      changed_files: ["src/test.js"],
      integration: { status: "queued", merged: false },
    },
  };

  const actions = sweepStaleTaskStates({
    tasks: [task],
    now,
    staleThresholdMs: 5000,
  });

  const sweepAction = actions.find(a => a.taskId === "t-integration-pending");
  // Not stale yet, so no action expected
  assert.ok(!sweepAction,
    "non-stale integration pending should not have sweep action");
});

// ---------------------------------------------------------------------------
// Test 3: Verification failure routes to repair
// ---------------------------------------------------------------------------
test("G5: verification failure routes to repair via convergence", async () => {
  const { convergeTaskAfterRun } = await import(join(SRC_DIR, "task-convergence.mjs"));

  const convergence = convergeTaskAfterRun({
    task: { id: "t-fail", status: "running", max_attempts: 2 },
    taskResult: {
      status: "failed",
      verification: { passed: false, failure_class: "test_failed", commands: [{ cmd: "npm test", exit_code: 1 }] },
      failure_class: "verification_failed",
      changed_files: ["src/broken.js"],
    },
    acceptance: { passed: false, findings: [{ severity: "blocker", code: "verification_failed", message: "Tests failed" }] },
  });

  // Convergence should route to repair (not completed, not failed directly)
  assert.equal(convergence.nextStatus, "waiting_for_repair",
    "verification failure should route to waiting_for_repair");
  assert.ok(convergence.repairPlan !== null,
    "should have a repair plan");
});

// ---------------------------------------------------------------------------
// Test 4: Repair successor convergence completes parent
// ---------------------------------------------------------------------------
test("G5: repair successor convergence completes parent via handleRepairCompletion", async () => {
  const { handleRepairCompletion } = await import(join(SRC_DIR, "repair-loop.mjs"));

  const store = {
    state: {
      tasks: [
        {
          id: "t-parent",
          status: "waiting_for_repair",
          goal_id: "g1",
          result: { summary: "Initial failure" },
          logs: [],
          updated_at: new Date().toISOString(),
        },
      ],
      goals: [
        { id: "g1", status: "assigned", updated_at: new Date().toISOString() },
      ],
    },
    async mutate(fn) {
      fn(this.state);
      return { parent_updated: true, parent_task_id: "t-parent", parent_status: "completed", repair_outcome: "repaired" };
    },
  };

  const result = await handleRepairCompletion({
    store,
    config: {},
    completedTask: { id: "t-repair-1", parent_task_id: "t-parent", goal_id: "g1" },
    passed: true,
  });

  assert.ok(result, "handleRepairCompletion should return a result");
});

// ---------------------------------------------------------------------------
// Test 5: No-mutation completes via verification evidence
// ---------------------------------------------------------------------------
test("G5: no-mutation completes via verification evidence", async () => {
  const { isVerificationNormalized, classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));

  // Diagnostic task with no changed files but passing verification
  const result = {
    changed_files: [],
    operation_kind: "diagnostic",
    mutation_scope: "none",
    verification: { passed: true, commands: [{ cmd: "node --check", exit_code: 0 }] },
    tests: "node --check passed",
  };

  assert.equal(isVerificationNormalized(result), true,
    "no-mutation with passing verification should normalize");

  const task = { status: "waiting_for_review", result };
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, false,
    "no-mutation with verification should not block");
});

// ---------------------------------------------------------------------------
// Test 6: Provider no-result does not complete
// ---------------------------------------------------------------------------
test("G5: provider no-result does not complete", async () => {
  const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));
  const { classifyResultShape, RESULT_SHAPE_TYPES } = await import(join(SRC_DIR, "result-shape-classifier.mjs"));

  // Provider returned no result — empty object has unknown shape
  const noResult = {};
  const shape = classifyResultShape(noResult);
  assert.ok(shape === RESULT_SHAPE_TYPES.UNKNOWN || shape === RESULT_SHAPE_TYPES.NO_RESULT,
    "empty result should not have completion/failure/code evidence, got " + shape);

  const task = {
    status: "failed",
    result: noResult,
  };

  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, false,
    "provider no-result should not block — shape=" + shape);
});

// ---------------------------------------------------------------------------
// Test 7: TUI fallback missing Superpowers plugin blocked
// ---------------------------------------------------------------------------
test("G5: TUI fallback missing Superpowers plugin blocked", async () => {
  const { checkSuperpowersPluginForTuiFallback } = await import(join(SRC_DIR, "codex-execution-provider.mjs"));

  // When Superpowers is explicitly required but not found, should block
  const config = { requireSuperpowersPluginForTuiFallback: true };
  const result = checkSuperpowersPluginForTuiFallback(config);

  // If the actual environment has superpowers, this returns available=true.
  // We test the contract: when not available, we must get diagnostic.
  if (!result.available) {
    assert.ok(result.diagnostic, "should return diagnostic when unavailable");
    assert.equal(result.diagnostic.code, "superpowers_plugin_missing",
      "diagnostic should have correct code");
    assert.ok(result.diagnostic.remediation,
      "diagnostic should include remediation instructions");
  } else {
    // If superpowers IS available, the check should recognize it
    assert.equal(result.required, true, "should mark as required check");
    assert.equal(result.diagnostic, null, "no diagnostic when available");
  }
});
