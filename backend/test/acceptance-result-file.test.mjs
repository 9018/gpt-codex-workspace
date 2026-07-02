/**
 * acceptance-result-file.test.mjs — Tests for acceptance result file operations.
 *
 * Covers:
 * - createAcceptanceResult with all three judgments
 * - write/read roundtrip
 * - Validation for invalid judgments
 * - checkAcceptanceResultFile
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAcceptanceResult,
  writeAcceptanceResultFile,
  readAcceptanceResultFile,
  checkAcceptanceResultFile,
  ACCEPTANCE_RESULT_SCHEMA_VERSION,
} from "../src/acceptance-result-file.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ar-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// createAcceptanceResult
// ---------------------------------------------------------------------------

test("createAcceptanceResult: accepted judgment", () => {
  const ar = createAcceptanceResult({
    judgment: "accepted",
    rationale: "All gates passed.",
    blockers: [],
    followups: [],
  });

  assert.equal(ar.schema_version, ACCEPTANCE_RESULT_SCHEMA_VERSION);
  assert.equal(ar.judgment, "accepted");
  assert.equal(ar.accepted, true);
  assert.equal(ar.failed, false);
  assert.equal(ar.needs_continue, false);
  assert.equal(ar.rationale, "All gates passed.");
});

test("createAcceptanceResult: failed judgment with blockers", () => {
  const ar = createAcceptanceResult({
    judgment: "failed",
    rationale: "Blockers found.",
    blockers: [{ code: "test_failure", message: "Tests failed", severity: "blocker" }],
  });

  assert.equal(ar.judgment, "failed");
  assert.equal(ar.failed, true);
  assert.equal(ar.accepted, false);
  assert.equal(ar.blockers.length, 1);
  assert.equal(ar.blockers[0].code, "test_failure");
});

test("createAcceptanceResult: needs_continue judgment with followups", () => {
  const ar = createAcceptanceResult({
    judgment: "needs_continue",
    rationale: "Follow-ups needed.",
    followups: [{ code: "lint_warning", message: "Fix lint warnings" }],
  });

  assert.equal(ar.judgment, "needs_continue");
  assert.equal(ar.needs_continue, true);
  assert.equal(ar.followups.length, 1);
  assert.equal(ar.followups[0].code, "lint_warning");
});

test("createAcceptanceResult: throws on invalid judgment", () => {
  assert.throws(() => createAcceptanceResult({ judgment: "invalid" }), {
    message: /Invalid acceptance judgment/,
  });
});

test("createAcceptanceResult: includes task and goal IDs", () => {
  const ar = createAcceptanceResult({
    judgment: "accepted",
    task_id: "task_1",
    goal_id: "goal_1",
  });
  assert.equal(ar.task_id, "task_1");
  assert.equal(ar.goal_id, "goal_1");
});

test("createAcceptanceResult: includes closure_decision when provided", () => {
  const ar = createAcceptanceResult({
    judgment: "accepted",
    closure_decision: {
      status: "auto_completed_clean",
      auto_complete_allowed: true,
      reason: "All gates passed",
    },
  });

  assert.ok(ar.closure_decision);
  assert.equal(ar.closure_decision.status, "auto_completed_clean");
  assert.equal(ar.closure_decision.auto_complete_allowed, true);
});

// ---------------------------------------------------------------------------
// write / read
// ---------------------------------------------------------------------------

test("writeAcceptanceResultFile and readAcceptanceResultFile roundtrip", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "acceptance.json");
  const ar = createAcceptanceResult({
    judgment: "accepted",
    rationale: "Done",
    task_id: "t1",
    goal_id: "g1",
  });

  await writeAcceptanceResultFile(path, ar);
  const readBack = await readAcceptanceResultFile(path);

  assert.equal(readBack.judgment, "accepted");
  assert.equal(readBack.task_id, "t1");
  assert.equal(readBack.goal_id, "g1");
  assert.equal(readBack.rationale, "Done");
  assert.equal(readBack.schema_version, ACCEPTANCE_RESULT_SCHEMA_VERSION);
});

test("readAcceptanceResultFile throws on invalid content", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ foo: "bar" }), "utf8");

  await assert.rejects(() => readAcceptanceResultFile(path), {
    message: /Invalid judgment/,
  });
});

test("readAcceptanceResultFile throws on missing file", async (t) => {
  await assert.rejects(() => readAcceptanceResultFile("/nonexistent/path.json"));
});

// ---------------------------------------------------------------------------
// checkAcceptanceResultFile
// ---------------------------------------------------------------------------

test("checkAcceptanceResultFile: valid file", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "acceptance.json");
  await writeAcceptanceResultFile(path, createAcceptanceResult({ judgment: "accepted" }));

  const result = await checkAcceptanceResultFile(path);
  assert.equal(result.exists, true);
  assert.equal(result.valid, true);
  assert.equal(result.judgment, "accepted");
});

test("checkAcceptanceResultFile: missing file", async (t) => {
  const result = await checkAcceptanceResultFile("/nonexistent/path.json");
  assert.equal(result.exists, false);
  assert.equal(result.valid, false);
});

test("checkAcceptanceResultFile: invalid content", async (t) => {
  const dir = await tmpDir(t);
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ not_valid: true }), "utf8");

  const result = await checkAcceptanceResultFile(path);
  assert.equal(result.exists, true);
  assert.equal(result.valid, false);
});
