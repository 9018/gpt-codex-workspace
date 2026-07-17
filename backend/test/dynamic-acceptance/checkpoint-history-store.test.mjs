import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointHistoryStore } from "../../src/dynamic-acceptance/checkpoint-history-store.mjs";
test("recordVerdict and getHistory", async () => {
  const store = createCheckpointHistoryStore();
  await store.recordVerdict({ checkpoint_id: "cp_001", run_id: "run_001", verdict: "continue_codex" });
  const history = await store.getHistory("run_001");
  assert.equal(history.length, 1);
  assert.equal(history[0].verdict, "continue_codex");
});
test("getRecentByType filters by verdict type", async () => {
  const store = createCheckpointHistoryStore();
  await store.recordVerdict({ checkpoint_id: "cp_001", run_id: "run_001", verdict: "send_correction" });
  await store.recordVerdict({ checkpoint_id: "cp_002", run_id: "run_001", verdict: "continue_codex" });
  const corrections = await store.getRecentByType("run_001", "send_correction");
  assert.equal(corrections.length, 1);
});
test("count returns total verdicts", async () => {
  const store = createCheckpointHistoryStore();
  assert.equal(store.count(), 0);
  await store.recordVerdict({ checkpoint_id: "cp_001", run_id: "run_001", verdict: "continue_codex" });
  assert.equal(store.count(), 1);
});
