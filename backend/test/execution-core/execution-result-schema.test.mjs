import test from "node:test";
import assert from "node:assert/strict";

import {
  createExecutionResult,
  validateExecutionResult,
  findMissingEvidence,
} from "../../src/execution-core/execution-result-schema.mjs";

test("createExecutionResult creates valid result with defaults", () => {
  const result = createExecutionResult({
    run_id: "run_001",
    attempt_id: "attempt_001",
    outcome: "succeeded",
    commands: [{ command: "npm test", exit_code: 0 }],
  });

  assert.equal(result.run_id, "run_001");
  assert.equal(result.attempt_id, "attempt_001");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.commit_sha, null);
  assert.equal(result.worktree_clean, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.followup_findings, []);
});

test("createExecutionResult validates required fields", () => {
  assert.throws(
    () => createExecutionResult({}),
    /Invalid ExecutionResult/
  );
});

test("validateExecutionResult rejects missing fields", () => {
  const { valid, errors } = validateExecutionResult({});
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test("validateExecutionResult accepts valid result", () => {
  const result = createExecutionResult({
    run_id: "run_001",
    attempt_id: "attempt_001",
    outcome: "succeeded",
    commands: [{ command: "echo hello", exit_code: 0 }],
  });
  const { valid, errors } = validateExecutionResult(result);
  assert.equal(valid, true);
  assert.equal(errors.length, 0);
});

test("findMissingEvidence identifies missing items", () => {
  const missing = findMissingEvidence({
    run_id: "run_001",
    attempt_id: null,
    outcome: "partial",
    changed_files: [],
    commands: [],
    commit_sha: null,
  });
  assert.ok(missing.includes("attempt_id"));
  assert.ok(missing.includes("changed_files"));
  assert.ok(missing.includes("commands"));
  assert.ok(missing.includes("commit_sha"));
});

test("findMissingEvidence returns empty for complete result", () => {
  const missing = findMissingEvidence({
    run_id: "run_001",
    attempt_id: "attempt_001",
    outcome: "succeeded",
    changed_files: ["src/main.mjs"],
    commands: [{ command: "npm test", exit_code: 0 }],
    commit_sha: "abc123",
  });
  assert.equal(missing.length, 0);
});
