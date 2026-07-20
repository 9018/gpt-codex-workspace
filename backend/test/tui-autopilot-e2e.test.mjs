import test from "node:test";
import assert from "node:assert/strict";
import { createTuiAutopilotController } from "../src/tui-autopilot/tui-autopilot-controller.mjs";

test("autopilot controller parses output, sends an automatic confirmation, and persists state", async () => {
  const writes = [];
  const patches = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_1",
    allowedRoots: ["/workspace/repo"],
    writeInput: async (input) => writes.push(input),
    persist: async (patch) => patches.push(patch),
  });

  const result = await controller.ingest("Run npm test in /workspace/repo? (y/n)");

  assert.equal(result.state, "awaiting_confirmation");
  assert.deepEqual(writes, ["y\r"]);
  assert.equal(patches.at(-1).autopilot_state, "awaiting_confirmation");
  assert.equal(patches.at(-1).action_attempts, 1);
  assert.match(patches.at(-1).last_frame_digest, /^[a-f0-9]{64}$/);
});

test("autopilot controller produces a bounded supervisor checkpoint on exhausted uncertainty", async () => {
  const patches = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_2",
    maxActions: 0,
    persist: async (patch) => patches.push(patch),
  });
  const result = await controller.ingest("Unrecognized high uncertainty prompt");
  assert.equal(result.action.type, "checkpoint_supervisor");
  assert.equal(patches.at(-1).status, "waiting_for_supervisor");
  assert.equal(patches.at(-1).checkpoint.reason_code, "autopilot_action_budget_exhausted");
});

test("autopilot does not spend action budget by resending the same input for an unchanged prompt", async () => {
  const writes = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_duplicate",
    writeInput: async (input) => writes.push(input),
  });
  await controller.ingest("Run npm test in /workspace/repo? (y/n)");
  const writesAfterFirst = [...writes];
  const second = await controller.ingest("Run npm test in /workspace/repo? (y/n)");
  assert.deepEqual(writes, writesAfterFirst);
  assert.equal(second.action.type, "observe");
  assert.equal(second.action.reason_code, "duplicate_action_suppressed");
  assert.equal(controller.snapshot().action_attempts, 1);
});

test("stream disconnect deterministically resumes the current goal before generic no-progress recovery", async () => {
  const resumes = [];
  const patches = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_stream_disconnect",
    resume: async () => resumes.push("/goal resume"),
    persist: async (patch) => patches.push(patch),
  });
  const result = await controller.ingest("stream disconnected before completion: Stream truncated before any output was produced");
  assert.equal(result.action.type, "resume");
  assert.equal(result.action.reason_code, "stream_disconnected_goal_resume");
  assert.deepEqual(resumes, ["/goal resume"]);
  assert.equal(patches.at(-1).repair_attempts, 1);
});
