import test from "node:test";
import assert from "node:assert/strict";

import { validateUnifiedDecision } from "../src/domain/unified-decision-validator.mjs";
import { buildStateReconciliationCheckpoint } from "../src/state-reconciliation-checkpoint.mjs";

test("contradictory completion is rejected and projected as an explainable checkpoint", () => {
  const decision = {
    task_id: "task_state",
    revision: 1,
    terminal: true,
    task_status: "completed",
    goal_status: "running",
    queue_status: "running",
    integration: { required: true, completed: false },
  };
  const validation = validateUnifiedDecision(decision);
  const checkpoint = buildStateReconciliationCheckpoint({
    task: { id: "task_state", status: "running" },
    taskResult: { failure_class: "contradictory_unified_decision", blockers: validation.violations.map((code) => ({ code })) },
  });

  assert.equal(validation.valid, false);
  assert.notEqual(checkpoint.verdict, "passed");
  assert.equal(checkpoint.guardrails.do_not_fake_completion, true);
});
