import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeExecutionIntent,
  OPERATION_KINDS,
  MUTATION_SCOPES,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from "../../src/execution-core/execution-intent-schema.mjs";

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

test("OPERATION_KINDS includes all expected kinds", () => {
  assert.ok(Array.isArray(OPERATION_KINDS));
  assert.ok(OPERATION_KINDS.includes("code_change"));
  assert.ok(OPERATION_KINDS.includes("docs_change"));
  assert.ok(OPERATION_KINDS.includes("test_only"));
  assert.ok(OPERATION_KINDS.includes("question"));
  assert.ok(OPERATION_KINDS.includes("diagnostic"));
  assert.ok(OPERATION_KINDS.includes("code_review"));
  assert.ok(OPERATION_KINDS.includes("planning"));
  assert.ok(OPERATION_KINDS.includes("config_change"));
  assert.ok(OPERATION_KINDS.includes("runtime_operation"));
  assert.ok(OPERATION_KINDS.includes("external_operation"));
  assert.equal(OPERATION_KINDS.length, 10);
});

test("MUTATION_SCOPES includes expected scopes", () => {
  assert.ok(Array.isArray(MUTATION_SCOPES));
  assert.ok(MUTATION_SCOPES.includes("none"));
  assert.ok(MUTATION_SCOPES.includes("repo"));
  assert.ok(MUTATION_SCOPES.includes("filesystem"));
  assert.ok(MUTATION_SCOPES.includes("runtime"));
  assert.ok(MUTATION_SCOPES.includes("external_system"));
  assert.equal(MUTATION_SCOPES.length, 5);
});

test("DEFAULT_MAX_CONTEXT_TOKENS is 1,310,720", () => {
  assert.equal(DEFAULT_MAX_CONTEXT_TOKENS, 1_310_720);
});

// ---------------------------------------------------------------------------
// normalizeExecutionIntent validation
// ---------------------------------------------------------------------------

test("throws when request_text is missing", () => {
  assert.throws(() => normalizeExecutionIntent({}), /request_text is required/);
  assert.throws(() => normalizeExecutionIntent(), /request_text is required/);
  assert.throws(() => normalizeExecutionIntent({ request_text: "" }), /request_text is required/);
  assert.throws(() => normalizeExecutionIntent({ request_text: "   " }), /request_text is required/);
});

test("throws when request_text is null or non-string", () => {
  assert.throws(() => normalizeExecutionIntent({ request_text: null }), /request_text is required/);
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

test("fills defaults for fields not provided", () => {
  const intent = normalizeExecutionIntent({ request_text: "hello" });

  assert.ok(intent.id.startsWith("intent_"), `id should start with 'intent_', got ${intent.id}`);
  assert.equal(intent.request_text, "hello");
  assert.equal(intent.operation_kind, null);
  assert.equal(intent.mutation_scope, "none");
  assert.equal(intent.goal_id, null);
  assert.equal(intent.task_id, null);
  assert.equal(intent.workstream_id, null);
  assert.deepEqual(intent.expected_outputs, []);
  assert.deepEqual(intent.constraints, {});
  assert.equal(intent.acceptance_profile, null);
  assert.equal(intent.execution_policy.preferred_provider, "codex_tui");
  assert.equal(intent.execution_policy.fallback_allowed, false);
  assert.equal(intent.execution_policy.interaction_mode, "automatic");
  assert.equal(intent.execution_policy.max_attempts, 3);
  assert.equal(intent.context_policy.max_tokens, DEFAULT_MAX_CONTEXT_TOKENS);
  assert.equal(intent.context_policy.retrieval_mode, "indexed");
  assert.equal(intent.context_policy.include_history, true);
  assert.equal(typeof intent.created_at, "string");
});

// ---------------------------------------------------------------------------
// Explicit fields
// ---------------------------------------------------------------------------

test("preserves explicitly provided fields", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Add user login feature",
    id: "intent_custom_001",
    operation_kind: "code_change",
    mutation_scope: "repo",
    goal_id: "goal_abc",
    task_id: "task_xyz",
    workstream_id: "ws_123",
    expected_outputs: ["diff", "commit_sha"],
    constraints: { max_files: 5 },
    acceptance_profile: "code_change",
    execution_policy: {
      preferred_provider: "codex_tui",
      fallback_allowed: false,
      interaction_mode: "interactive",
      max_attempts: 5,
    },
    context_policy: {
      max_tokens: 500_000,
      retrieval_mode: "hybrid",
      include_history: false,
    },
    created_at: "2026-07-18T00:00:00.000Z",
  });

  assert.equal(intent.id, "intent_custom_001");
  assert.equal(intent.request_text, "Add user login feature");
  assert.equal(intent.operation_kind, "code_change");
  assert.equal(intent.mutation_scope, "repo");
  assert.equal(intent.goal_id, "goal_abc");
  assert.equal(intent.task_id, "task_xyz");
  assert.equal(intent.workstream_id, "ws_123");
  assert.deepEqual(intent.expected_outputs, ["diff", "commit_sha"]);
  assert.deepEqual(intent.constraints, { max_files: 5 });
  assert.equal(intent.acceptance_profile, "code_change");
  assert.equal(intent.execution_policy.preferred_provider, "codex_tui");
  assert.equal(intent.execution_policy.fallback_allowed, false);
  assert.equal(intent.execution_policy.interaction_mode, "interactive");
  assert.equal(intent.execution_policy.max_attempts, 5);
  assert.equal(intent.context_policy.max_tokens, 500_000);
  assert.equal(intent.context_policy.retrieval_mode, "hybrid");
  assert.equal(intent.context_policy.include_history, false);
  assert.equal(intent.created_at, "2026-07-18T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// operation_kind validation
// ---------------------------------------------------------------------------

test("accepts valid operation_kind", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Run tests",
    operation_kind: "test_only",
  });
  assert.equal(intent.operation_kind, "test_only");
});

test("rejects invalid operation_kind by setting to null", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Do something",
    operation_kind: "invalid_kind",
  });
  assert.equal(intent.operation_kind, null);
});

// ---------------------------------------------------------------------------
// mutation_scope validation
// ---------------------------------------------------------------------------

test("accepts valid mutation_scope", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Deploy service",
    mutation_scope: "runtime",
  });
  assert.equal(intent.mutation_scope, "runtime");
});

test("defaults to 'none' for invalid mutation_scope", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Deploy service",
    mutation_scope: "invalid_scope",
  });
  assert.equal(intent.mutation_scope, "none");
});

// ---------------------------------------------------------------------------
// acceptance_profile fallback
// ---------------------------------------------------------------------------

test("falls back acceptance_profile to operation_kind when not provided", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Fix bug",
    operation_kind: "code_change",
  });
  assert.equal(intent.acceptance_profile, "code_change");
});

test("acceptance_profile stays null when neither provided", () => {
  const intent = normalizeExecutionIntent({ request_text: "Hello" });
  assert.equal(intent.acceptance_profile, null);
});

// ---------------------------------------------------------------------------
// execution_policy edge cases
// ---------------------------------------------------------------------------

test("execution_policy.max_attempts uses nullish coalescing (allows 0)", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Hello",
    execution_policy: { max_attempts: 0 },
  });
  assert.equal(intent.execution_policy.max_attempts, 0);
});

test("execution_policy defaults when partially provided", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Hello",
    execution_policy: { preferred_provider: "codex_exec" },
  });
  assert.equal(intent.execution_policy.preferred_provider, "codex_exec");
  assert.equal(intent.execution_policy.fallback_allowed, false);
  assert.equal(intent.execution_policy.interaction_mode, "automatic");
  assert.equal(intent.execution_policy.max_attempts, 3);
});

test("execution_policy.fallback_allowed defaults to false", () => {
  const falseVal = normalizeExecutionIntent({
    request_text: "Hello",
    execution_policy: { fallback_allowed: false },
  });
  assert.equal(falseVal.execution_policy.fallback_allowed, false);

  const undefinedVal = normalizeExecutionIntent({
    request_text: "Hello",
  });
  assert.equal(undefinedVal.execution_policy.fallback_allowed, false);
});

// ---------------------------------------------------------------------------
// context_policy edge cases
// ---------------------------------------------------------------------------

test("context_policy.include_history defaults to true", () => {
  const falseVal = normalizeExecutionIntent({
    request_text: "Hello",
    context_policy: { include_history: false },
  });
  assert.equal(falseVal.context_policy.include_history, false);

  const defaultVal = normalizeExecutionIntent({ request_text: "Hello" });
  assert.equal(defaultVal.context_policy.include_history, true);
});

// ---------------------------------------------------------------------------
// Immutability: input should not be mutated
// ---------------------------------------------------------------------------

test("normalizeExecutionIntent does not mutate the input object", () => {
  const input = { request_text: "Fix bug", execution_policy: { preferred_provider: "codex_exec" } };
  const frozen = Object.freeze(structuredClone(input));
  // If the function tries to mutate input, this will throw in strict mode
  normalizeExecutionIntent(frozen);
  assert.deepEqual(frozen.request_text, "Fix bug");
  assert.deepEqual(frozen.execution_policy.preferred_provider, "codex_exec");
});

// ---------------------------------------------------------------------------
// expected_outputs and constraints cloning
// ---------------------------------------------------------------------------

test("expected_outputs and constraints are deep-cloned", () => {
  const outputs = ["a", "b"];
  const constraints = { key: "value" };

  const intent = normalizeExecutionIntent({
    request_text: "Test",
    expected_outputs: outputs,
    constraints,
  });

  // Mutate originals
  outputs.push("c");
  constraints.key = "mutated";

  assert.deepEqual(intent.expected_outputs, ["a", "b"]);
  assert.deepEqual(intent.constraints, { key: "value" });
});
