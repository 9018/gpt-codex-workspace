import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createProgressionEffectAdapter } from "../../src/execution-core/progression-effect-adapter.mjs";
test("requires run and decision", async () => {
  const adapter = createProgressionEffectAdapter();
  await assert.rejects(() => adapter.applyDecisionEffects({}), /run is required/);
  await assert.rejects(() => adapter.applyDecisionEffects({ run: {} }), /decision is required/);
});
test("creates completion effects for accepted decision", async () => {
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001", goal_id: "goal_001" });
  const adapter = createProgressionEffectAdapter({ runStore });
  const result = await adapter.applyDecisionEffects({
    run,
    decision: { decision: "accepted", summary: "Good" },
  });
  assert.ok(result.pending_effects.length >= 1);
  assert.equal(result.pending_effects[0].type, "complete_task");
});
test("creates repair effects for repair_required decision", async () => {
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001" });
  const adapter = createProgressionEffectAdapter({ runStore });
  const result = await adapter.applyDecisionEffects({
    run,
    decision: { decision: "repair_required", summary: "Missing commit", missing_items: ["commit_sha"] },
  });
  assert.equal(result.pending_effects[0].type, "create_repair_task");
});
test("applies effects when progression builder is available", async () => {
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001", task_id: "task_001" });
  const builderCalls = [];
  const adapter = createProgressionEffectAdapter({
    runStore,
    progressionCommandBuilder: {
      build: async (cmd) => { builderCalls.push(cmd); return { id: "cmd_001", ...cmd }; },
    },
    progressionCommandActuator: {
      execute: async (cmd) => { /* simulate success */ },
    },
  });
  const result = await adapter.applyDecisionEffects({
    run,
    decision: { decision: "accepted", summary: "Good" },
  });
  assert.equal(result.effects_applied, true);
  assert.equal(builderCalls.length, 1);
});
