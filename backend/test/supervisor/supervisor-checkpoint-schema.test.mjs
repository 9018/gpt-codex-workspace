import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorCheckpoint, CHECKPOINT_ACTIONS, CHECKPOINT_VERDICTS, CHECKPOINT_TRIGGER_SOURCES } from "../../src/supervisor/supervisor-checkpoint-schema.mjs";

test("createSupervisorCheckpoint requires run_id", () => {
  assert.throws(() => createSupervisorCheckpoint({}), /run_id is required/);
});

test("createSupervisorCheckpoint creates with defaults", () => {
  const cp = createSupervisorCheckpoint({ run_id: "run_001" });
  assert.ok(cp.id.startsWith("cp_"));
  assert.equal(cp.run_id, "run_001");
  assert.equal(cp.schema_version, 1);
  assert.equal(cp.trigger_source, "manual");
  assert.equal(cp.verdict, null);
  assert.equal(cp.action, null);
  assert.equal(cp.takeover_by, null);
  assert.deepEqual(cp.context, {});
  assert.equal(typeof cp.created_at, "string");
});

test("createSupervisorCheckpoint preserves explicit fields", () => {
  const cp = createSupervisorCheckpoint({
    run_id: "run_001",
    id: "cp_custom",
    run_version: 3,
    trigger_source: "no_progress",
    verdict: "repair_needed",
    action: "send_correction",
    takeover_by: "chatgpt",
    takeover_reason: "No progress for 5 minutes",
    context: { output_snapshot: "..." },
  });
  assert.equal(cp.id, "cp_custom");
  assert.equal(cp.run_version, 3);
  assert.equal(cp.trigger_source, "no_progress");
  assert.equal(cp.verdict, "repair_needed");
  assert.equal(cp.action, "send_correction");
  assert.equal(cp.takeover_by, "chatgpt");
});

test("constants are frozen", () => {
  assert.throws(() => { CHECKPOINT_ACTIONS.push("extra"); }, /Cannot add property/);
  assert.throws(() => { CHECKPOINT_VERDICTS.push("extra"); }, /Cannot add property/);
  assert.throws(() => { CHECKPOINT_TRIGGER_SOURCES.push("extra"); }, /Cannot add property/);
});
