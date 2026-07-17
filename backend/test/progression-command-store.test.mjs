import test from "node:test";
import assert from "node:assert/strict";

import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";
import { PROGRESSION_ERROR_CODES, ProgressionCommandError } from "../src/progression/progression-errors.mjs";

function createStore(initial = {}) {
  const state = { progression_commands: {}, ...initial };
  return {
    state,
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

test("progression command store creates, claims, and applies a command atomically", async () => {
  const store = createStore();
  const commands = createProgressionCommandStore({
    store,
    now: () => "2026-07-17T00:00:00.000Z",
    idFactory: () => "pcmd_store",
  });

  const created = await commands.createCommand({
    task_id: "task_1",
    goal_id: "goal_1",
    decision_revision: 3,
    action: "advance_queue",
    payload: { task_id: "task_1" },
  });
  assert.equal(created.created, true);
  assert.equal(created.command.status, "pending");

  const claimed = await commands.claimNextCommand({ owner: "worker_a", leaseMs: 60_000 });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.lease.owner, "worker_a");
  assert.equal(claimed.attempt, 1);

  const applied = await commands.markApplied({
    id: claimed.id,
    owner: "worker_a",
    result: { advanced: true },
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.result, { advanced: true });
  assert.equal(applied.lease, null);
});

test("progression command store rejects action payloads with undeclared fields", async () => {
  const commands = createProgressionCommandStore({ store: createStore() });

  await assert.rejects(
    () => commands.createCommand({
      task_id: "task_extra_payload",
      decision_revision: 1,
      action: "integrate_change",
      payload: {
        task_id: "task_extra_payload",
        source_commit: "abc123",
        target_branch: "main",
        freeform_blob: { arbitrary: true },
      },
    }),
    (error) => error instanceof ProgressionCommandError
      && error.code === PROGRESSION_ERROR_CODES.INVALID_COMMAND
      && error.details?.field === "freeform_blob",
  );
});
