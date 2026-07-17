import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorCheckpointStore } from "../../src/supervisor/supervisor-checkpoint-store.mjs";
import { SupervisorCheckpointNotFoundError } from "../../src/supervisor/supervisor-errors.mjs";

test("createCheckpoint creates and readCheckpoint retrieves", async () => {
  const store = createSupervisorCheckpointStore();
  const cp = await store.createCheckpoint({ run_id: "run_001", trigger_source: "tui_idle" });
  assert.ok(cp.id.startsWith("cp_"));

  const read = await store.readCheckpoint(cp.id);
  assert.deepEqual(read, cp);
});

test("readCheckpoint throws for nonexistent", async () => {
  const store = createSupervisorCheckpointStore();
  await assert.rejects(() => store.readCheckpoint("nonexistent"), SupervisorCheckpointNotFoundError);
});

test("listCheckpoints returns checkpoints for run in reverse order", async () => {
  const store = createSupervisorCheckpointStore();
  const cp1 = await store.createCheckpoint({ run_id: "run_001", trigger_source: "startup" });
  const cp2 = await store.createCheckpoint({ run_id: "run_001", trigger_source: "no_progress" });
  const cp3 = await store.createCheckpoint({ run_id: "run_001", trigger_source: "git_diff" });

  const list = await store.listCheckpoints("run_001");
  assert.equal(list.length, 3);
  assert.equal(list[0].id, cp3.id); // most recent first
  assert.equal(list[1].id, cp2.id);
  assert.equal(list[2].id, cp1.id);
});

test("updateCheckpoint patches verdict and action", async () => {
  const store = createSupervisorCheckpointStore();
  const cp = await store.createCheckpoint({ run_id: "run_001", trigger_source: "manual" });

  const updated = await store.updateCheckpoint(cp.id, { verdict: "accepted", action: "continue_codex" });
  assert.equal(updated.verdict, "accepted");
  assert.equal(updated.action, "continue_codex");
});

test("listCheckpoints respects limit", async () => {
  const store = createSupervisorCheckpointStore();
  await store.createCheckpoint({ run_id: "run_001", trigger_source: "startup" });
  await store.createCheckpoint({ run_id: "run_001", trigger_source: "no_progress" });
  await store.createCheckpoint({ run_id: "run_001", trigger_source: "git_diff" });

  const list = await store.listCheckpoints("run_001", 2);
  assert.equal(list.length, 2);
});

test("count returns correct number", async () => {
  const store = createSupervisorCheckpointStore();
  assert.equal(store.count(), 0);
  await store.createCheckpoint({ run_id: "r1" });
  assert.equal(store.count(), 1);
});
