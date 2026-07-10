import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexResult, buildTaskResult, parseResultJson, parseCodexResultWithFallback } from "../src/codex-result-parser.mjs";

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

test("buildTaskResult preserves provider responses 404 as an actionable blocked result", () => {
  const stderr = "ERROR unexpected status 404 Not Found: not found, url: http://www.9017i.cc:58901/v1/responses";
  const parsed = { status: null, summary: null, changed_files: [], structured: false };
  const result = buildTaskResult(parsed, {
    returnCode: 1,
    cr: { returncode: 1, stdout: "", stderr },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.failure_class, "codex_transport_404");
  assert.equal(result.blocking_finding.code, "provider_endpoint_not_found");
  assert.match(result.next_action, /provider endpoint/i);
  assert.equal(result.pipeline_halted, true);
  assert.match(result.summary, /404 Not Found/);
});

test("buildTaskResult detects provider responses 404 after structured status is changed to failed", () => {
  const stderr = "ERROR unexpected status 404 Not Found: not found, url: http://www.9017i.cc:58901/v1/responses";
  const result = buildTaskResult({
    status: "failed",
    summary: "Codex execution reported failure",
    changed_files: [],
    structured: true,
    from_json: false,
  }, {
    returnCode: 1,
    cr: { returncode: 1, stdout: "STATUS=completed", stderr },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.failure_class, "codex_transport_404");
  assert.equal(result.blocking_finding.code, "provider_endpoint_not_found");
});

test("buildTaskResult with STATUS=timed_out without timedOut param treats as failed", () => {
  const parsed = { status: "timed_out", summary: "Timed out by report", changed_files: [], structured: true };
  const result = buildTaskResult(parsed, { timedOut: false });
  assert.equal(result.kind, "codex_failed");
  assert.equal(result.timed_out, false);
  assert.equal(result.summary, "Timed out by report");
});

// ---------------------------------------------------------------------------
// result.json parser tests
// ---------------------------------------------------------------------------


test("parseResultJson returns null for missing file", async () => {
  const result = await parseResultJson("/tmp/nonexistent-" + randomUUID() + ".json");
  assert.equal(result, null);
});

test("parseResultJson returns null for invalid file path", async () => {
  const result = await parseResultJson(null);
  assert.equal(result, null);
});

test("parseResultJson parses valid result.json", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({
    status: "completed",
    summary: "Deployed successfully",
    changed_files: ["src/main.js", "src/utils.js"],
    tests: "npm test: passed 15/15",
    commit: "abc123def456",
    remote_head: "789ghi012jkl",
    warnings: ["Minor lint warning"],
    followups: ["Update docs"],
  }));

  const result = await parseResultJson(jsonPath);
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Deployed successfully");
  assert.deepEqual(result.changed_files, ["src/main.js", "src/utils.js"]);
  assert.equal(result.tests, "npm test: passed 15/15");
  assert.equal(result.commit, "abc123def456");
  assert.equal(result.remote_head, "789ghi012jkl");
  assert.deepEqual(result.warnings, ["Minor lint warning"]);
  assert.deepEqual(result.followups, ["Update docs"]);
  assert.equal(result.structured, true);
  assert.equal(result.from_json, true);
});

test("parseResultJson extracts reviewer decision acceptance findings and next tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "result-json-acceptance-"));
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({
    status: "completed",
    summary: "done",
    changed_files: ["a.js"],
    tests: "passed",
    commit: "abc",
    remote_head: "def",
    warnings: [],
    followups: [],
    reviewer_decision: { status: "accepted", passed: true },
    acceptance_findings: [{ severity: "minor", code: "docs", message: "docs later" }],
    next_tasks: [{ priority: "P1", title: "Docs followup" }],
    repair_proposal: { repair_proposals: [] },
  }), "utf8");

  const result = await parseResultJson(jsonPath);
  assert.deepEqual(result.reviewer_decision, { status: "accepted", passed: true });
  assert.equal(result.acceptance_findings[0].severity, "minor");
  assert.equal(result.next_tasks[0].priority, "P1");
  assert.deepEqual(result.repair_proposal, { repair_proposals: [] });
});

test("parseResultJson returns null for invalid status", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({ status: "unknown" }));
  const result = await parseResultJson(jsonPath);
  assert.equal(result, null);
});

test("parseResultJson accepts failed status", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({ status: "failed", summary: "Build broke" }));
  const result = await parseResultJson(jsonPath);
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "Build broke");
});

test("parseResultJson accepts timed_out status", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({ status: "timed_out", summary: "Ran out of time" }));
  const result = await parseResultJson(jsonPath);
  assert.equal(result.status, "timed_out");
});

test("parseResultJson validates changed_files as array", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  // String changed_files should be filtered out
  await writeFile(jsonPath, JSON.stringify({
    status: "completed",
    changed_files: "src/main.js",  // not an array
  }));
  const result = await parseResultJson(jsonPath);
  assert.deepEqual(result.changed_files, []);
});

test("parseResultJson with valid array but non-string elements filters them", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({
    status: "completed",
    changed_files: ["file1.js", 42, "file2.js", null],
  }));
  const result = await parseResultJson(jsonPath);
  assert.deepEqual(result.changed_files, ["file1.js", "file2.js"]);
});

// ---------------------------------------------------------------------------
// parseCodexResultWithFallback tests
// ---------------------------------------------------------------------------

test("parseCodexResultWithFallback prefers result.json over stdout", async () => {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "result.json");
  await writeFile(jsonPath, JSON.stringify({
    status: "completed",
    summary: "From JSON",
    changed_files: ["file.json"],
    warnings: ["JSON warning"],
    followups: ["JSON followup"],
  }));

  const stdout = "STATUS=completed\nSUMMARY=From STDOUT\nCHANGED_FILES=file.txt";

  const result = await parseCodexResultWithFallback({
    resultJsonPath: jsonPath,
    stdout,
  });

  // Should prefer result.json
  assert.equal(result.summary, "From JSON");
  assert.deepEqual(result.changed_files, ["file.json"]);
  assert.deepEqual(result.warnings, ["JSON warning"]);
  assert.deepEqual(result.followups, ["JSON followup"]);
  assert.equal(result.from_json, true);
});

test("parseCodexResultWithFallback falls back to stdout when result.json missing", async () => {
  const result = await parseCodexResultWithFallback({
    resultJsonPath: "/tmp/nonexistent-" + randomUUID() + ".json",
    stdout: "STATUS=completed\nSUMMARY=From STDOUT\nCHANGED_FILES=file.txt",
  });

  assert.equal(result.summary, "From STDOUT");
  assert.deepEqual(result.changed_files, ["file.txt"]);
  assert.equal(result.from_json, false);
  assert.equal(result.structured, true);
});

test("parseCodexResultWithFallback returns stdout result when no resultJsonPath given", async () => {
  const result = await parseCodexResultWithFallback({
    stdout: "STATUS=completed\nSUMMARY=Only stdout\nTESTS=passed",
  });

  assert.equal(result.summary, "Only stdout");
  assert.equal(result.tests, "passed");
  assert.equal(result.from_json, false);
});

// ---------------------------------------------------------------------------
// buildTaskResult with warnings/followups
// ---------------------------------------------------------------------------

test("buildTaskResult propagates warnings and followups from JSON result", () => {
  const parsed = {
    status: "completed",
    summary: "Done with extras",
    changed_files: ["file.js"],
    tests: "passed",
    commit: "abc",
    remote_head: "def",
    warnings: ["Warning 1", "Warning 2"],
    followups: ["Follow up 1"],
    structured: true,
    from_json: true,
  };

  const result = buildTaskResult(parsed);
  assert.equal(result.kind, "codex_executed");
  assert.deepEqual(result.warnings, ["Warning 1", "Warning 2"]);
  assert.deepEqual(result.followups, ["Follow up 1"]);
  assert.equal(result.from_json, true);
});

test("buildTaskResult propagates acceptance agent fields", () => {
  const parsed = {
    status: "completed",
    summary: "Done",
    structured: true,
    from_json: true,
    changed_files: ["a.js"],
    tests: "passed",
    commit: "abc",
    remote_head: "def",
    warnings: [],
    followups: [],
    reviewer_decision: { status: "accepted", passed: true },
    acceptance_findings: [{ severity: "followup", code: "later", message: "later" }],
    next_tasks: [{ priority: "P2", title: "Later" }],
    repair_proposal: { source_task_id: "task_source", failed_criteria: [] },
  };

  const result = buildTaskResult(parsed);
  assert.deepEqual(result.reviewer_decision, parsed.reviewer_decision);
  assert.deepEqual(result.acceptance_findings, parsed.acceptance_findings);
  assert.deepEqual(result.next_tasks, parsed.next_tasks);
  assert.deepEqual(result.repair_proposal, parsed.repair_proposal);
});

test("buildTaskResult propagates result.json verification object", () => {
  const parsed = {
    structured: true,
    from_json: true,
    status: "completed",
    summary: "done",
    changed_files: ["src/app.mjs"],
    tests: "npm test",
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    acceptance_findings: [],
    next_tasks: [],
  };

  const result = buildTaskResult(parsed, { returnCode: 0 });

  assert.deepEqual(result.verification, parsed.verification);
});

test("buildTaskResult with failure includes warnings and followups", () => {
  const parsed = {
    status: "failed",
    summary: "Failed with warnings",
    changed_files: [],
    warnings: ["Lint error"],
    followups: ["Fix lint"],
    structured: true,
    from_json: true,
  };

  const result = buildTaskResult(parsed);
  assert.equal(result.kind, "codex_failed");
  assert.deepEqual(result.warnings, ["Lint error"]);
  assert.deepEqual(result.followups, ["Fix lint"]);
});

test("buildTaskResult handles successful unstructured no-result fallback without ReferenceError", () => {
  const parsed = parseCodexResult("Codex produced output but no structured status line");

  const result = buildTaskResult(parsed, {
    returnCode: 0,
    cr: { returncode: 0, stdout: "Codex produced output but no structured status line", stderr: "" },
  });

  assert.equal(result.kind, "codex_failed");
  assert.equal(result.failure_class, "result_missing");
  assert.equal(result.repairable, false);
  assert.equal(result.retryable, true);
  assert.equal(result.noop, true);
  assert.ok(result.diagnostics);
});

test("buildTaskResult classifies structured no-result/no-diff completed output as retryable result_missing", () => {
  const parsed = parseCodexResult([
    "STATUS=completed",
    "SUMMARY=No-op: Codex execution completed with no changes",
    "CHANGED_FILES=none",
    "COMMIT=none",
    "REMOTE_HEAD=none",
  ].join("\n"));

  const result = buildTaskResult(parsed, {
    returnCode: 0,
    cr: { returncode: 0, stdout: "STATUS=completed", stderr: "" },
  });

  assert.equal(result.kind, "codex_failed");
  assert.equal(result.failure_class, "result_missing");
  assert.equal(result.repairable, false);
  assert.equal(result.retryable, true);
});

test("buildTaskResult timeout includes warnings and followups", () => {
  const parsed = {
    status: "completed",
    summary: "Partial before timeout",
    changed_files: ["partial.js"],
    warnings: ["Timed out"],
    followups: ["Retry"],
    structured: true,
    from_json: true,
  };

  const result = buildTaskResult(parsed, { timedOut: true, timeoutSeconds: 300 });
  assert.equal(result.kind, "codex_timeout");
  assert.deepEqual(result.warnings, ["Timed out"]);
  assert.deepEqual(result.followups, ["Retry"]);
  assert.deepEqual(result.changed_files, ["partial.js"]);
});

// ---------------------------------------------------------------------------
// stdout parser unchanged contract
// ---------------------------------------------------------------------------

test("stdout parser still works without result.json", () => {
  // This test ensures the existing stdout parser contract is unchanged.
  // It imports from the same module and verifies the old behavior still works.
  const output = "STATUS=completed\nSUMMARY=Legacy parse\nCHANGED_FILES=a.js, b.js";
  const parsed = parseCodexResult(output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.summary, "Legacy parse");
  assert.deepEqual(parsed.changed_files, ["a.js", "b.js"]);
  assert.equal(parsed.from_json, false);
  assert.equal(parsed.structured, true);
});

console.log("result.json parser tests loaded");
