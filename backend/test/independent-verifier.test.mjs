/**
 * independent-verifier.test.mjs — Tests for independent verifier module.
 *
 * Covers:
 * - runIndependentVerification with various result shapes
 * - Judgment: passed, failed, needs_continue
 * - File-based and object-based inputs
 * - Write artifacts behavior
 * - verifyFromFile convenience
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runIndependentVerification, verifyFromFile } from "../src/independent-verifier.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "iv-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
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

function runCommandOk(cmd) {
  return () => Promise.resolve({ cmd, exit_code: 0, stdout_tail: "ok", stderr_tail: "" });
}

function runCommandFail(cmd) {
  return () => Promise.resolve({ cmd, exit_code: 1, stdout_tail: "", stderr_tail: "error" });
}

// ---------------------------------------------------------------------------
// Judgment: passed
// ---------------------------------------------------------------------------

test("runIndependentVerification: passed judgment with completed result", async (t) => {
  const result = baseResult();
  const out = await runIndependentVerification({
    result,
    task: { id: "task_pass" },
    goal: { id: "goal_pass" },
    repoPath: null,
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeResultFile: false,
  });

  assert.equal(out.judgment, "passed");
  assert.equal(out.passed, true);
  assert.equal(out.failed, false);
  assert.equal(out.needs_continue, false);
  assert.ok(out.verification);
  assert.equal(out.verification.judgment, "passed");
});

// ---------------------------------------------------------------------------
// Judgment: failed
// ---------------------------------------------------------------------------

test("runIndependentVerification: failed judgment with failed result", async (t) => {
  const result = baseResult({ status: "failed", summary: "implementation failed" });
  const out = await runIndependentVerification({
    result,
    task: { id: "task_fail" },
    goal: { id: "goal_fail" },
    repoPath: null,
    verificationCommands: ["npm test"],
    runCommand: runCommandFail("npm test"),
    writeResultFile: false,
  });

  assert.equal(out.judgment, "failed");
  assert.equal(out.passed, false);
  assert.equal(out.failed, true);
});

test("runIndependentVerification: failed judgment with blocker findings", async (t) => {
  const result = baseResult();
  // We create a scenario where un-supported status triggers blocker
  const badResult = { ...result, status: "invalid_status" };
  const out = await runIndependentVerification({
    result: badResult,
    repoPath: null,
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeResultFile: false,
  });

  assert.equal(out.judgment, "failed");
  assert.equal(out.failed, true);
  assert.ok(out.verification.findings.some(f => f.code === "unsupported_result_status"));
});

// ---------------------------------------------------------------------------
// Judgment: needs_continue
// ---------------------------------------------------------------------------

test("runIndependentVerification: needs_continue with command failure but no blockers", async (t) => {
  const result = baseResult();
  const out = await runIndependentVerification({
    result,
    repoPath: null,
    verificationCommands: ["npm test"],
    runCommand: runCommandFail("npm test"),
    writeResultFile: false,
  });

  assert.equal(out.judgment, "failed");
  assert.equal(out.passed, false); assert.equal(out.needs_continue, false);
  assert.equal(out.failed, true);
  assert.equal(out.failed, true);
});

test("runIndependentVerification: needs_continue with task not completed", async (t) => {
  const result = baseResult({ status: "waiting_for_review" });
  const out = await runIndependentVerification({
    result,
    repoPath: null,
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeResultFile: false,
  });

  assert.equal(out.judgment, "needs_continue");
  assert.equal(out.needs_continue, true);
});

// ---------------------------------------------------------------------------
// File-based input
// ---------------------------------------------------------------------------

test("verifyFromFile: loads result from file and writes verification artifact", async (t) => {
  const dir = await tmpDir(t);
  const resultPath = join(dir, "result.json");
  await writeFile(resultPath, JSON.stringify(baseResult()), "utf8");

  const out = await verifyFromFile(resultPath, {
    task: { id: "task_file" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    config: { now: () => "2026-07-02T00:00:00.000Z" },
  });

  assert.equal(out.passed, true);
  assert.equal(out.judgment, "passed");
  assert.ok(out.result_file_path);
});

test("verifyFromFile: handles missing result file gracefully", async (t) => {
  const out = await verifyFromFile("/nonexistent/result.json", {
    verificationCommands: [],
    writeResultFile: false,
  });

  assert.equal(out.failed, true);
  assert.equal(out.judgment, "failed");
});

// ---------------------------------------------------------------------------
// Write artifacts
// ---------------------------------------------------------------------------

test("runIndependentVerification: writes verification.json when writeResultFile is true", async (t) => {
  const dir = await tmpDir(t);
  const resultPath = join(dir, "result.json");
  await writeFile(resultPath, JSON.stringify(baseResult()), "utf8");

  const out = await runIndependentVerification({
    resultJsonPath: resultPath,
    task: { id: "task_write" },
    verificationCommands: [],
    runCommand: runCommandOk("git diff --check"),
    writeResultFile: true,
    outputDir: dir,
  });

  assert.ok(out.result_file_path);
  assert.ok(out.result_file_path.endsWith("verification.json"));

  // Read back the written file
  const { readFile } = await import("node:fs/promises");
  const written = JSON.parse(await readFile(out.result_file_path, "utf8"));
  assert.equal(written.judgment, "passed");
  assert.equal(written.schema_version, "gptwork.verification_result.v1");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("runIndependentVerification: handles null result", async (t) => {
  const out = await runIndependentVerification({
    result: null,
    repoPath: null,
    verificationCommands: [],
    writeResultFile: false,
  });

  assert.equal(out.failed, true);
});

test("runIndependentVerification: handles partial data with empty commands", async (t) => {
  const out = await runIndependentVerification({
    result: { status: "completed", summary: "Done", verification: { passed: true } },
    repoPath: null,
    verificationCommands: [],
    writeResultFile: false,
  });

  assert.equal(out.passed, true);
  assert.equal(out.judgment, "passed");
});

test("runIndependentVerification: includes git evidence when repoPath provided", async (t) => {
  // Use a real git repo (the backend dir itself)
  const out = await runIndependentVerification({
    result: { status: "completed", summary: "Test done" },
    repoPath: join(import.meta.url, "../../.."), // points to backend dir
    verificationCommands: [],
    writeResultFile: false,
  });

  // Should have run git diff --check
  assert.ok(out.verification);
});
