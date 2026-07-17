import test from "node:test";
import assert from "node:assert/strict";

import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";
import { createMemoryStateStore } from "./helpers/fault-injection-harness.mjs";

test("stale command lease is recovered after worker restart", async () => {
  let now = "2026-07-17T00:00:00.000Z";
  const commandStore = createProgressionCommandStore({ store: createMemoryStateStore(), now: () => now, idFactory: () => "pcmd_restart" });
  await commandStore.createCommand({ task_id: "task_restart", decision_revision: 1, action: "advance_queue", payload: { task_id: "task_restart" } });
  await commandStore.claimNextCommand({ owner: "worker_before_restart", leaseMs: 1_000 });
  now = "2026-07-17T00:00:02.000Z";

  const recovered = await commandStore.releaseExpiredLeases();
  const claimed = await commandStore.claimNextCommand({ owner: "worker_after_restart" });
  assert.equal(recovered.length, 1);
  assert.equal(claimed.id, "pcmd_restart");
  assert.equal(claimed.attempt, 2);
});
