import test from "node:test";
import assert from "node:assert/strict";
import { createTuiGoalCommandDriver } from "../../src/tui-autopilot/tui-goal-command-driver.mjs";
test("requires writeInput", () => {
  assert.throws(() => createTuiGoalCommandDriver({}), /writeInput is required/);
});
test("submitGoal sends /goal and goal text", async () => {
  const calls = [];
  const driver = createTuiGoalCommandDriver({ writeInput: (text) => calls.push(text), phaseTimeoutMs: 100 });
  const result = await driver.submitGoal({ goalText: "fix the bug", timeoutMs: 100 });
  assert.ok(calls[0].includes("/goal\r"));
  assert.ok(calls[1].includes("fix the bug\r"));
  assert.equal(result.ok, true);
});
test("submitGoal respects idempotency", async () => {
  let checked = false;
  const driver = createTuiGoalCommandDriver({
    writeInput: () => {},
    isGoalSubmitted: async (key) => { checked = true; return true; },
  });
  const result = await driver.submitGoal({ goalText: "fix bug", idempotencyKey: "goal-bootstrap:run-001:rev-1" });
  assert.equal(checked, true);
  assert.equal(result.idempotent, true);
});
test("submitGoal with successful phases", async () => {
  let phase1 = false, phase2 = false;
  const driver = createTuiGoalCommandDriver({
    writeInput: () => {},
    classifyScreen: async () => "goal_input",
    waitForState: async (state) => {
      if (state === "goal_input") { phase1 = true; return true; }
      if (state === "executing") { phase2 = true; return true; }
      return false;
    },
  });
  const result = await driver.submitGoal({ goalText: "fix bug" });
  assert.equal(phase1, true);
  assert.equal(phase2, true);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
});
