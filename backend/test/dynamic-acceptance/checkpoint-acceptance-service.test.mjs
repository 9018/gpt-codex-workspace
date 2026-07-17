import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createSupervisorCheckpointStore } from "../../src/supervisor/supervisor-checkpoint-store.mjs";
import { createCheckpointTriggerPolicy } from "../../src/dynamic-acceptance/checkpoint-trigger-policy.mjs";
import { createCheckpointEvidenceCollector } from "../../src/dynamic-acceptance/checkpoint-evidence-collector.mjs";
import { createCheckpointHistoryStore } from "../../src/dynamic-acceptance/checkpoint-history-store.mjs";
import { createCheckpointAcceptanceService } from "../../src/dynamic-acceptance/checkpoint-acceptance-service.mjs";
test("requires all deps", () => {
  assert.throws(() => createCheckpointAcceptanceService({}), /runStore is required/);
});
test("evaluateCheckpoint triggers on no_progress and returns verdict", async () => {
  const runStore = createExecutionRunStore();
  let run = await runStore.createRun({ intent_id: "intent_001" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  const svc = createCheckpointAcceptanceService({
    runStore,
    checkpointStore: createSupervisorCheckpointStore(),
    triggerPolicy: createCheckpointTriggerPolicy(),
    evidenceCollector: createCheckpointEvidenceCollector(),
    historyStore: createCheckpointHistoryStore(),
  });
  const result = await svc.evaluateCheckpoint({ runId: run.id, progress: { no_progress: true } });
  assert.equal(result.triggered, true);
  assert.equal(result.action, "send_correction");
  assert.ok(result.verdict.trigger_source, "no_progress");
});
test("evaluateCheckpoint does not trigger when no condition met", async () => {
  const runStore = createExecutionRunStore();
  let run = await runStore.createRun({ intent_id: "intent_001" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  const svc = createCheckpointAcceptanceService({
    runStore,
    checkpointStore: createSupervisorCheckpointStore(),
    triggerPolicy: createCheckpointTriggerPolicy(),
    evidenceCollector: createCheckpointEvidenceCollector(),
    historyStore: createCheckpointHistoryStore(),
  });
  const result = await svc.evaluateCheckpoint({ runId: run.id, progress: {} });
  assert.equal(result.triggered, false);
});
