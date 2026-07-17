import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyExecutionIntent,
  classifyAndNormalize,
} from "../../src/execution-core/execution-intent-classifier.mjs";

// ---------------------------------------------------------------------------
// classifyExecutionIntent
// ---------------------------------------------------------------------------

test("classifies code_change from Chinese keywords", () => {
  const result = classifyExecutionIntent({ request_text: "修改代码中的 bug" });
  assert.equal(result.operation_kind, "code_change");
  assert.equal(result.mutation_scope, "repo");
  assert.equal(result.confidence, "high");
});

test("classifies code_change from English keywords", () => {
  const result = classifyExecutionIntent({ request_text: "refactor the authentication module" });
  assert.equal(result.operation_kind, "code_change");
  assert.equal(result.mutation_scope, "repo");
  assert.equal(result.confidence, "high");
});

test("classifies code_change from 'implement' keyword", () => {
  const result = classifyExecutionIntent({ request_text: "implement pagination helper" });
  assert.equal(result.operation_kind, "code_change");
});

test("classifies docs_change from Chinese keywords", () => {
  const result = classifyExecutionIntent({ request_text: "更新文档中的 API 说明" });
  assert.equal(result.operation_kind, "docs_change");
  assert.equal(result.mutation_scope, "repo");
});

test("classifies docs_change from English keywords", () => {
  const result = classifyExecutionIntent({ request_text: "rewrite the README for clarity" });
  assert.equal(result.operation_kind, "docs_change");
});

test("classifies test_only from Chinese keywords", () => {
  const result = classifyExecutionIntent({ request_text: "运行测试代码验证功能" });
  assert.equal(result.operation_kind, "test_only");
  assert.equal(result.mutation_scope, "none");
});

test("classifies test_only from English keywords", () => {
  const result = classifyExecutionIntent({ request_text: "run tests for the payment module" });
  assert.equal(result.operation_kind, "test_only");
});

test("classifies question from Chinese keywords", () => {
  const result = classifyExecutionIntent({ request_text: "分析一下这个模块的架构" });
  assert.equal(result.operation_kind, "question");
  assert.equal(result.mutation_scope, "none");
  assert.equal(result.confidence, "medium");
});

test("classifies question from English keywords", () => {
  const result = classifyExecutionIntent({ request_text: "why does the build fail" });
  assert.equal(result.operation_kind, "question");
  assert.equal(result.confidence, "medium");
});

test("classifies code_review from English", () => {
  const result = classifyExecutionIntent({ request_text: "review the latest pull request" });
  assert.equal(result.operation_kind, "code_review");
  assert.equal(result.mutation_scope, "none");
});

test("classifies code_review from Chinese", () => {
  const result = classifyExecutionIntent({ request_text: "代码评审" });
  assert.equal(result.operation_kind, "code_review");
});

test("classifies planning from English", () => {
  const result = classifyExecutionIntent({ request_text: "design the database schema" });
  assert.equal(result.operation_kind, "planning");
  assert.equal(result.mutation_scope, "none");
  assert.equal(result.confidence, "medium");
});

test("returns low-confidence question for unrecognized input", () => {
  const result = classifyExecutionIntent({ request_text: "Good morning" });
  assert.equal(result.operation_kind, "question");
  assert.equal(result.mutation_scope, "none");
  assert.equal(result.confidence, "low");
  assert.equal(result.requires_planner_confirmation, true);
});

test("uses explicit operation_kind when provided", () => {
  const result = classifyExecutionIntent({
    request_text: "hello world",
    operation_kind: "diagnostic",
  });
  assert.equal(result.operation_kind, "diagnostic");
  assert.equal(result.mutation_scope, "none");
  assert.equal(result.confidence, "high");
});

test("infers mutation_scope for explicit repo-scoped kinds", () => {
  const result = classifyExecutionIntent({
    request_text: "change config",
    operation_kind: "config_change",
  });
  assert.equal(result.operation_kind, "config_change");
  assert.equal(result.mutation_scope, "repo");
});

test("infers mutation_scope for runtime_operation", () => {
  const result = classifyExecutionIntent({
    request_text: "restart server",
    operation_kind: "runtime_operation",
  });
  assert.equal(result.operation_kind, "runtime_operation");
  assert.equal(result.mutation_scope, "runtime");
});

test("accepts explicit mutation_scope override", () => {
  const result = classifyExecutionIntent({
    request_text: "test something",
    operation_kind: "test_only",
    mutation_scope: "repo",
  });
  assert.equal(result.mutation_scope, "repo");
});

test("falls back to low-confidence question for invalid explicit kind", () => {
  const result = classifyExecutionIntent({
    request_text: "hello",
    operation_kind: "nonexistent_kind",
  });
  assert.equal(result.operation_kind, "question");
  assert.equal(result.mutation_scope, "none");
  assert.equal(result.confidence, "low");
});

test("handles empty request_text gracefully", () => {
  const result = classifyExecutionIntent({});
  assert.equal(result.operation_kind, "question");
  assert.equal(result.confidence, "low");
  assert.equal(result.requires_planner_confirmation, true);
});

// ---------------------------------------------------------------------------
// classifyAndNormalize
// ---------------------------------------------------------------------------

test("classifyAndNormalize returns full ExecutionIntent", () => {
  const intent = classifyAndNormalize({ request_text: "implement new feature" });

  assert.ok(intent.id.startsWith("intent_"), `got ${intent.id}`);
  assert.equal(intent.request_text, "implement new feature");
  assert.equal(intent.operation_kind, "code_change");
  assert.equal(intent.mutation_scope, "repo");
  assert.equal(intent.execution_policy.preferred_provider, "codex_tui");
  assert.equal(intent.execution_policy.max_attempts, 3);
  assert.equal(intent.context_policy.max_tokens, 1_310_720);
});

test("classifyAndNormalize preserves explicit fields", () => {
  const intent = classifyAndNormalize({
    request_text: "implement new feature",
    id: "intent_custom",
    goal_id: "goal_123",
    execution_policy: { max_attempts: 1 },
  });

  assert.equal(intent.id, "intent_custom");
  assert.equal(intent.goal_id, "goal_123");
  assert.equal(intent.execution_policy.max_attempts, 1);
});
