import test from "node:test";
import assert from "node:assert/strict";

import {
  taskToExecutionIntent,
  normalizeLegacyProvider,
  runResultToLegacyDispatchResult,
  runToLegacyResult,
  mapRunStateToTaskState,
} from "../../src/execution-core/legacy-task-adapter.mjs";

// ---------------------------------------------------------------------------
// taskToExecutionIntent
// ---------------------------------------------------------------------------

test("requires task", () => {
  assert.throws(() => taskToExecutionIntent({}), /task is required/);
  assert.throws(() => taskToExecutionIntent(), /task is required/);
});

test("converts a minimal task to ExecutionIntent", () => {
  const intent = taskToExecutionIntent({
    task: { id: "task_001", request: "Fix login bug" },
  });

  assert.equal(intent.task_id, "task_001");
  assert.equal(intent.request_text, "Fix login bug");
  assert.equal(intent.operation_kind, "code_change");
  assert.equal(intent.mutation_scope, "repo");
});

test("reads request_text from various legacy fields", () => {
  const t1 = taskToExecutionIntent({ task: { id: "t1", description: "Update docs" } });
  assert.equal(t1.operation_kind, "docs_change");

  const t2 = taskToExecutionIntent({ task: { id: "t2", title: "Run tests" } });
  assert.equal(t2.operation_kind, "test_only");

  const t3 = taskToExecutionIntent({
    task: { id: "t3", metadata: { request_text: "Analyze performance" } },
  });
  assert.equal(t3.operation_kind, "question");
});

test("preserves goal_id from task and goal", () => {
  const withGoal = taskToExecutionIntent({
    task: { id: "t1", request: "Fix bug" },
    goal: { id: "goal_abc" },
  });
  assert.equal(withGoal.goal_id, "goal_abc");

  const fromTask = taskToExecutionIntent({
    task: { id: "t1", request: "Fix bug", goal_id: "goal_from_task" },
  });
  assert.equal(fromTask.goal_id, "goal_from_task");
});

test("extracts legacy provider from metadata bags", () => {
  const t1 = taskToExecutionIntent({
    task: { id: "t1", request: "Fix", metadata: { execution_provider: "codex_tui" } },
  });
  assert.equal(t1.execution_policy.preferred_provider, "codex_tui");

  const t2 = taskToExecutionIntent({
    task: { id: "t2", request: "Fix", metadata: { codex_execution_provider: "codex_exec" } },
  });
  assert.equal(t2.execution_policy.preferred_provider, "codex_exec");
});

test("extracts explicit operation_kind from task", () => {
  const intent = taskToExecutionIntent({
    task: {
      id: "t1",
      request: "Just say hello",
      operation_kind: "diagnostic",
    },
  });
  assert.equal(intent.operation_kind, "diagnostic");
  assert.equal(intent.mutation_scope, "none");
});

test("acceptance_profile falls back to operation_kind", () => {
  const intent = taskToExecutionIntent({
    task: { id: "t1", request: "Fix bug", operation_kind: "code_change" },
  });
  assert.equal(intent.acceptance_profile, "code_change");
});

test("preserves execution_policy from legacy fields", () => {
  const intent = taskToExecutionIntent({
    task: {
      id: "t1",
      request: "Fix bug",
      operation_kind: "code_change",
      execution_policy: {
        provider: "codex_tui",
        fallback_allowed: false,
        max_attempts: 5,
      },
    },
  });
  assert.equal(intent.execution_policy.preferred_provider, "codex_tui");
  assert.equal(intent.execution_policy.fallback_allowed, false);
  assert.equal(intent.execution_policy.max_attempts, 5);
});

// ---------------------------------------------------------------------------
// normalizeLegacyProvider
// ---------------------------------------------------------------------------

test("normalizeLegacyProvider handles all known aliases", () => {
  assert.equal(normalizeLegacyProvider("codex_exec"), "codex_exec");
  assert.equal(normalizeLegacyProvider("codex_tui"), "codex_tui");
  assert.equal(normalizeLegacyProvider("codex"), "codex_exec");
  assert.equal(normalizeLegacyProvider("exec"), "codex_exec");
  assert.equal(normalizeLegacyProvider("tui"), "codex_tui");
  assert.equal(normalizeLegacyProvider("claude_tui"), "codex_tui");
  assert.equal(normalizeLegacyProvider("auto"), "auto");
  assert.equal(normalizeLegacyProvider(null), "auto");
  assert.equal(normalizeLegacyProvider("unknown"), "auto");
});

// ---------------------------------------------------------------------------
// runResultToLegacyDispatchResult
// ---------------------------------------------------------------------------

test("runResultToLegacyDispatchResult produces legacy-format result", () => {
  const result = runResultToLegacyDispatchResult({
    run: { id: "run_001", task_id: "task_001", state: "running" },
    execution_id: "run_001",
  });
  assert.equal(result.execution_id, "run_001");
  assert.equal(result.started, true);
  assert.equal(result.status, "running");
});

// ---------------------------------------------------------------------------
// runToLegacyResult
// ---------------------------------------------------------------------------

test("runToLegacyResult requires run", () => {
  assert.throws(() => runToLegacyResult({}), /run is required/);
});

test("runToLegacyResult maps completed run", () => {
  const result = runToLegacyResult({
    run: { id: "run_001", task_id: "task_001", state: "completed", attempt_ids: ["a1"], failure: null },
    evidence: { id: "evb_001" },
  });
  assert.equal(result.run_id, "run_001");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.evidence.id, "evb_001");
  assert.deepEqual(result.attempt_ids, ["a1"]);
});

test("runToLegacyResult maps failed run", () => {
  const result = runToLegacyResult({
    run: { id: "run_001", task_id: "task_001", state: "failed", attempt_ids: ["a1"], failure: { code: "TIMEOUT" } },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure.code, "TIMEOUT");
});

// ---------------------------------------------------------------------------
// mapRunStateToTaskState
// ---------------------------------------------------------------------------

test("mapRunStateToTaskState maps all run states correctly", async () => {
  const { EXECUTION_RUN_STATES } = await import("../../src/execution-core/execution-run-schema.mjs");

  const expected = {
    "created": "starting",
    "planning": "starting",
    "ready": "starting",
    "running": "running",
    "correcting": "running",
    "resuming": "running",

    "collecting": "collecting",
    "evaluating": "collecting",
    "checkpointing": "waiting_for_repair",
    "waiting_for_repair": "waiting_for_repair",
    "waiting_for_review": "waiting_for_review",
    "waiting_for_supervisor": "waiting_for_supervisor",
    "waiting_for_supervisor_direct": "waiting_for_supervisor",
    "chatgpt_direct": "waiting_for_supervisor",
    "waiting_for_integration": "waiting_for_integration",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
  };

  for (const state of EXECUTION_RUN_STATES) {
    const projected = mapRunStateToTaskState({ state });
    assert.equal(projected, expected[state],
      `Run state "${state}" should project to "${expected[state]}", got "${projected}"`);
  }
});

test("mapRunStateToTaskState returns null for null/undefined", () => {
  assert.equal(mapRunStateToTaskState(null), null);
  assert.equal(mapRunStateToTaskState(), null);
});
