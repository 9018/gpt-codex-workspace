/**
 * p0-ua6-g2.test.mjs — P0-UA6 G2 Acceptance-Facts Tests
 *
 * Tests:
 * 1. Verification failure does not auto-complete or advance dependents
 * 2. Missing integration does not advance dependents
 * 3. No-mutation (readonly/sync-only) tasks require explicit evidence
 * 4. Closure/finalizer conflict resolved by closure/evidence
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
// Test 1: Verification failure does not complete
// ---------------------------------------------------------------------------
test("G2: verification failure does not auto-complete", async () => {
  const { isVerificationNormalized, classifyCurrentBlockerTask } = await import(join(SRC_DIR, "current-blocker-policy.mjs"));

  // Task with failed verification, no commit, no tests
  const task = {
    status: "waiting_for_repair",
    result: {
      verification: { passed: false, failure_class: "test_failed", commands: [{ cmd: "npm test", exit_code: 1 }] },
      summary: "3 of 47 tests failed",
    },
  };

  // The task should NOT be normalized
  assert.equal(isVerificationNormalized(task.result), false,
    "failed verification should not normalize");

  // The blocker policy should still block
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true,
    "failed verification should block current work");
});

// ---------------------------------------------------------------------------
// Test 2: Missing integration does not advance dependents
// ---------------------------------------------------------------------------
test("G2: missing integration does not advance dependents", async () => {
  const { sweepStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));

  const now = Date.now();
  const parentTask = {
    id: "t-parent",
    status: "waiting_for_integration",
    updated_at: new Date(now - 1000).toISOString(),
    result: {
      commit: HEAD_COMMIT,
      verification: { passed: true },
      changed_files: ["src/test.js"],
      integration: { status: "queued", merged: false },
    },
  };

  const childTask = {
    id: "t-child",
    status: "waiting_for_repair",
    parent_task_id: "t-parent",
    updated_at: new Date(now - 1000).toISOString(),
  };

  // Sweep with tasks
  const actions = sweepStaleTaskStates({
    tasks: [parentTask, childTask],
    now,
    staleThresholdMs: 600,
  });

  // Parent should NOT be swept to completed because integration is queued, not done
  const parentSweep = actions.find(a => a.taskId === "t-parent");
  assert.ok(!parentSweep || parentSweep.recommendedStatus !== "completed",
    "parent with missing integration should not be swept to completed");

  // Child should not be auto-advanced when parent is still in integration
  const childSweep = actions.find(a => a.taskId === "t-child");
  assert.ok(!childSweep || childSweep.recommendedStatus !== "completed",
    "dependent should not advance when parent integration missing");
});

// ---------------------------------------------------------------------------
// Test 3: No-mutation requires explicit evidence
// ---------------------------------------------------------------------------
test("G2: no-mutation requires explicit evidence for sweep", async () => {
  const { sweepStaleTaskStates } = await import(join(SRC_DIR, "stale-state-sweeper.mjs"));

  const now = Date.now();

  // Task with changed_files=[] and summary only (no structured evidence)
  const taskNoEvidence = {
    id: "t-no-evidence",
    status: "waiting_for_review",
    updated_at: new Date(now - 10000).toISOString(),
    result: {
      summary: "Sync-only task completed successfully",
      changed_files: [],
      operation_kind: "sync_only",
    },
  };

  // Sweep should NOT complete this task — no structured evidence
  const actions = sweepStaleTaskStates({
    tasks: [taskNoEvidence],
    now,
    staleThresholdMs: 5000,
  });

  const sweepAction = actions.find(a => a.taskId === "t-no-evidence");
  assert.ok(!sweepAction || sweepAction.recommendedStatus !== "completed",
    "no-mutation without explicit evidence should not be auto-swept to completed");

  // Task with changed_files=[] and explicit evidence (verification passed, acceptance gate)
  const taskWithEvidence = {
    id: "t-with-evidence",
    status: "waiting_for_review",
    updated_at: new Date(now - 10000).toISOString(),
    result: {
      summary: "Diagnostic task completed",
      changed_files: [],
      operation_kind: "diagnostic",
      verification: { passed: true, commands: [{ cmd: "node --check config.js", exit_code: 0 }] },
      acceptance_gate: { passed: true },
      mutation_scope: "none",
    },
  };

  const actions2 = sweepStaleTaskStates({
    tasks: [taskWithEvidence],
    now,
    staleThresholdMs: 5000,
  });

  const sweepAction2 = actions2.find(a => a.taskId === "t-with-evidence");
  assert.ok(sweepAction2, "task with evidence should have sweep action");
  assert.equal(sweepAction2.recommendedStatus, "completed",
    "no-mutation with explicit verification evidence should sweep to completed");
});

// ---------------------------------------------------------------------------
// Test 4: Closure/finalizer conflict resolved by closure/evidence
// ---------------------------------------------------------------------------
test("G2: closure/finalizer conflict resolved by closure/evidence", async () => {
  const { decideTaskClosure } = await import(join(SRC_DIR, "closure/task-closure-decider.mjs"));

  // Simulate a conflict: finalizer decision = completed, but verification failed
  const result = {
    status: "failed",
    verification: { passed: false, commands: [{ cmd: "npm test", exit_code: 1 }] },
    changed_files: ["src/test.js"],
    commit: HEAD_COMMIT,
  };

  const closure = decideTaskClosure({
    contract: {
      intent: { operation_kind: "code_change", mutation_scope: "code", semantic_confidence: "high" },
      requirements: { requires_commit: true },
      verification_plan: { profile: "code_change" },
    },
    contractVerification: { blocking_passed: false, blockers: [{ severity: "blocker", code: "verification_not_passed", message: "Verification did not pass" }] },
    verification: { passed: false, commands: [{ cmd: "npm test", exit_code: 1 }] },
    result,
  });

  // Closure should NOT auto-complete — it should require review or repair
  assert.equal(closure.auto_complete_allowed, false,
    "verification failure should not allow auto-complete");
  assert.ok(closure.blocking_passed === false || closure.reason === 'verification_failed',
    "closure should reflect verification failure: " + closure.reason);

  // Now with passing verification, closure should allow auto-complete
  const resultPassed = {
    status: "completed",
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    changed_files: ["src/test.js"],
    commit: HEAD_COMMIT,
  };

  const closurePassed = decideTaskClosure({
    contract: {
      intent: { operation_kind: "code_change", mutation_scope: "code", semantic_confidence: "high" },
      requirements: { requires_commit: true },
      verification_plan: { profile: "code_change" },
    },
    contractVerification: { blocking_passed: true },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    result: resultPassed,
  });

  assert.equal(closurePassed.auto_complete_allowed, true,
    "passing verification should allow auto-complete");
  assert.ok(closurePassed.blocking_passed,
    "blocking should pass with verified result");
});

// ---------------------------------------------------------------------------
// Test 5: acceptance-gate-engine produces acceptance facts
// ---------------------------------------------------------------------------
test("G2: acceptance-gate-engine module exports acceptance fact structure", async () => {
  const mod = await import(join(SRC_DIR, "acceptance-gate-engine.mjs"));
  assert.ok(typeof mod.runAcceptanceGate === "function",
    "runAcceptanceGate should be an exported function");

  // Verify supporting modules work as fact producers
  const { decideTaskClosure } = await import(join(SRC_DIR, "closure/task-closure-decider.mjs"));
  assert.ok(typeof decideTaskClosure === "function",
    "task-closure-decider should be the closure authority");

  const { convergeTaskAfterRun } = await import(join(SRC_DIR, "task-convergence.mjs"));
  assert.ok(typeof convergeTaskAfterRun === "function",
    "task-convergence should be exportable as next-status proposal layer");

  // Verify acceptance facts are produced from closure+convergence
  const result = {
    status: "completed",
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    changed_files: ["lib/utils.js"],
    commit: HEAD_COMMIT,
  };

  const acceptance = {
    passed: true,
    status: "accepted",
    findings: [],
    reviewer_decision: { status: "accepted", passed: true, decision: "accept" },
  };

  const convergence = convergeTaskAfterRun({
    task: { id: "t-g2-5", status: "running" },
    taskResult: result,
    acceptance,
  });

  assert.equal(convergence.nextStatus, "completed",
    "accepted + verified + no blockers should converge to completed");
  assert.equal(convergence.profile, "code_change",
    "profile should be detected correctly");
  assert.ok(convergence.closureReason,
    "convergence should provide closure reason");

  // Closure decider should produce closure facts
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
    "closure decider should allow auto-complete for passing verification");
  assert.ok(closure.blocking_passed,
    "blocking gate should be reported as passed");
});
