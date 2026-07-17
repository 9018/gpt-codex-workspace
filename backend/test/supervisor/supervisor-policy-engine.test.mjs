import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorPolicyEngine } from "../../src/supervisor/supervisor-policy-engine.mjs";

const engine = createSupervisorPolicyEngine();

test("decideNextAction for accepted verdict continues", () => {
  const result = engine.decideNextAction({ verdict: "accepted", run: { supervision: {} } });
  assert.equal(result.action, "continue_codex");
});

test("decideNextAction for repair_needed sends correction within budget", () => {
  const result = engine.decideNextAction({
    verdict: "repair_needed",
    run: { supervision: { correction_cycles: 0 } },
    plan: { autonomy_budget: { max_corrections: 5, max_attempts: 3 } },
  });
  assert.equal(result.action, "send_correction");
});

test("decideNextAction for repair_needed takes over when budget exceeded", () => {
  const result = engine.decideNextAction({
    verdict: "repair_needed",
    run: { supervision: { correction_cycles: 10 } },
    plan: { autonomy_budget: { max_corrections: 5, max_attempts: 3 } },
  });
  assert.equal(result.action, "chatgpt_takeover");
});

test("decideNextAction for takeover requests chatgpt takeover", () => {
  const result = engine.decideNextAction({
    verdict: "takeover",
    run: { supervision: { chatgpt_takeover_count: 0 } },
    plan: { autonomy_budget: { max_attempts: 3 } },
  });
  assert.equal(result.action, "chatgpt_takeover");
});

test("decideNextAction for terminal evaluates terminal", () => {
  const result = engine.decideNextAction({ verdict: "terminal", run: { supervision: {} } });
  assert.equal(result.action, "evaluate_terminal");
});

test("decideNextAction for review_needed waits for chatgpt", () => {
  const result = engine.decideNextAction({ verdict: "review_needed", run: { supervision: {} } });
  assert.equal(result.action, "wait_for_chatgpt");
});

test("shouldCheckpoint always for startup/evidence_ready", () => {
  const run = { checkpoint_ids: [], supervision: {} };
  assert.equal(engine.shouldCheckpoint({ triggerSource: "startup", run }), true);
  assert.equal(engine.shouldCheckpoint({ triggerSource: "evidence_ready", run }), true);
});

test("shouldCheckpoint checks policy triggers", () => {
  const run = { checkpoint_ids: [], supervision: {} };
  const plan = { checkpoint_policy: { triggers: ["git_diff"] } };
  assert.equal(engine.shouldCheckpoint({ triggerSource: "git_diff", run, plan }), true);
  assert.equal(engine.shouldCheckpoint({ triggerSource: "no_progress", run, plan }), false);
});

test("shouldCheckpoint rate limits at 50", () => {
  const run = { checkpoint_ids: Array(50).fill(0).map((_, i) => `cp_${i}`), supervision: {} };
  assert.equal(engine.shouldCheckpoint({ triggerSource: "no_progress", run }), false);
});
