import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionProviderRegistry } from "../../src/execution/execution-provider-registry.mjs";
import { executeTaskViaExecutionRun } from "../../src/task-processing/execution-run-bridge.mjs";

function createMockTuiProvider() {
  let observeCount = 0;
  return {
    name: "codex_tui",
    async availability() { return true; },
    async start(attempt) { return { session_id: `sess_${attempt.id}` }; },
    async resume(attempt, cp) { return this.start(attempt); },
    async observe(handle) {
      observeCount++;
      if (observeCount < 3) return { state: "running" };
      return { state: "evidence_ready" };
    },
    async collect() { return { status: "completed", summary: "Bridge test", changed_files: ["test.js"], tests: [] }; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  };
}

test("executeTaskViaExecutionRun completes a task with TUI provider", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register(createMockTuiProvider());

  const result = await executeTaskViaExecutionRun({
    taskId: "bridge_task_001",
    goalId: "bridge_goal_001",
    provider: "codex_tui",
    context: { task: { id: "bridge_task_001" }, goal: { id: "bridge_goal_001" } },
    deps: {
      providerRegistry: registry,
      acceptanceService: {
        async evaluate() {
          return { decision: "accepted", summary: "bridge accept", id: "bridge_dec" };
        },
      },
    },
  });

  assert.ok(result.attempt, "attempt should be returned");
  assert.equal(result.attempt.task_id, "bridge_task_001");
  assert.equal(result.attempt.state, "completed");
  assert.equal(result.error, null);
});

test("executeTaskViaExecutionRun fails when provider not registered", async () => {
  const registry = createExecutionProviderRegistry();

  const result = await executeTaskViaExecutionRun({
    taskId: "bridge_task_002",
    provider: "codex_tui",
    context: { task: { id: "bridge_task_002" } },
    deps: { providerRegistry: registry },
  });

  assert.ok(result.attempt, "attempt should still be returned");
  // Should have failed because provider is not registered
  assert.ok(result.attempt.state !== "completed" || result.error !== null);
});
