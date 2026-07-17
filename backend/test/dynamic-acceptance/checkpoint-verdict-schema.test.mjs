import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointVerdict, CHECKPOINT_VERDICT_TYPES, CHECKPOINT_TRIGGER_SOURCES } from "../../src/dynamic-acceptance/checkpoint-verdict-schema.mjs";
test("createCheckpointVerdict requires checkpoint_id and valid verdict", () => {
  assert.throws(() => createCheckpointVerdict({}), /checkpoint_id is required/);
  assert.throws(() => createCheckpointVerdict({ checkpoint_id: "cp_001", verdict: "invalid" }), /Invalid verdict/);
});
test("createCheckpointVerdict creates with defaults", () => {
  const v = createCheckpointVerdict({ checkpoint_id: "cp_001", verdict: "continue_codex" });
  assert.ok(v.id.startsWith("verdict_"));
  assert.equal(v.verdict, "continue_codex");
  assert.equal(v.trigger_source, "manual");
});
test("createCheckpointVerdict preserves explicit fields", () => {
  const v = createCheckpointVerdict({
    checkpoint_id: "cp_001", verdict: "send_correction", run_id: "run_001",
    trigger_source: "no_progress", reason: "No output for 2 minutes",
    correction: { instruction: "Fix the tests" },
  });
  assert.equal(v.run_id, "run_001");
  assert.equal(v.trigger_source, "no_progress");
  assert.equal(v.reason, "No output for 2 minutes");
  assert.equal(v.correction.instruction, "Fix the tests");
});
test("constants are frozen", () => {
  assert.throws(() => { CHECKPOINT_VERDICT_TYPES.push("extra"); }, /Cannot add property/);
  assert.throws(() => { CHECKPOINT_TRIGGER_SOURCES.push("extra"); }, /Cannot add property/);
});
