import test from "node:test";
import assert from "node:assert/strict";
import { decideTuiConfirmation } from "../src/tui-autopilot/tui-confirmation-policy.mjs";

test("decideTuiConfirmation approves bounded worktree operations", () => {
  const decision = decideTuiConfirmation({ normalized_text: "Run npm test in /workspace/repo? (y/n)" }, {
    allowedRoots: ["/workspace/repo"],
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.input, "y\r");
  assert.equal(decision.reason_code, "run_test_within_worktree");
});

test("decideTuiConfirmation rejects unrecognized or out-of-bounds actions", () => {
  const decision = decideTuiConfirmation({ normalized_text: "Delete /etc/passwd? (y/n)" }, {
    allowedRoots: ["/workspace/repo"],
  });
  assert.equal(decision.approved, false);
  assert.equal(decision.input, "n\r");
  assert.match(decision.alternative_instruction, /current worktree/i);
});
