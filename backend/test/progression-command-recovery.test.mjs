import test from "node:test";
import assert from "node:assert/strict";

import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";

function createStore() {
  const state = {};
  return {
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

test("expired claimed command is recovered and can be claimed by another actuator", async () => {
  let now = "2026-07-17T00:00:00.000Z";
  const commandStore = createProgressionCommandStore({
    store: createStore(),
    now: () => now,
    idFactory: () => "pcmd_recover",
  });
  await commandStore.createCommand({
    task_id: "task_1",
    decision_revision: 1,
    action: "advance_queue",
    payload: { task_id: "task_1" },
  });
  await commandStore.claimNextCommand({ owner: "dead_worker", leaseMs: 1_000 });

  now = "2026-07-17T00:00:02.000Z";
  const recovered = await commandStore.releaseExpiredLeases();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "pending");

  const claimed = await commandStore.claimNextCommand({ owner: "new_worker", leaseMs: 1_000 });
  assert.equal(claimed.id, "pcmd_recover");
  assert.equal(claimed.lease.owner, "new_worker");
  assert.equal(claimed.attempt, 2);
});
