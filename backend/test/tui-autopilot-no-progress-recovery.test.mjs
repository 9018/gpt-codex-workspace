import test from "node:test";
import assert from "node:assert/strict";
import { createTuiProgressTracker } from "../src/tui-autopilot/tui-progress-tracker.mjs";
import { decideTuiRecovery } from "../src/tui-autopilot/tui-recovery-policy.mjs";
import { createTuiAutopilotController } from "../src/tui-autopilot/tui-autopilot-controller.mjs";

test("progress tracker detects repeated stable frames after the no-progress budget", () => {
  const tracker = createTuiProgressTracker({ noProgressMs: 1_000, now: () => 0 });
  tracker.observe({ content_digest: "same", progress_markers: [] }, { at: 0 });
  const status = tracker.observe({ content_digest: "same", progress_markers: [] }, { at: 1_001 });
  assert.equal(status.no_progress, true);
});

test("recovery policy advances through bounded automatic recovery before supervisor", () => {
  assert.equal(decideTuiRecovery({ recoveryAttempt: 0 }).type, "probe");
  assert.equal(decideTuiRecovery({ recoveryAttempt: 1 }).type, "correct");
  assert.equal(decideTuiRecovery({ recoveryAttempt: 2 }).type, "interrupt");
  assert.equal(decideTuiRecovery({ recoveryAttempt: 3 }).type, "resume");
  assert.equal(decideTuiRecovery({ recoveryAttempt: 4 }).type, "checkpoint_supervisor");
});

test("active controller runs bounded no-progress recovery and checkpoints supervisor", async () => {
  let clock = 0;
  const inputs = [];
  const events = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_recovery",
    allowedRoots: ["/workspace"],
    noProgressMs: 1_000,
    maxRepairs: 2,
    now: () => clock,
    writeInput: async (input) => inputs.push(input),
    interrupt: async () => events.push("interrupt"),
    resume: async () => events.push("resume"),
    persist: async (patch) => events.push(patch),
  });
  controller.activate();

  await controller.ingest("Working on task");
  clock = 1_001;
  const probe = await controller.ingest("Working on task");
  clock = 2_002;
  const correct = await controller.ingest("Working on task");
  clock = 3_003;
  const checkpoint = await controller.ingest("Working on task");

  assert.equal(probe.action.reason_code, "no_progress_probe");
  assert.equal(correct.action.reason_code, "no_progress_correct");
  assert.equal(checkpoint.action.type, "checkpoint_supervisor");
  assert.equal(checkpoint.action.reason_code, "autopilot_recovery_budget_exhausted");
  assert.equal(inputs.length, 2);
  assert.equal(events.some((event) => event?.status === "waiting_for_supervisor"), true);
});

test("inactive controller observes bootstrap output without sending actions", async () => {
  const inputs = [];
  const controller = createTuiAutopilotController({
    sessionId: "session_bootstrap",
    active: false,
    writeInput: async (input) => inputs.push(input),
  });

  const result = await controller.ingest("Continue? (y/n)");

  assert.equal(result.action.type, "observe");
  assert.equal(result.action.reason_code, "autopilot_not_activated");
  assert.deepEqual(inputs, []);
});
