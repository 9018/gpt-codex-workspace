import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexTuiGoalObjective,
  buildCodexTuiFollowupInstruction,
  buildCodexTuiBootstrapMessages,
} from "../src/codex-tui-goal-prompt.mjs";

test("goal objective is short and points at codex.entry.md", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_abc", taskTitle: "Implement TUI foundation" });

  assert.ok(objective.length < 4000);
  assert.match(objective, /goal_id=goal_abc/);
  assert.match(objective, /codex\.entry\.md/);
  assert.match(objective, /Implement TUI foundation/);
});

test("follow-up instruction includes codex.entry.md", () => {
  const text = buildCodexTuiFollowupInstruction({ goalId: "goal_abc" });

  assert.match(text, /goal_abc/);
  assert.match(text, /codex\.entry\.md/);
  assert.match(text, /result\.json/);
});

test("bootstrap messages write /goal first and follow-up second", () => {
  const messages = buildCodexTuiBootstrapMessages({ goalId: "goal_abc", taskTitle: "Do it" });

  assert.equal(messages.length, 2);
  assert.match(messages[0], /^\/goal /);
  assert.match(messages[0], /goal_id=goal_abc/);
  assert.match(messages[1], /codex\.entry\.md/);
});

test("goal objective truncates very long titles under 4000 chars", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_long", taskTitle: "x".repeat(10000) });

  assert.ok(objective.length < 4000);
  assert.match(objective, /goal_id=goal_long/);
  assert.match(objective, /codex\.entry\.md/);
});
