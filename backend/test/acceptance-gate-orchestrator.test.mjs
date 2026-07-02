/**
 * acceptance-gate-orchestrator.test.mjs — Tests for the independent gate orchestrator.
 *
 * Covers:
 * - runIndependentGate with various result shapes
 * - Pre-computed verification input
 * - File-based entry points
 * - Artifact writing behavior
 * - Three-way gate result
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runIndependentGate, gateFromFile, gateWithVerification } from "../src/acceptance-gate-orchestrator.mjs";
import { createVerificationResult } from "../src/verification-result-file.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ago-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runCommandOk(cmd) {
  return () => Promise.resolve({ cmd, exit_code: 0, stdout_tail: "ok", stderr_tail: "" });
}

function baseResult(overrides = {}) {
  return {
    status: "completed",
    summary: "implementation complete",
    changed_files: ["backend/src/app.mjs"],
    commit: "abc123",
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runIndependentGate
// ---------------------------------------------------------------------------

test("runIndependentGate: accepted — verification passes, result completed", async (t) => {
  const dir = await tmpDir(t);
  const resultPath = join(dir, "result.json");
  await writeFile(resultPath, JSON.stringify(baseResult()), "utf8");

  const gate = await runIndependentGate({
    resultJsonPath: resultPath,
    task: { id: "t1" },
    goal: { id: "g1" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeArtifacts: true,
    outputDir: dir,
  });

  assert.equal(gate.judgment, "accepted");
  assert.equal(gate.accepted, true);
  assert.equal(gate.failed, false);
  assert.equal(gate.needs_continue, false);
  assert.equal(gate.task_status, "completed");
  assert.equal(gate.auto_complete_allowed, true);
  assert.ok(gate.artifacts.verification_json);
  assert.ok(gate.artifacts.acceptance_json);

  // Check artifacts exist on disk
  const verFile = await readFile(gate.artifacts.verification_json, "utf8").then(JSON.parse);
  assert.equal(verFile.judgment, "passed");

  const accFile = await readFile(gate.artifacts.acceptance_json, "utf8").then(JSON.parse);
  assert.equal(accFile.judgment, "accepted");
});

test("runIndependentGate: failed — result status is failed", async (t) => {
  const gate = await runIndependentGate({
    result: baseResult({ status: "failed", summary: "implementation failed" }),
    task: { id: "t2" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeArtifacts: false,
  });

  assert.equal(gate.judgment, "failed");
  assert.equal(gate.failed, true);
  assert.equal(gate.accepted, false);
  assert.equal(gate.task_status, "failed");
  assert.equal(gate.auto_complete_allowed, false);
});

test("runIndependentGate: needs_continue — warnings in verification", async (t) => {
  const preVerification = createVerificationResult({
    judgment: "needs_continue",
    findings: [{ severity: "warning", code: "lint_warning", message: "Lint warnings" }],
  });

  const gate = await runIndependentGate({
    result: baseResult(),
    task: { id: "t3" },
    verification: preVerification,
    writeArtifacts: false,
  });

  assert.equal(gate.judgment, "needs_continue");  // Warnings from needs_continue VR -> needs_continue
  assert.equal(gate.accepted, false); assert.equal(gate.needs_continue, true);
  assert.ok(gate.acceptance.blockers.length === 0);
  assert.ok(gate.acceptance.followups.length > 0);
});

// ---------------------------------------------------------------------------
// gateWithVerification
// ---------------------------------------------------------------------------

test("gateWithVerification: uses pre-computed verification", async (t) => {
  const preVerification = createVerificationResult({
    judgment: "failed",
    findings: [{ severity: "blocker", code: "build_failure", message: "Build failed" }],
  });

  const gate = await gateWithVerification({
    verification: preVerification,
    result: baseResult(),
    task: { id: "t4" },
    writeArtifacts: false,
  });

  assert.equal(gate.judgment, "failed");
  assert.equal(gate.failed, true);
  assert.equal(gate.verification.judgment, "failed");
});

test("gateWithVerification: accepted with passed pre-computed verification", async (t) => {
  const preVerification = createVerificationResult({
    judgment: "passed",
    commands: [{ cmd: "npm test", exit_code: 0 }],
  });

  const gate = await gateWithVerification({
    verification: preVerification,
    result: baseResult(),
    task: { id: "t5" },
    writeArtifacts: false,
  });

  assert.equal(gate.judgment, "accepted");
});

// ---------------------------------------------------------------------------
// gateFromFile
// ---------------------------------------------------------------------------

test("gateFromFile: reads result from file and writes artifacts", async (t) => {
  const dir = await tmpDir(t);
  const resultPath = join(dir, "result.json");
  await writeFile(resultPath, JSON.stringify(baseResult()), "utf8");

  const gate = await gateFromFile(resultPath, {
    task: { id: "t6" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
  });

  assert.equal(gate.judgment, "accepted");
  assert.ok(gate.artifacts.verification_json);
  assert.ok(gate.artifacts.acceptance_json);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("runIndependentGate: handles null result gracefully", async (t) => {
  const gate = await runIndependentGate({
    result: null,
    verificationCommands: [],
    writeArtifacts: false,
  });

  assert.equal(gate.failed, true);
});

test("runIndependentGate: with acceptance contract config", async (t) => {
  const gate = await runIndependentGate({
    result: baseResult(),
    task: { id: "t7" },
    contract: {
      intent: { operation_kind: "code_change", semantic_confidence: "high" },
      blocking_requirements: [{ id: "changed_files_reported" }],
      requirements: { requires_commit: true },
    },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeArtifacts: false,
  });

  // With no blockers in verification but contract present -> needs_continue or accepted
  // Since we have no actual blockers and verification passed -> accepted
  assert.ok(["accepted", "needs_continue"].includes(gate.judgment));
});

test("runIndependentGate: returns structured verification and acceptance artifacts", async (t) => {
  const gate = await runIndependentGate({
    result: baseResult(),
    task: { id: "t8" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeArtifacts: false,
  });

  assert.ok(gate.verification);
  assert.equal(typeof gate.verification.commands_count, "number");
  assert.equal(typeof gate.verification.findings_count, "number");

  assert.ok(gate.acceptance);
  assert.ok(Array.isArray(gate.acceptance.blockers));
  assert.ok(Array.isArray(gate.acceptance.followups));
});
