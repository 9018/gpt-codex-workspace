import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointCorrectionBuilder } from "../../src/dynamic-acceptance/checkpoint-correction-builder.mjs";
const builder = createCheckpointCorrectionBuilder();
test("buildCorrection includes goal and missing items", () => {
  const result = builder.buildCorrection({ goalText: "Fix bug", missingItems: [{ description: "Add test" }] });
  assert.ok(result.instruction.includes("Fix bug"));
  assert.ok(result.instruction.includes("Add test"));
});
test("buildDeterministicRepair returns instruction for known failures", () => {
  const result = builder.buildDeterministicRepair({ failureCode: "missing_commit" });
  assert.notEqual(result, null);
  assert.equal(result.type, "git_commit");
  assert.ok(result.instruction.includes("git commit"));
});
test("buildDeterministicRepair returns null for unknown failures", () => {
  const result = builder.buildDeterministicRepair({ failureCode: "unknown_failure" });
  assert.equal(result, null);
});
