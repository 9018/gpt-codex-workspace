import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointTriggerPolicy } from "../../src/dynamic-acceptance/checkpoint-trigger-policy.mjs";
const policy = createCheckpointTriggerPolicy();
test("no_progress triggers when progress.no_progress is true", () => {
  const result = policy.evaluate({ progress: { no_progress: true }, run: {} });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.triggerSource, "no_progress");
});
test("tui_idle triggers when progress.idle is true", () => {
  const result = policy.evaluate({ progress: { idle: true }, run: {}, plan: { checkpoint_policy: { triggers: ["tui_idle"] } } });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.triggerSource, "tui_idle");
});
test("git_diff triggers when hasGitDiff is true", () => {
  const result = policy.evaluate({ hasGitDiff: true, run: {}, plan: { checkpoint_policy: { triggers: ["git_diff"] } } });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.triggerSource, "git_diff");
});
test("interval triggers after threshold", () => {
  const result = policy.evaluate({ lastCheckpointAt: new Date(Date.now() - 600000).toISOString(), run: {}, plan: { checkpoint_policy: { triggers: ["interval"], interval_seconds: 300 } } });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.triggerSource, "interval");
});
test("no trigger when none met", () => {
  const result = policy.evaluate({ run: {} });
  assert.equal(result.shouldTrigger, false);
});
