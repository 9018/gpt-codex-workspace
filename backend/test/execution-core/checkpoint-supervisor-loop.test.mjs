import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createSupervisorCheckpointStore } from "../../src/supervisor/supervisor-checkpoint-store.mjs";
import { createCheckpointTriggerPolicy } from "../../src/dynamic-acceptance/checkpoint-trigger-policy.mjs";
import { createCheckpointEvidenceCollector } from "../../src/dynamic-acceptance/checkpoint-evidence-collector.mjs";
import { createCheckpointHistoryStore } from "../../src/dynamic-acceptance/checkpoint-history-store.mjs";
import { createCheckpointAcceptanceService } from "../../src/dynamic-acceptance/checkpoint-acceptance-service.mjs";
import { createCheckpointSupervisorLoop } from "../../src/execution-core/checkpoint-supervisor-loop.mjs";

function setupLoop(opts = {}) {
  const runStore = createExecutionRunStore(opts.runStore);
  const checkpointStore = createSupervisorCheckpointStore();
  const triggerPolicy = createCheckpointTriggerPolicy();
  const evidenceCollector = createCheckpointEvidenceCollector();
  const historyStore = createCheckpointHistoryStore();
  const acceptanceService = createCheckpointAcceptanceService({
    runStore,
    checkpointStore,
    triggerPolicy,
    evidenceCollector,
    historyStore,
    ...opts.acceptanceDeps,
  });
  return {
    runStore,
    loop: createCheckpointSupervisorLoop({
      runStore,
      checkpointStore,
      triggerPolicy,
      evidenceCollector,
      acceptanceService,
      historyStore,
      pollIntervalMs: 500,
      maxLoops: 1,
      ...opts.loop,
    }),
  };
}

test("checkpoint-supervisor-loop tick handles inactive run gracefully", async () => {
  const { runStore, loop } = setupLoop();
  const run = await runStore.createRun({ intent_id: "intent_001" });
  // Run is in "created" state, not in activeStates
  const result = await loop.tick(run.id);
  assert.equal(result.triggered, false);
});

test("checkpoint-supervisor-loop tick triggers on no_progress", async () => {
  const { runStore, loop } = setupLoop();
  let run = await runStore.createRun({ intent_id: "intent_001" });
  // Transition through to running
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  const result = await loop.tick(run.id, { progress: { no_progress: true } });
  assert.equal(result.triggered, true);
  assert.ok(result.checkpoint_id, "checkpoint should be created");
});

test("checkpoint-supervisor-loop start/stop works", async () => {
  const { runStore, loop } = setupLoop({ loop: { maxLoops: 1 } });
  let run = await runStore.createRun({ intent_id: "intent_001" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  loop.isRunning();
  setTimeout(() => loop.stop(), 100);
  await loop.start(run.id, { progress: { no_progress: true } });
  assert.equal(loop.isRunning(), false);
});
