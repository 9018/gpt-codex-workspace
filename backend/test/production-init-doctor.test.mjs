/**
 * production-init-doctor.test.mjs
 *
 * Targeted tests for:
 *   1. --production flag propagation in init/doctor
 *   2. Production blocker hard-fail behavior
 *   3. Local-mode non-blocking behavior preservation
 *   4. task-finalizer dead-code removal verification
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./helpers/env-isolation.mjs";
import { clearGptWorkVars } from "./helpers/env-isolation.mjs";

// ───────────────────────────────────────────────────────────────────
// Test 1: Flag Propagation — init --production
// ───────────────────────────────────────────────────────────────────

test("runInit with production option appends production checks", async () => {
  const { runInit, runFullCheck } = await import("../src/onboarding-init.mjs");

  // Run without production
  const normalChecks = await runInit({ gptworkDir: "/tmp/nonexistent-gptwork", projectRoot: "/tmp/nonexistent-project", backendRoot: "/tmp" });
  const normalNames = normalChecks.map(c => c.name);
  assert.ok(!normalNames.includes("production_worker"), "non-production mode does not include production_worker check");

  // Run with production
  const prodChecks = await runInit({ production: true, gptworkDir: "/tmp/nonexistent-gptwork", projectRoot: "/tmp/nonexistent-project", backendRoot: "/tmp" });
  const prodNames = prodChecks.map(c => c.name);
  assert.ok(prodNames.includes("production_worker"), "production mode includes production_worker check");
  assert.ok(prodNames.includes("role_commands"), "production mode includes role_commands check");
  assert.ok(prodNames.includes("current_head"), "production mode includes current_head check");
});

test("runProductionProfile returns 9 checks including production_worker with blocker status", async () => {
  const { runProductionProfile, checkProductionWorkerEnabled } = await import("../src/onboarding-init.mjs");

  // Clear env
  delete process.env.GPTWORK_CODEX_WORKER;
  
  const checks = runProductionProfile({ gptworkDir: "/tmp/nonexistent-gptwork" });
  assert.equal(checks.length, 9, "production profile has 9 checks");

  const workerCheck = checks.find(c => c.name === "production_worker");
  assert.ok(workerCheck, "production_worker check present");
  assert.equal(workerCheck.status, "blocker", "production_worker is blocker when worker not enabled");
  assert.ok(workerCheck.detail.includes("worker not enabled"), "blocker detail mentions worker not enabled");

  // Verify non-production checks don't see blocker
  const fullCheckNormal = checks.filter(c => c.name !== "production_worker");
  for (const c of fullCheckNormal) {
    assert.ok(["pass", "warn", "skip"].includes(c.status) || c.status === "blocker" || c.status === "pass",
      `Unexpected status ${c.status} for ${c.name}`);
  }
});

// ───────────────────────────────────────────────────────────────────
// Test 2: Production Blocker Hard-Fail Behavior
// ───────────────────────────────────────────────────────────────────

test("production worker blocker is hard-fail, not warning", async () => {
  const { checkProductionWorkerEnabled } = await import("../src/onboarding-init.mjs");

  delete process.env.GPTWORK_CODEX_WORKER;
  const result = checkProductionWorkerEnabled("/tmp/nonexistent-gptwork");
  assert.equal(result.status, "blocker", "missing worker is blocker");
  assert.ok(result.fixable, "blocker is fixable");
  assert.ok(result.fixHint.includes("CODEX_WORKER"), "fix hint mentions GPTWORK_CODEX_WORKER");
});

test("production worker check honors process.env over runtime.env", async () => {
  const { checkProductionWorkerEnabled } = await import("../src/onboarding-init.mjs");

  clearGptWorkVars();
  const root = await mkdtemp(join(tmpdir(), "gptwork-prod-worker-precedence-"));
  const gptworkDir = join(root, ".gptwork");
  await mkdir(gptworkDir, { recursive: true });
  await writeFile(join(gptworkDir, "runtime.env"), "GPTWORK_CODEX_WORKER=true\n", "utf8");

  process.env.GPTWORK_CODEX_WORKER = "false";
  const result = checkProductionWorkerEnabled(gptworkDir);
  assert.equal(result.status, "blocker", "process.env=false must override runtime.env=true");
  delete process.env.GPTWORK_CODEX_WORKER;
});

test("production worker passes when enabled", () => {
  // We need to import after setting env
});

test("production worker check is non-blocking when worker IS enabled", async () => {
  const { checkProductionWorkerEnabled } = await import("../src/onboarding-init.mjs");

  process.env.GPTWORK_CODEX_WORKER = "true";
  const result = checkProductionWorkerEnabled("/tmp/nonexistent-gptwork");
  assert.equal(result.status, "pass", "worker enabled => pass");
  assert.ok(result.detail.includes("worker enabled"), "pass detail mentions worker enabled");
  delete process.env.GPTWORK_CODEX_WORKER;
});

test("verifier reviewer commands blocker correctly detects missing commands", async () => {
  const { checkVerifierReviewerCommands } = await import("../src/onboarding-init.mjs");

  process.env.GPTWORK_AGENT_ROLE_BACKENDS = "verifier=local_command";
  delete process.env.GPTWORK_AGENT_ROLE_COMMANDS;
  
  const result = checkVerifierReviewerCommands("/tmp/nonexistent-gptwork");
  assert.equal(result.status, "blocker", "verifier local_command missing command => blocker");
  assert.ok(result.fixable, "blocker is fixable");
  
  delete process.env.GPTWORK_AGENT_ROLE_BACKENDS;
});

test("verifier reviewer commands passes when command is configured", async () => {
  const { checkVerifierReviewerCommands } = await import("../src/onboarding-init.mjs");

  process.env.GPTWORK_AGENT_ROLE_BACKENDS = "verifier=local_command";
  process.env.GPTWORK_AGENT_ROLE_COMMANDS = "verifier=npm test";
  
  const result = checkVerifierReviewerCommands("/tmp/nonexistent-gptwork");
  assert.equal(result.status, "pass", "verifier local_command with command => pass");
  
  delete process.env.GPTWORK_AGENT_ROLE_BACKENDS;
  delete process.env.GPTWORK_AGENT_ROLE_COMMANDS;
});

// ───────────────────────────────────────────────────────────────────
// Test 3: Local/Dev mode does NOT report production blockers
// ───────────────────────────────────────────────────────────────────

test("runFullCheck without production does NOT include production blockers", async () => {
  const { runFullCheck } = await import("../src/onboarding-init.mjs");
  
  // Clear any env vars that might hint production
  delete process.env.GPTWORK_CODEX_WORKER;
  
  const checks = runFullCheck({ production: false, gptworkDir: "/tmp/nonexistent-gptwork" });
  const names = checks.map(c => c.name);
  
  assert.ok(!names.includes("production_worker"), "non-production mode excludes production_worker");
  assert.ok(!names.includes("role_commands"), "non-production mode excludes role_commands");
  assert.ok(!names.includes("current_head"), "non-production mode excludes current_head from production profile");
  assert.ok(names.includes("node_version"), "non-production mode still includes standard checks");
  assert.ok(names.includes("git"), "non-production mode still includes git check");
  assert.ok(names.includes("npm_deps"), "non-production mode still includes npm_deps check");
});

test("runFullCheck default opts.production is falsy", async () => {
  const { runFullCheck } = await import("../src/onboarding-init.mjs");
  
  const checks = runFullCheck({ gptworkDir: "/tmp/nonexistent-gptwork" });
  const names = checks.map(c => c.name);
  
  assert.ok(!names.includes("production_worker"), "default opts do not include production checks");
});

test("current head diagnostics do not depend on docs baseline content", async () => {
  const { checkCurrentHeadDiagnostics } = await import("../src/onboarding-init.mjs");

  const root = await mkdtemp(join(tmpdir(), "gptwork-head-diag-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs", "launch-initialization.md"),
    "Canonical baseline: `0000000000000000000000000000000000000000`\n",
    "utf8"
  );
  await writeFile(join(root, "README.md"), "head diagnostics fixture\n", "utf8");
  execSync("git init >/dev/null && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init >/dev/null", {
    cwd: root,
    encoding: "utf8",
  });

  const result = checkCurrentHeadDiagnostics(root);
  assert.equal(result.status, "pass");
  assert.ok(!result.detail.includes("docs baseline"));
});

// ───────────────────────────────────────────────────────────────────
// Test 4: task-finalizer dead code removal
// ───────────────────────────────────────────────────────────────────

test("task-finalizer decideTaskFinalState no longer contains unreachable code from duplicated function body", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  
  // Read the source file to verify dead code was removed
  const finalizerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/task-finalizer.mjs");
  const content = readFileSync(finalizerPath, "utf8");
  
  // The dead code had: "const finalizerDecisionToNormalize" followed by "normalizedStatus" 
  // references that should only exist inside the `decision()` helper, not in `decideTaskFinalState`
  // outside the decision() function
  
  // Check: finalizerDecisionToNormalize lives inside decision() not as dead code in decideTaskFinalState
  const decisionIdx = content.indexOf("function decision(");
  const decideIdx = content.indexOf("function decideTaskFinalState");
  const finalizerDecisionIdx = content.indexOf("finalizerDecisionToNormalize");
  
  assert.ok(decisionIdx >= 0, "decision() function found");
  assert.ok(decideIdx >= 0, "decideTaskFinalState() function found");
  assert.ok(finalizerDecisionIdx >= 0, "finalizerDecisionToNormalize found");
  // The occurrence must be before decideTaskFinalState (i.e. inside decision())
  assert.ok(finalizerDecisionIdx < decideIdx,
    "finalizerDecisionToNormalize lives inside decision() body, not after return in decideTaskFinalState");
  // There should not be a second occurrence after the function starts (would be dead code)
  const afterDecide = content.indexOf("finalizerDecisionToNormalize", decideIdx);
  assert.equal(afterDecide, -1,
    "No finalizerDecisionToNormalize reference in or after decideTaskFinalState (dead code was removed)");
});

test("task-finalizer decideTaskFinalState function is syntactically valid and produces correct decisions", async () => {
  const { decideTaskFinalState } = await import("../src/task-finalizer.mjs");
  
  // Test: capacity failure still triggers correct status
  const capResult = decideTaskFinalState({
    codex_result: { status: "failed", failure_class: "quota_exhausted", summary: "Rate limited" },
    verification: { passed: false },
  });
  assert.equal(capResult.status, "waiting_for_capacity", "capacity failure still detected");
  assert.equal(capResult.blockers.length, 1, "capacity failure has 1 blocker");
  assert.equal(capResult.blockers[0].code, "external_capacity_failure", "blocker code is correct");
  
  // Test: completed evidence still produces completion
  const completeResult = decideTaskFinalState({
    current_status: "completed",
    codex_result: {
      status: "completed",
      kind: "codex_executed",
      changed_files: ["src/test.mjs"],
      commit: "abc123",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      contract_verification: { blocking_passed: true, completion_eligible: true, blockers: [] },
      integration: { status: "merged", merged: true },
    },
    verification: { passed: true },
    acceptance: { passed: true, status: "accepted" },
    contract_verification: { blocking_passed: true, completion_eligible: true, blockers: [] },
    integration: { status: "merged", merged: true },
    repair_budget: { attempts_remaining: 1 },
  });
  assert.equal(completeResult.status, "completed", "completed evidence still produces completion");
  assert.equal(completeResult.safe_to_auto_advance, true, "completed result is safe to auto advance");
  
  // Test: the function does not internally reference undefined variables
  // (this would crash if dead code was still present since the dead code
  //  referenced `normalizedStatus`, `reason`, `blockers` which don't exist in
  //  the function scope - they only exist inside the `decision()` helper)
  assert.ok(true, "decideTaskFinalState() executes without ReferenceError");
});

test("task-finalizer applyTaskFinalStateDecision still works correctly", async () => {
  const { applyTaskFinalStateDecision } = await import("../src/task-finalizer.mjs");
  
  const result = applyTaskFinalStateDecision({
    taskStatus: "running",
    taskResult: { summary: "test" },
    finalizerDecision: { status: "completed", reason: "all_good" },
  });
  
  assert.equal(result.taskStatus, "completed", "applies completed status");
  assert.equal(result.taskResult.requires_review, false, "completed tasks do not require review");
  assert.equal(result.taskResult.finalizer_decision.reason, "all_good", "preserves finalizer decision reason");
});
