import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRunFailure, QUOTA_PATTERNS, PROMPT_LENGTH_THRESHOLD } from "../src/codex-run-diagnostics.mjs";

// ---------------------------------------------------------------------------
// A1: 429 / rate-limit / quota classification
// ---------------------------------------------------------------------------

test("classifyRunFailure: 429 in stderr returns quota_exhausted_or_rate_limited", () => {
  const result = classifyRunFailure({
    stderr: "HTTP 429 Too Many Requests\nRate limit exceeded\n",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
  assert.equal(result.severity, "recoverable");
  assert.equal(result.creates_repair_task, false);
  assert.equal(result.creates_retry_followup, true);
});

test("classifyRunFailure: 429 in stdout returns quota_exhausted_or_rate_limited", () => {
  const result = classifyRunFailure({
    stdout: '{"error": {"code": 429, "message": "rate limit exceeded"}}',
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: rate limit phrase in stderr", () => {
  const result = classifyRunFailure({
    stderr: "Error: API rate limit exceeded.",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: quota phrase in stderr", () => {
  const result = classifyRunFailure({
    stderr: "insufficient_quota: exceeded current quota",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: billing phrase in stderr", () => {
  const result = classifyRunFailure({
    stderr: "Billing threshold exceeded.",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: capacity exceeded in stderr", () => {
  const result = classifyRunFailure({
    stderr: "Capacity exceeded.",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: too many requests in stderr", () => {
  const result = classifyRunFailure({
    stderr: "Error: too many requests",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: resource exhausted in stderr", () => {
  const result = classifyRunFailure({
    stderr: "Resource exhausted.",
    exitCode: 1,
  });
  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: 429 does NOT create repair task", () => {
  const result = classifyRunFailure({
    stderr: "429 Too Many Requests",
    exitCode: 1,
  });
  assert.equal(result.creates_repair_task, false);
  assert.equal(result.creates_retry_followup, true);
  assert.ok(result.operator_action.toLowerCase().includes("wait"), "operator_action should suggest waiting, not code fixes");
  assert.ok(result.operator_action.toLowerCase().includes("retry"), "operator_action should suggest retry");
});

// ---------------------------------------------------------------------------
// A2: model_or_provider_startup_failure
// ---------------------------------------------------------------------------

test("classifyRunFailure: provider header + non-429 exit classifies as model_or_provider_startup_failure", () => {
  const result = classifyRunFailure({
    stdout: "Codex CLI v0.1.0\nModel: gpt-4o\nProvider: openai\nReasoning effort: high\n",
    stderr: "Error: Failed to connect to provider endpoint",
    exitCode: 1,
    hasResultJson: false,
  });
  assert.equal(result.failure_class, "model_or_provider_startup_failure");
  assert.equal(result.severity, "operator_action_required");
  assert.equal(result.diagnostics.model, "gpt-4o");
  assert.equal(result.diagnostics.provider, "openai");
  assert.equal(result.diagnostics.reasoning_effort, "high");
});

test("classifyRunFailure: provider header with success exit is not startup failure", () => {
  const result = classifyRunFailure({
    stdout: "Model: gpt-4o\nProvider: openai\n",
    exitCode: 0,
    hasResultJson: false,
  });
  assert.notEqual(result.failure_class, "model_or_provider_startup_failure");
});

test("classifyRunFailure: startup failure includes model/provider/reasoning_effort in diagnostics", () => {
  const result = classifyRunFailure({
    stdout: "Codex CLI v1.0\nModel: claude-sonnet-4-20250514\nAPI Provider: anthropic\nReasoning effort: max\n",
    stderr: "Error: Authentication failed",
    exitCode: 1,
    hasResultJson: false,
  });
  assert.equal(result.failure_class, "model_or_provider_startup_failure");
  assert.equal(result.diagnostics.model, "claude-sonnet-4-20250514");
  assert.equal(result.diagnostics.provider, "anthropic");
  assert.equal(result.diagnostics.reasoning_effort, "max");
});

test("classifyRunFailure: startup failure has exit_code, stderr_tail, execution_cwd in diagnostics", () => {
  const result = classifyRunFailure({
    stdout: "Codex CLI v1.0\nModel: gpt-4o\nProvider: openai\n",
    stderr: "Error: Failed to start",
    exitCode: 1,
    hasResultJson: false,
    executionCwd: "/tmp/test-workspace",
    resultJsonPath: "/tmp/test-workspace/.codex/result.json",
  });
  assert.equal(result.failure_class, "model_or_provider_startup_failure");
  assert.equal(result.diagnostics.exit_code, 1);
  assert.ok(result.diagnostics.stderr_tail);
  assert.equal(result.diagnostics.execution_cwd, "/tmp/test-workspace");
  assert.equal(result.diagnostics.result_json_path, "/tmp/test-workspace/.codex/result.json");
});

test("classifyRunFailure: explicit model/provider extracted from CLI header", () => {
  const result = classifyRunFailure({
    stdout: "Codex CLI v1.0\nModel: gpt-4o\n",
    stderr: "Error: Connection refused",
    exitCode: 1,
    hasResultJson: false,
  });
  assert.equal(result.failure_class, "model_or_provider_startup_failure");
  assert.equal(result.diagnostics.model, "gpt-4o");
});

// ---------------------------------------------------------------------------
// A3: no_result_json_no_changes
// ---------------------------------------------------------------------------

test("classifyRunFailure: no result.json, no stdout/stderr, with exitCode -> no_result_json_no_changes", () => {
  const result = classifyRunFailure({
    stdout: "",
    stderr: "",
    exitCode: 1,
    hasResultJson: false,
    hasCommit: false,
    hasGitChanges: false,
  });
  assert.equal(result.failure_class, "no_result_json_no_changes");
  assert.equal(result.severity, "failed");
});

test("classifyRunFailure: no result.json but has stderr does not go to no_result_json_no_changes", () => {
  const result = classifyRunFailure({
    stderr: "something happened",
    exitCode: 1,
    hasResultJson: false,
  });
  assert.notEqual(result.failure_class, "no_result_json_no_changes");
});

// ---------------------------------------------------------------------------
// A4: no_result_json_with_git_changes
// ---------------------------------------------------------------------------

test("classifyRunFailure: no result.json but dirty worktree -> no_result_json_with_git_changes", () => {
  const result = classifyRunFailure({
    stdout: "",
    stderr: "",
    exitCode: 1,
    hasResultJson: false,
    hasCommit: false,
    hasGitChanges: true,
  });
  assert.equal(result.failure_class, "no_result_json_with_git_changes");
  assert.equal(result.severity, "recoverable");
});

// ---------------------------------------------------------------------------
// A5: no_result_json_with_commit
// ---------------------------------------------------------------------------

test("classifyRunFailure: no result.json but commit exists -> no_result_json_with_commit", () => {
  const result = classifyRunFailure({
    stdout: "",
    stderr: "",
    exitCode: 1,
    hasResultJson: false,
    hasCommit: true,
    hasGitChanges: false,
  });
  assert.equal(result.failure_class, "no_result_json_with_commit");
  assert.equal(result.severity, "recoverable");
});

// ---------------------------------------------------------------------------
// A6: needs_task_splitting
// ---------------------------------------------------------------------------

test("classifyRunFailure: long prompt over threshold -> needs_task_splitting", () => {
  const result = classifyRunFailure({
    promptLength: PROMPT_LENGTH_THRESHOLD + 1,
    contextLength: 0,
    hasResultJson: false,
    hasCommit: false,
  });
  assert.equal(result.failure_class, "needs_task_splitting");
  assert.equal(result.severity, "warning");
});

test("classifyRunFailure: context length over threshold -> needs_task_splitting", () => {
  const result = classifyRunFailure({
    promptLength: 0,
    contextLength: PROMPT_LENGTH_THRESHOLD + 5000,
    hasResultJson: false,
    hasCommit: false,
  });
  assert.equal(result.failure_class, "needs_task_splitting");
});

test("classifyRunFailure: needs_task_splitting only when no result.json/commit", () => {
  const result = classifyRunFailure({
    promptLength: PROMPT_LENGTH_THRESHOLD + 1,
    hasResultJson: true,
    resultJson: { status: "completed" },
    hasCommit: true,
  });
  assert.notEqual(result.failure_class, "needs_task_splitting");
});

test("classifyRunFailure: needs_task_splitting has prompt_length, context_length in diagnostics", () => {
  const result = classifyRunFailure({
    promptLength: PROMPT_LENGTH_THRESHOLD + 100,
    contextLength: 5000,
    hasResultJson: false,
    hasCommit: false,
  });
  assert.equal(result.failure_class, "needs_task_splitting");
  assert.equal(result.diagnostics.prompt_length, PROMPT_LENGTH_THRESHOLD + 100);
  assert.equal(result.diagnostics.context_length, 5000);
  assert.equal(result.diagnostics.threshold, PROMPT_LENGTH_THRESHOLD);
});

// ---------------------------------------------------------------------------
// Fallback: codex_failed
// ---------------------------------------------------------------------------

test("classifyRunFailure: unclassified failure falls back to codex_failed", () => {
  const result = classifyRunFailure({
    stdout: "Some output",
    stderr: "Some error",
    exitCode: 1,
    hasResultJson: false,
    hasCommit: false,
    hasGitChanges: false,
  });
  assert.equal(result.failure_class, "codex_failed");
});

test("classifyRunFailure: codex_failed has diagnostics with exit_code", () => {
  const result = classifyRunFailure({
    stdout: "Some output that doesn't match",
    stderr: "generic failure",
    exitCode: 137,
    hasResultJson: false,
    hasCommit: false,
    hasGitChanges: false,
  });
  assert.equal(result.failure_class, "codex_failed");
  assert.equal(result.diagnostics.exit_code, 137);
});

// ---------------------------------------------------------------------------
// Edge cases and default values
// ---------------------------------------------------------------------------

test("classifyRunFailure: empty input returns codex_failed", () => {
  const result = classifyRunFailure({});
  assert.equal(result.failure_class, "codex_failed");
});

test("classifyRunFailure: null/undefined input returns codex_failed", () => {
  const result = classifyRunFailure();
  assert.equal(result.failure_class, "codex_failed");
});

test("classifyRunFailure: result.json present falls through to codex_failed", () => {
  const result = classifyRunFailure({
    hasResultJson: true,
    resultJson: { status: "completed" },
    exitCode: 0,
  });
  assert.equal(result.failure_class, "codex_failed");
});

// ---------------------------------------------------------------------------
// QUOTA_PATTERNS exports
// ---------------------------------------------------------------------------

test("QUOTA_PATTERNS is exported as an array", () => {
  assert.ok(Array.isArray(QUOTA_PATTERNS));
  assert.ok(QUOTA_PATTERNS.length > 0);
});

test("PROMPT_LENGTH_THRESHOLD is exported as a number", () => {
  assert.equal(typeof PROMPT_LENGTH_THRESHOLD, "number");
  assert.ok(PROMPT_LENGTH_THRESHOLD > 0);
});
