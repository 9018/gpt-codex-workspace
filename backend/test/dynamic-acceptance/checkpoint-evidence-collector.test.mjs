import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointEvidenceCollector } from "../../src/dynamic-acceptance/checkpoint-evidence-collector.mjs";
test("collect returns evidence with defaults", async () => {
  const collector = createCheckpointEvidenceCollector();
  const evidence = await collector.collect({ runId: "run_001" });
  assert.equal(evidence.run_id, "run_001");
  assert.equal(typeof evidence.collected_at, "string");
});
test("collect with session info", async () => {
  const collector = createCheckpointEvidenceCollector({
    readSession: async (id) => ({ id, status: "running", last_output_at: "2026-01-01" }),
  });
  const evidence = await collector.collect({ runId: "run_001", sessionId: "sess_001" });
  assert.equal(evidence.session.status, "running");
});
test("collect handles session read failure gracefully", async () => {
  const collector = createCheckpointEvidenceCollector({
    readSession: async () => { throw new Error("session gone"); },
  });
  const evidence = await collector.collect({ runId: "run_001", sessionId: "sess_001" });
  assert.equal(evidence.session.error, "session_unavailable");
});
