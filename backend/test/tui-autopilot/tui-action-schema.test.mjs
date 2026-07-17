import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_BOOTSTRAP_METHODS,
  createGoalBootstrapAction,
  createSlashCommandAction,
} from "../../src/tui-autopilot/tui-action-schema.mjs";
test("createGoalBootstrapAction requires method and goalText", () => {
  assert.throws(() => createGoalBootstrapAction({}), /Invalid bootstrap method/);
  assert.throws(() => createGoalBootstrapAction({ goalText: "fix bug" }), /Invalid bootstrap method/);
});
test("createGoalBootstrapAction creates action with correct shape", () => {
  const action = createGoalBootstrapAction({ method: "goal_slash_command", goalText: "Fix the bug" });
  assert.equal(action.type, "goal_bootstrap");
  assert.equal(action.method, "goal_slash_command");
  assert.equal(action.goal_text, "Fix the bug");
  assert.equal(action.idempotency_key, null);
  assert.equal(action.timeout_ms, 30000);
});
test("createSlashCommandAction requires / prefix", () => {
  assert.throws(() => createSlashCommandAction({ command: "goal" }), /Must start with "\/"/);
});
test("GOAL_BOOTSTRAP_METHODS is frozen", () => {
  assert.throws(() => { GOAL_BOOTSTRAP_METHODS.push("extra"); }, /Cannot add property/);
});
