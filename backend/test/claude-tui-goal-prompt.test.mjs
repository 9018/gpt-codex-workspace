import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeTuiGoalObjective,
  buildClaudeTuiFollowupInstruction,
  buildClaudeTuiBootstrapMessages,
} from "../src/claude-tui-goal-prompt.mjs";

test("goal objective is short and points at claude.entry.md", () => {
  const objective = buildClaudeTuiGoalObjective({ goalId: "goal_abc", taskTitle: "Implement Claude TUI" });

  assert.ok(objective.length < 4000, `objective length ${objective.length} exceeds 4000`);
  assert.match(objective, /goal_id=goal_abc/);
  assert.match(objective, /claude\.entry/);
  assert.match(objective, /Implement Claude TUI/);
});

test("goal objective preserves /goal-style semantics without literal /goal command", () => {
  const objective = buildClaudeTuiGoalObjective({ goalId: "goal_xyz", taskTitle: "My task" });

  assert.match(objective, /goal_mode/);
  assert.match(objective, /goal_id=goal_xyz/);
  assert.match(objective, /result\.json/);
  assert.match(objective, /result\.md/);
  // Claude does not have /goal command — verify the bootstrap uses goal_mode instead
  assert.doesNotMatch(objective, /^\/goal /);
});

test("follow-up instruction includes goal_id and entry file", () => {
  const text = buildClaudeTuiFollowupInstruction({ goalId: "goal_abc" });

  assert.match(text, /goal_abc/);
  assert.match(text, /claude\.entry\.md/);
  assert.match(text, /result\.json/);
  assert.match(text, /result\.md/);
});

test("follow-up instruction accepts custom entry file name", () => {
  const text = buildClaudeTuiFollowupInstruction({ goalId: "goal_abc", entryFile: "custom.entry.md" });

  assert.match(text, /custom\.entry\.md/);
});

test("bootstrap messages return two strings with goal objective then followup", () => {
  const messages = buildClaudeTuiBootstrapMessages({ goalId: "goal_abc", taskTitle: "Test title" });

  assert.equal(messages.length, 2);
  assert.match(messages[0], /goal_id=goal_abc/);
  assert.match(messages[0], /result\.json/);
  assert.match(messages[1], /claude\.entry\.md/);
  assert.match(messages[1], /Continue/);
});

test("goal objective truncates very long titles under 4000 chars", () => {
  const objective = buildClaudeTuiGoalObjective({ goalId: "goal_long", taskTitle: "x".repeat(10000) });

  assert.ok(objective.length < 4000);
  assert.match(objective, /goal_id=goal_long/);
  assert.match(objective, /result\.json/);
});

test("buildClaudeTuiGoalObjective throws when goalId is missing", () => {
  assert.throws(() => buildClaudeTuiGoalObjective({}));
  assert.throws(() => buildClaudeTuiGoalObjective({ goalId: "" }));
});

test("buildClaudeTuiFollowupInstruction throws when goalId is missing", () => {
  assert.throws(() => buildClaudeTuiFollowupInstruction({}));
  assert.throws(() => buildClaudeTuiFollowupInstruction({ goalId: "" }));
});
