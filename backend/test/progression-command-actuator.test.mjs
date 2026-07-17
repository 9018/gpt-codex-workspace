import test from "node:test";
import assert from "node:assert/strict";

import { createProgressionCommandActuator } from "../src/progression/progression-command-actuator.mjs";
import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";

function createStore() {
  const state = {};
  return {
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

test("progression actuator runs exactly one registered effect and persists its result", async () => {
  const commandStore = createProgressionCommandStore({ store: createStore(), idFactory: () => "pcmd_act" });
  await commandStore.createCommand({
    task_id: "task_1",
    decision_revision: 1,
    action: "complete_task",
    payload: { task_id: "task_1", unified_decision: { status: "completed" } },
  });

  const calls = [];
  const actuator = createProgressionCommandActuator({
    commandStore,
    owner: "actuator_a",
    handlers: {
      async complete_task(command) {
        calls.push(command.id);
        return { completed: true };
      },
    },
    getCurrentDecisionRevision: async () => 1,
  });

  const report = await actuator.runOnce();
  assert.deepEqual(calls, ["pcmd_act"]);
  assert.equal(report.applied, 1);
  assert.equal(report.failed, 0);
  assert.equal((await commandStore.getCommand("pcmd_act")).status, "applied");
});

test("progression actuator notifies after a command is applied", async () => {
  const commandStore = createProgressionCommandStore({ store: createStore(), idFactory: () => "pcmd_hook" });
  await commandStore.createCommand({
    task_id: "task_1",
    decision_revision: 1,
    action: "complete_task",
    payload: { task_id: "task_1", unified_decision: { status: "completed" } },
  });

  const appliedEvents = [];
  const actuator = createProgressionCommandActuator({
    commandStore,
    owner: "actuator_hook",
    handlers: { complete_task: async () => ({ completed: true }) },
    getCurrentDecisionRevision: async () => 1,
    onCommandApplied: async (command) => appliedEvents.push({ id: command.id, action: command.action, status: command.status }),
  });

  const report = await actuator.runOnce();

  assert.equal(report.applied, 1);
  assert.deepEqual(appliedEvents, [{ id: "pcmd_hook", action: "complete_task", status: "applied" }]);
});
