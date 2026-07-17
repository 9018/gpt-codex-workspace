import test from "node:test";
import assert from "node:assert/strict";

import { createProgressionCommandActuator } from "../src/progression/progression-command-actuator.mjs";
import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";
import { createFaultInjectionHarness, createMemoryStateStore } from "./helpers/fault-injection-harness.mjs";

test("duplicate delivery and replay after apply produce one external side effect", async () => {
  const harness = createFaultInjectionHarness();
  const commandStore = createProgressionCommandStore({ store: createMemoryStateStore(), idFactory: () => "pcmd_once" });
  const input = { task_id: "task_once", decision_revision: 3, action: "advance_queue", payload: { task_id: "task_once" } };
  const first = await commandStore.createCommand(input);
  const replay = await commandStore.createCommand(input);
  const actuator = createProgressionCommandActuator({
    commandStore,
    owner: "worker_1",
    handlers: { advance_queue: async () => harness.effectOnce("queue:task_once", () => ({ advanced: true })) },
  });
  await actuator.runOnce();
  await actuator.runOnce();

  assert.equal(first.created, true);
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(harness.effects(), ["queue:task_once"]);
});
