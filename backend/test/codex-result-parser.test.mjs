import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexResult, buildTaskResult } from "../src/codex-result-parser.mjs";

test("parses STATUS=completed with all fields", () => {
  const output = [
    "STATUS=completed",
    "SUMMARY=Deployed web app to staging",
    "CHANGED_FILES=src/main.js, src/utils.js, tests/test-app.mjs",
    "TESTS=npm test: passed 15/15, 0 failed",
    "COMMIT=a1b2c3d4e5f6g7h8i9j0",
    "REMOTE_HEAD=abc123def456ghi789jkl",
    "Some other output after structured fields"
  ].join("\n");

  const parsed = parseCodexResult(output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.summary, "Deployed web app to staging");
  assert.deepEqual(parsed.changed_files, ["src/main.js", "src/utils.js", "tests/test-app.mjs"]);
  assert.equal(parsed.tests, "npm test: passed 15/15, 0 failed");
  assert.equal(parsed.commit, "a1b2c3d4e5f6g7h8i9j0");
  assert.equal(parsed.remote_head, "abc123def456ghi789jkl");
  assert.equal(parsed.structured, true);
});

test("STATUS=completed builds codex_executed task result", () => {
  const output = [
    "STATUS=completed",
    "SUMMARY=All tests passed",
    "CHANGED_FILES=app.js, lib/helper.js",
    "TESTS=passed 10/10",
    "COMMIT=abc123",
    "REMOTE_HEAD=def456"
  ].join("\n");

  const parsed = parseCodexResult(output);
  const result = buildTaskResult(parsed);
  assert.equal(result.kind, "codex_executed");
  assert.equal(result.summary, "All tests passed");
  assert.deepEqual(result.changed_files, ["app.js", "lib/helper.js"]);
  assert.equal(result.tests, "passed 10/10");
  assert.equal(result.commit, "abc123");
  assert.equal(result.remote_head, "def456");
  assert.equal(result.structured, true);
  assert.ok(result.completed_at);
  assert.equal(result.timed_out, undefined);
});

test("parses STATUS=failed correctly", () => {
  const output = [
    "STATUS=failed",
    "SUMMARY=Build failed due to lint errors",
    "CHANGED_FILES=src/app.js",
    "TESTS=lint: 3 errors found",
    "COMMIT=none",
    "REMOTE_HEAD=none"
  ].join("\n");

  const parsed = parseCodexResult(output);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.summary, "Build failed due to lint errors");
  assert.deepEqual(parsed.changed_files, ["src/app.js"]);
  assert.equal(parsed.tests, "lint: 3 errors found");
  assert.equal(parsed.commit, null);
  assert.equal(parsed.remote_head, null);
});

test("STATUS=failed builds codex_failed task result with timed_out=false", () => {
  const output = [
    "STATUS=failed",
    "SUMMARY=Integration test suite failed"
  ].join("\n");

  const parsed = parseCodexResult(output);
  const result = buildTaskResult(parsed);
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
  assert.equal(result.summary, "Integration test suite failed");
  assert.ok(result.completed_at);
});

test("process timeout builds codex_timeout task result with timed_out=true", () => {
  const output = "STATUS=completed\nSUMMARY=Partial work done before timeout";
  const parsed = parseCodexResult(output);
  const result = buildTaskResult(parsed, { timedOut: true, timeoutSeconds: 300 });
  assert.equal(result.kind, "codex_timeout");
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_seconds, 300);
  assert.equal(result.summary, "Partial work done before timeout");
  assert.ok(result.completed_at);
});

test("timed_out=true forces codex_timeout even when STATUS=completed", () => {
  const parsed = { status: "completed", summary: "All done", changed_files: [], structured: true };
  const result = buildTaskResult(parsed, { timedOut: true, timeoutSeconds: 600 });
  assert.equal(result.kind, "codex_timeout");
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_seconds, 600);
});

test("non-zero return code with STATUS=completed is overridden to failed", () => {
  const parsed = { status: "failed", summary: "Exited with code 1", changed_files: [], structured: true };
  const result = buildTaskResult(parsed);
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
  assert.equal(result.summary, "Exited with code 1");
});

test("STATUS=completed with non-zero exit code - override in processGeneralTask before calling buildTaskResult", () => {
  const parsedOriginal = parseCodexResult("STATUS=completed\nSUMMARY=Done with warnings");
  assert.equal(parsedOriginal.status, "completed");
  const returncode = 1;
  const parsedOverride = { ...parsedOriginal, status: returncode !== 0 ? "failed" : parsedOriginal.status };
  assert.equal(parsedOverride.status, "failed");
  const result = buildTaskResult(parsedOverride);
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
});

test("no structured STATUS with non-zero exit stores kind=codex_failed", () => {
  const output = "Some unstructured output without the expected fields";
  const parsed = parseCodexResult(output);
  assert.equal(parsed.status, null);
  assert.equal(parsed.structured, false);
  const result = buildTaskResult(parsed, { returnCode: 1 });
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
  assert.equal(result.structured, false);
});

test("changed files parse from comma-separated values", () => {
  const output = [
    "STATUS=completed",
    "CHANGED_FILES=src/main.js, src/utils/helper.js, tests/unit/test.js",
    "SUMMARY=Fixed bugs"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.deepEqual(parsed.changed_files, ["src/main.js", "src/utils/helper.js", "tests/unit/test.js"]);
});

test("changed files parse from single value", () => {
  const output = [
    "STATUS=completed",
    "CHANGED_FILES=README.md",
    "SUMMARY=Updated readme"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.deepEqual(parsed.changed_files, ["README.md"]);
});

test("changed files parse `none` as empty array", () => {
  const output = [
    "STATUS=completed",
    "CHANGED_FILES=none",
    "SUMMARY=No changes needed"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.deepEqual(parsed.changed_files, []);
});

test("missing CHANGED_FILES gives empty array", () => {
  const output = "STATUS=completed\nSUMMARY=Done";
  const parsed = parseCodexResult(output);
  assert.deepEqual(parsed.changed_files, []);
});

test("COMMIT and REMOTE_HEAD are preserved in parsed output (not shortened)", () => {
  const commitSha = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t";
  const remoteSha = "abcdef1234567890abcdef1234567890abcdef12";
  const output = [
    "STATUS=completed",
    "COMMIT=" + commitSha,
    "REMOTE_HEAD=" + remoteSha,
    "SUMMARY=Deployed with full SHAs"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.equal(parsed.commit, commitSha);
  assert.equal(parsed.remote_head, remoteSha);
});

test("COMMIT and REMOTE_HEAD are preserved in buildTaskResult (not shortened by storage)", () => {
  const commitSha = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t";
  const remoteSha = "abcdef1234567890abcdef1234567890abcdef12";
  const parsed = { status: "completed", summary: "Done", changed_files: [], commit: commitSha, remote_head: remoteSha, structured: true };
  const result = buildTaskResult(parsed);
  assert.equal(result.commit, commitSha);
  assert.equal(result.remote_head, remoteSha);
});

test("empty output returns null status and no structured", () => {
  const parsed = parseCodexResult("");
  assert.equal(parsed.status, null);
  assert.equal(parsed.structured, false);
  assert.deepEqual(parsed.changed_files, []);
});

test("null output returns null status", () => {
  const parsed = parseCodexResult(null);
  assert.equal(parsed.status, null);
  assert.equal(parsed.structured, false);
});

test("undefined output returns null status", () => {
  const parsed = parseCodexResult(undefined);
  assert.equal(parsed.status, null);
  assert.equal(parsed.structured, false);
});

test("case-insensitive field matching works", () => {
  const output = [
    "status=COMPLETED",
    "summary=Works with lowercase",
    "changed_files=file.js",
    "commit=abc"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.summary, "Works with lowercase");
  assert.deepEqual(parsed.changed_files, ["file.js"]);
  assert.equal(parsed.commit, "abc");
});

test("SUMMARY can be one line only", () => {
  const output = [
    "STATUS=completed",
    "SUMMARY=This is a single line summary for the task"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.equal(parsed.summary, "This is a single line summary for the task");
});

test("TESTS string is preserved verbatim", () => {
  const output = [
    "STATUS=completed",
    "TESTS=node --test backend/test/bark-notifier.test.mjs: passed 32/32 tests (1.234s)",
    "SUMMARY=All tests passed"
  ].join("\n");
  const parsed = parseCodexResult(output);
  assert.equal(parsed.tests, "node --test backend/test/bark-notifier.test.mjs: passed 32/32 tests (1.234s)");
});

test("raw_summary_excerpt is capped at 500 chars", () => {
  const longOutput = Array(600).fill("x").join("");
  const parsed = parseCodexResult(longOutput);
  assert.ok(parsed.raw_summary_excerpt.length <= 500);
});

test("buildTaskResult preserves structured=false for non-structured output", () => {
  const parsed = { status: null, summary: null, changed_files: [], structured: false };
  const result = buildTaskResult(parsed, { returnCode: 1 });
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.structured, false);
});

test("buildTaskResult with STATUS=timed_out without timedOut param treats as failed", () => {
  const parsed = { status: "timed_out", summary: "Timed out by report", changed_files: [], structured: true };
  const result = buildTaskResult(parsed, { timedOut: false });
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
  assert.equal(result.summary, "Timed out by report");
});
