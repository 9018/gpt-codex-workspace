import test from "node:test";
import assert from "node:assert/strict";

import { buildProgressionIdempotencyKey } from "../src/progression/progression-idempotency.mjs";
import { createProgressionCommandStore } from "../src/progression/progression-command-store.mjs";

function createStore() {
  const state = {};
  return {
    state,
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

test("progression idempotency key is stable across payload key order", () => {
  const first = buildProgressionIdempotencyKey({
    task_id: "task_1",
    decision_revision: 7,
    action: "integrate_change",
    payload: { source_commit: "abc", target_branch: "main", task_id: "task_1" },
  });
  const second = buildProgressionIdempotencyKey({
    task_id: "task_1",
    decision_revision: 7,
    action: "integrate_change",
    payload: { task_id: "task_1", target_branch: "main", source_commit: "abc" },
  });
  assert.equal(first, second);
});

test("duplicate progression events return the existing command", async () => {
  const commandStore = createProgressionCommandStore({
    store: createStore(),
    idFactory: () => "pcmd_once",
  });
  const input = {
    task_id: "task_1",
    decision_revision: 2,
    action: "create_repair_task",
    payload: { parent_task_id: "task_1", blockers: ["tests_failed"], repair_budget_revision: 1 },
  };

  const first = await commandStore.createCommand(input);
  const replay = await commandStore.createCommand(input);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.command.id, first.command.id);
});
