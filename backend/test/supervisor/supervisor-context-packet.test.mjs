import test from "node:test";
import assert from "node:assert/strict";

import { buildSupervisorContextPacket } from "../../src/supervisor/supervisor-context-packet.mjs";

test("buildSupervisorContextPacket builds packet with defaults", () => {
  const packet = buildSupervisorContextPacket({ run: { id: "run_001", state: "running", supervision: {} } });
  assert.equal(packet.schema_version, 1);
  assert.equal(packet.run_summary.id, "run_001");
  assert.equal(packet.run_summary.state, "running");
  assert.equal(typeof packet.built_at, "string");
});

test("buildSupervisorContextPacket includes plan summary", () => {
  const packet = buildSupervisorContextPacket({
    run: { id: "run_001", state: "running", supervision: {} },
    plan: { id: "sp_001", user_goal: "Fix bug", execution_steps: [{ description: "step1" }], autonomy_budget: {}, takeover_policy: {} },
  });
  assert.equal(packet.plan.id, "sp_001");
  assert.equal(packet.plan.user_goal, "Fix bug");
  assert.equal(packet.plan.execution_steps, 1);
});

test("buildSupervisorContextPacket includes checkpoints", () => {
  const packet = buildSupervisorContextPacket({
    run: { id: "run_001", state: "running", supervision: {} },
    checkpoints: [
      { id: "cp_001", trigger_source: "startup", verdict: "accepted", action: "continue_codex", created_at: "2026-01-01" },
    ],
  });
  assert.equal(packet.checkpoints.length, 1);
  assert.equal(packet.checkpoints[0].id, "cp_001");
});

test("buildSupervisorContextPacket includes latest checkpoint", () => {
  const packet = buildSupervisorContextPacket({
    run: { id: "run_001", state: "running", supervision: {} },
    latestCheckpoint: { verdict: "repair_needed", action: "send_correction", trigger_source: "no_progress", takeover_reason: "Budget exceeded" },
  });
  assert.equal(packet.latest_checkpoint.verdict, "repair_needed");
  assert.equal(packet.latest_checkpoint.reasoning, "Budget exceeded");
});
