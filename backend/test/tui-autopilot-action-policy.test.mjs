import test from "node:test";
import assert from "node:assert/strict";
import { decideTuiAction } from "../src/tui-autopilot/tui-action-policy.mjs";

test("decideTuiAction automatically confirms, chooses, and continues", () => {
  assert.equal(decideTuiAction({ state: "awaiting_confirmation", frame: { normalized_text: "Run git status? (y/n)" } }).type, "send_input");
  assert.deepEqual(decideTuiAction({ state: "awaiting_choice", frame: { selectable_options: [{ index: 1, label: "Continue" }] } }), {
    type: "send_input",
    input: "1\r",
    reason_code: "policy_choice_continue",
  });
  const continuation = decideTuiAction({ state: "ready_for_instruction", remainingAcceptance: ["tests", "result.json"] });
  assert.equal(continuation.type, "send_input");
  assert.match(continuation.input, /tests.*result\.json/i);
});

test("decideTuiAction escalates only bounded high uncertainty", () => {
  const decision = decideTuiAction({ state: "unclassified", actionAttempts: 100, maxActions: 100 });
  assert.equal(decision.type, "checkpoint_supervisor");
  assert.equal(decision.reason_code, "autopilot_action_budget_exhausted");
});
