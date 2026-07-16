import test from "node:test";
import assert from "node:assert/strict";

import { buildProgressionCommands } from "../src/progression/progression-command-builder.mjs";
import { createProgressionCommandActuator } from "../src/progression/progression-command-actuator.mjs";
import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";

function createStore() {
  const state = {};
  return {
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

test("completed unified decision creates durable effects and stale revisions are superseded", async () => {
  const commandStore = createProgressionCommandStore({ store: createStore() });
  const commands = buildProgressionCommands({
    task_id: "task_1",
    goal_id: "goal_1",
    revision: 4,
    status: "completed",
    safe_to_auto_advance: true,
    queue_effect: { unblock_dependents: true, hold_queue: false },
    goal_effect: { complete_goal: true },
    integration_effect: { required: false, terminal: true, satisfied: true },
  });
  assert.deepEqual(commands.map((command) => command.action), ["complete_task", "propagate_goal", "advance_queue"]);
  for (const command of commands) await commandStore.createCommand(command);

  const effects = [];
  const handlers = Object.fromEntries(commands.map(({ action }) => [action, async () => {
    effects.push(action);
    return { ok: true };
  }]));
  const actuator = createProgressionCommandActuator({
    commandStore,
    owner: "actuator_e2e",
    handlers,
    getCurrentDecisionRevision: async () => 5,
  });

  const report = await actuator.drain({ maxCommands: 10 });
  assert.equal(report.superseded, 3);
  assert.deepEqual(effects, []);
  assert.ok((await commandStore.listCommands()).every((command) => command.status === "superseded"));
});
