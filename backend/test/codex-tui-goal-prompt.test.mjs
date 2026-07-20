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

test("goal objective allows optional subagents without prescribing a fixed pipeline", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_abc", taskTitle: "Implement TUI foundation" });

  assert.match(objective, /Decide whether subagents materially help/);
  assert.match(objective, /parent TUI session remains responsible for integration, verification, and the final result/);
  assert.doesNotMatch(objective, /Subagent pipeline \(parent TUI fixed\)/);
  assert.doesNotMatch(objective, /context_curator/);
  assert.doesNotMatch(objective, /repairer \(up to 2 rounds/);
  assert.doesNotMatch(objective, /finalizer/);
});

test("follow-up instruction includes incremental and final result contracts", () => {
  const text = buildCodexTuiFollowupInstruction({ goalId: "goal_abc" });

  assert.match(text, /goal_abc/);
  assert.match(text, /codex\.entry\.md/);
  assert.match(text, /result\.partial\.json/);
  assert.match(text, /result\.json/);
});

test("goal objective requires staged partial results and atomic finalization", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_abc", taskTitle: "Do it" });

  assert.match(objective, /result\.partial\.json/);
  assert.match(objective, /started -> code_changed -> testing -> finished/);
  assert.match(objective, /atomically rename it to .*result\.json/);
  assert.match(objective, /Do not treat the partial file as completion/);
});

test("bootstrap sends exactly one /goal message without automatic follow-up", () => {
  const messages = buildCodexTuiBootstrapMessages({ goalId: "goal_abc", taskTitle: "Do it" });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\/goal /);
  assert.match(messages[0], /goal_id=goal_abc/);
  assert.doesNotMatch(messages[0], /Continue GPTWork/);
});

test("goal objective truncates very long titles under 4000 chars", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_long", taskTitle: "x".repeat(10000) });

  assert.ok(objective.length < 4000);
  assert.match(objective, /goal_id=goal_long/);
  assert.match(objective, /codex\.entry\.md/);
});


test("goal objective starts with a human-readable task title before UUID metadata", () => {
  const objective = buildCodexTuiGoalObjective({ goalId: "goal_abc-123", taskTitle: "修复 Codex Session 绑定与标题" });
  const lines = objective.split("\n");
  assert.equal(lines[0], "task=修复 Codex Session 绑定与标题");
  assert.equal(lines[1], "goal_id=goal_abc-123");
});
