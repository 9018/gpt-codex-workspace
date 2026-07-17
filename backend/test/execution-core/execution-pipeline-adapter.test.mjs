import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createExecutionProviderRegistry } from "../../src/execution/execution-provider-registry.mjs";
import { createExecutionPipelineAdapter } from "../../src/execution-core/execution-pipeline-adapter.mjs";
import { createExecutionRunService } from "../../src/execution-core/execution-run-service.mjs";
import { createProjectionService } from "../../src/execution-core/execution-projection-service.mjs";

/**
 * Create a mock TUI provider for testing the pipeline.
 */
function createMockTuiProvider({ collectResult = { status: "completed", summary: "All tests pass", changed_files: ["src/index.js"], tests: [] }, observeDuration = 100 } = {}) {
  let observeCount = 0;
  return {
    name: "codex_tui",
    async availability() { return true; },
    async start(attempt, context) {
      return { session_id: `sess_${attempt.id}`, native_session_id: `native_${attempt.id}` };
    },
    async resume(attempt, checkpoint) { return this.start(attempt); },
    async observe(handle) {
      observeCount++;
      if (observeCount < 2) return { state: "running" };
      return { state: "evidence_ready" };
    },
    async collect(handle) {
      return { ...collectResult };
    },
    async send() {},
    async interrupt() {},
    async dispose() {},
  };
}

// ---------------------------------------------------------------------------
// Pipeline adapter unit tests
// ---------------------------------------------------------------------------

test("pipeline adapter requires runStore and providerRegistry", () => {
  assert.throws(() => createExecutionPipelineAdapter({}), /runStore is required/);
  assert.throws(() => createExecutionPipelineAdapter({ runStore: {} }), /providerRegistry is required/);
});

test("executeProviderCycle succeeds with mock TUI provider", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register(createMockTuiProvider());

  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001" });

  const adapter = createExecutionPipelineAdapter({
    runStore,
    providerRegistry: registry,
  });

  const result = await adapter.executeProviderCycle({ run });
  assert.equal(result.kind, "evidence_ready");
  assert.ok(result.raw_evidence, "evidence should be collected");
  assert.equal(result.raw_evidence.status, "completed");
  assert.equal(result.raw_evidence.summary, "All tests pass");
});

test("executeProviderCycle returns failed when provider not registered", async () => {
  const registry = createExecutionProviderRegistry();
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001" });
  // Don't register any providers

  const adapter = createExecutionPipelineAdapter({ runStore, providerRegistry: registry });
  const result = await adapter.executeProviderCycle({ run });
  assert.equal(result.kind, "failed");
  assert.ok(result.failure.code, "provider_unavailable");
});

// ---------------------------------------------------------------------------
// Full pipeline integration tests
// ---------------------------------------------------------------------------

test("runPipelineCycle completes the full pipeline: start → observe → collect → accept", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register(createMockTuiProvider());

  const runStore = createExecutionRunStore();

  // Create a run and transition it to ready
  let run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001" });
  // Update the run's supervision to use native_tui
  run = await runStore.updateRun(run.id, {
    supervision: { execution_mode: "native_tui", controller_owner: "workmcp_autopilot" },
  });

  const adapter = createExecutionPipelineAdapter({
    runStore,
    providerRegistry: registry,
    acceptanceService: {
      async evaluate({ run, intent, evidence }) {
        return { decision: "accepted", summary: "Good", id: "decision_001" };
      },
    },
    projectionService: createProjectionService(),
  });

  const result = await adapter.runPipelineCycle({ run });
  assert.equal(result.pipeline_complete, true);
  assert.equal(result.final_state, "completed");
});

test("runPipelineCycle returns repair_required when acceptance fails", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register(createMockTuiProvider());

  const runStore = createExecutionRunStore();
  let run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001" });
  run = await runStore.updateRun(run.id, {
    supervision: { execution_mode: "native_tui", controller_owner: "workmcp_autopilot" },
  });

  const adapter = createExecutionPipelineAdapter({
    runStore,
    providerRegistry: registry,
    acceptanceService: {
      async evaluate({ run, intent, evidence }) {
        return { decision: "repair_required", summary: "Missing commit", missing_items: ["commit_sha"] };
      },
    },
    projectionService: createProjectionService(),
  });

  const result = await adapter.runPipelineCycle({ run });
  assert.equal(result.pipeline_complete, true);
  assert.equal(result.final_state, "waiting_for_repair");
});

// ---------------------------------------------------------------------------
// Existing execution-core tests still pass
// ---------------------------------------------------------------------------

test("existing run service advanceRun works with acceptance service", async () => {
  const runStore = createExecutionRunStore();
  const svc = createExecutionRunService({
    runStore,
    projectionService: createProjectionService(),
    acceptanceService: {
      async evaluate() {
        return { decision: "accepted", summary: "default", id: "dec_test" };
      },
    },
  });

  const { run } = await svc.start({ intent_id: "intent_001" });
  const result = await svc.advanceRun(run.id);
  assert.equal(result.run.state, "completed");
});

test("pipeline adapter can be used as attemptOrchestrator by run service", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register(createMockTuiProvider());

  const runStore = createExecutionRunStore();
  const adapter = createExecutionPipelineAdapter({
    runStore,
    providerRegistry: registry,
    acceptanceService: {
      async evaluate({ run, intent, evidence }) {
        return { decision: "accepted", summary: "Pipeline complete", id: "decision_pipe_001" };
      },
    },
    projectionService: createProjectionService(),
  });

  const svc = createExecutionRunService({
    runStore,
    projectionService: createProjectionService(),
    acceptanceService: {
      async evaluate() {
        return { decision: "accepted", summary: "pipeline accept", id: "pipe_dec" };
      },
    },
    attemptOrchestrator: { execute: adapter.executeProviderCycle },
  });

  const { run } = await svc.start({ intent_id: "intent_001", task_id: "task_001" });
  const result = await svc.advanceRun(run.id);

  // Pipeline should have collected evidence and driven to completion
  assert.equal(result.run.state, "completed");
  assert.equal(result.outcome.kind, "completed");
});
