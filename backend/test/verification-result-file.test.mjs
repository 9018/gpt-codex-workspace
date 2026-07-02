/**
 * verification-result-file.test.mjs — Tests for verification result file operations.
 *
 * Covers:
 * - createVerificationResult with all three judgments
 * - write/read roundtrip
 * - Validation errors for invalid judgments
 * - checkVerificationResultFile for existence and validity
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createVerificationResult,
  writeVerificationResultFile,
  readVerificationResultFile,
  checkVerificationResultFile,
  VERIFICATION_RESULT_SCHEMA_VERSION,
  VALID_JUDGMENTS,
} from "../src/verification-result-file.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "vr-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// createVerificationResult
// ---------------------------------------------------------------------------

test("createVerificationResult: passed judgment", () => {
  const vr = createVerificationResult({ judgment: "passed", commands: [{ cmd: "npm test", exit_code: 0 }] });

  assert.equal(vr.schema_version, VERIFICATION_RESULT_SCHEMA_VERSION);
  assert.equal(vr.judgment, "passed");
  assert.equal(vr.passed, true);
  assert.equal(vr.needs_continue, false);
  assert.equal(vr.failed, false);
  assert.equal(vr.commands.length, 1);
  assert.equal(vr.commands[0].cmd, "npm test");
  assert.equal(vr.commands[0].exit_code, 0);
  assert.ok(vr.summary.includes("passed"));
});

test("createVerificationResult: failed judgment", () => {
  const vr = createVerificationResult({
    judgment: "failed",
    findings: [{ severity: "blocker", code: "test_failure", message: "Tests failed" }],
    commands: [{ cmd: "npm test", exit_code: 1 }],
  });

  assert.equal(vr.judgment, "failed");
  assert.equal(vr.passed, false);
  assert.equal(vr.failed, true);
  assert.equal(vr.findings.length, 1);
  assert.equal(vr.findings[0].code, "test_failure");
  assert.ok(vr.summary.includes("failed"));
});

test("createVerificationResult: needs_continue judgment", () => {
  const vr = createVerificationResult({
    judgment: "needs_continue",
    findings: [{ severity: "warning", code: "lint_warning", message: "Lint warnings found" }],
  });

  assert.equal(vr.judgment, "needs_continue");
  assert.equal(vr.passed, false);
  assert.equal(vr.needs_continue, true);
  assert.equal(vr.failed, false);
  assert.ok(vr.summary.includes("continue") || vr.summary.includes("processing"));
});

test("createVerificationResult: throws on invalid judgment", () => {
  assert.throws(() => createVerificationResult({ judgment: "invalid" }), {
    message: /Invalid verification judgment/,
  });
});

test("createVerificationResult: includes task/goal IDs", () => {
  const vr = createVerificationResult({ judgment: "passed", task_id: "task_1", goal_id: "goal_1" });
  assert.equal(vr.task_id, "task_1");
  assert.equal(vr.goal_id, "goal_1");
});

test("createVerificationResult: normalizes commands with various shapes", () => {
  const vr = createVerificationResult({
    judgment: "passed",
    commands: [
      { cmd: "npm test", exit_code: 0, stdout: "ok" },
      { command: "npm run build", passed: false },
    ],
  });

  assert.equal(vr.commands.length, 2);
  assert.equal(vr.commands[0].cmd, "npm test");
  assert.equal(vr.commands[0].exit_code, 0);
  assert.equal(vr.commands[1].cmd, "npm run build");
  assert.equal(vr.commands[1].exit_code, 1);
});

test("createVerificationResult: deduplicates skipped_checks", () => {
  const vr = createVerificationResult({
    judgment: "passed",
    skipped_checks: [
      { cmd: "git diff --check", reason: "no repoPath" },
    ],
  });
  assert.equal(vr.skipped_checks.length, 1);
  assert.equal(vr.skipped_checks[0].cmd, "git diff --check");
});

// ---------------------------------------------------------------------------
// write / read cycle
// ---------------------------------------------------------------------------

test("writeVerificationResultFile and readVerificationResultFile roundtrip", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "verification.json");
  const vr = createVerificationResult({
    judgment: "passed",
    commands: [{ cmd: "npm test", exit_code: 0 }],
    task_id: "task_1",
    goal_id: "goal_1",
  });

  await writeVerificationResultFile(path, vr);
  const readBack = await readVerificationResultFile(path);

  assert.equal(readBack.judgment, "passed");
  assert.equal(readBack.task_id, "task_1");
  assert.equal(readBack.goal_id, "goal_1");
  assert.equal(readBack.commands.length, 1);
  assert.equal(readBack.schema_version, VERIFICATION_RESULT_SCHEMA_VERSION);
});

test("readVerificationResultFile throws on invalid file", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ foo: "bar" }), "utf8");

  await assert.rejects(() => readVerificationResultFile(path), {
    message: /Invalid judgment/,
  });
});

test("readVerificationResultFile throws on missing file", async (t) => {
  await assert.rejects(() => readVerificationResultFile("/nonexistent/path.json"));
});

// ---------------------------------------------------------------------------
// checkVerificationResultFile
// ---------------------------------------------------------------------------

test("checkVerificationResultFile: valid file", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "verification.json");
  await writeVerificationResultFile(path, createVerificationResult({ judgment: "passed" }));

  const result = await checkVerificationResultFile(path);
  assert.equal(result.exists, true);
  assert.equal(result.valid, true);
  assert.equal(result.judgment, "passed");
});

test("checkVerificationResultFile: missing file", async (t) => {
  const result = await checkVerificationResultFile("/nonexistent/path.json");
  assert.equal(result.exists, false);
  assert.equal(result.valid, false);
});

test("checkVerificationResultFile: invalid content", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ not_valid: true }), "utf8");

  const result = await checkVerificationResultFile(path);
  assert.equal(result.exists, true);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// VALID_JUDGMENTS
// ---------------------------------------------------------------------------

test("VALID_JUDGMENTS includes all three states", () => {
  assert.ok(VALID_JUDGMENTS.has("passed"));
  assert.ok(VALID_JUDGMENTS.has("failed"));
  assert.ok(VALID_JUDGMENTS.has("needs_continue"));
  assert.equal(VALID_JUDGMENTS.size, 3);
});
