import test from "node:test";
import assert from "node:assert/strict";

import {
  validateExecutionRequest,
  normalizeExecutionRequest,
  EXECUTION_PROVIDERS,
} from "../../src/executions/execution-contract.mjs";

// ---------------------------------------------------------------------------
// validateExecutionRequest - new intent-based API
// ---------------------------------------------------------------------------

test("accepts intent_id instead of task_id", () => {
  const { valid, errors } = validateExecutionRequest({ intent_id: "intent_001" });
  assert.equal(valid, true, "intent_id alone should be valid");
  assert.equal(errors.length, 0);
});

test("accepts inline intent instead of task_id", () => {
  const { valid, errors } = validateExecutionRequest({
    intent: { id: "intent_001", request_text: "hello" },
  });
  assert.equal(valid, true, "inline intent should be valid");
  assert.equal(errors.length, 0);
});

test("rejects missing both intent_id and task_id", () => {
  const { valid, errors } = validateExecutionRequest({});
  assert.equal(valid, false, "must have intent_id, intent, or task_id");
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("intent_id"), "error should mention intent_id");
});

test("accepts legacy task_id + provider", () => {
  const { valid, errors } = validateExecutionRequest({
    task_id: "task_001",
    provider: "codex_exec",
  });
  assert.equal(valid, true, "legacy format should still work");
});

test("rejects invalid provider", () => {
  const { valid, errors } = validateExecutionRequest({
    intent_id: "intent_001",
    provider: "unsupported_provider",
  });
  assert.equal(valid, false, "unsupported provider should fail");
});

test("accepts 'auto' provider", () => {
  const result = validateExecutionRequest({
    intent_id: "intent_001",
    execution_policy: { preferred_provider: "auto" },
  });
  assert.equal(result.valid, true, "'auto' provider is valid");
});

test("accepts execution_policy.preferred_provider", () => {
  const result = validateExecutionRequest({
    intent_id: "intent_001",
    execution_policy: { preferred_provider: "codex_tui" },
  });
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// normalizeExecutionRequest
// ---------------------------------------------------------------------------

test("normalizeExecutionRequest extracts intent_id", () => {
  const req = normalizeExecutionRequest({ intent: { id: "intent_001" } });
  assert.equal(req.intent_id, "intent_001");
  assert.equal(req.intent.id, "intent_001");
});

test("normalizeExecutionRequest uses execution_policy", () => {
  const req = normalizeExecutionRequest({
    intent_id: "intent_001",
    execution_policy: { preferred_provider: "codex_tui", fallback_allowed: false },
  });
  assert.equal(req.execution_policy.preferred_provider, "codex_tui");
  assert.equal(req.execution_policy.fallback_allowed, false);
});

test("normalizeExecutionRequest falls back to provider field", () => {
  const req = normalizeExecutionRequest({ task_id: "task_001", provider: "codex_exec" });
  assert.equal(req.execution_policy.preferred_provider, "codex_exec");
});

test("normalizeExecutionRequest sets task_id to null when not provided", () => {
  const req = normalizeExecutionRequest({ intent_id: "intent_001" });
  assert.equal(req.task_id, null);
});
