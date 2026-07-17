import test from "node:test";
import assert from "node:assert/strict";

import { collectTaskFinalizationFacts } from "../../src/task-finalization/task-finalization-facts.mjs";

test("collectTaskFinalizationFacts derives immutable finalization facts", () => {
  const task = { id: "task-1", status: "running", attempt: 1, max_attempts: 4, auto_start: true };
  const goal = {
    id: "goal-1",
    acceptance_contract: { requirements: { requires_integration: true } },
  };
  const taskResult = {
    verification: { passed: true },
    acceptance_gate: { passed: true },
    contract_verification: { blocking_passed: true },
    integration: { status: "pending" },
    runtime_guard: { restart_required: false },
  };

  const facts = collectTaskFinalizationFacts({
    task,
    goal,
    taskStatus: "completed",
    taskResult,
    config: { maxRepairAttempts: 2 },
  });

  assert.equal(facts.current_status, "completed");
  assert.equal(facts.previous_status, "running");
  assert.equal(facts.task, task);
  assert.equal(facts.goal, goal);
  assert.equal(facts.codex_result, taskResult);
  assert.equal(facts.verification, taskResult.verification);
  assert.equal(facts.acceptance, taskResult.acceptance_gate);
  assert.equal(facts.contract_verification, taskResult.contract_verification);
  assert.deepEqual(facts.integration, { status: "pending", required: true });
  assert.equal(facts.runtime_guard, taskResult.runtime_guard);
  assert.deepEqual(facts.repair_budget, { attempt: 1, max_attempts: 4, attempts_remaining: 2 });
  assert.deepEqual(facts.queue_context, { auto_start: true, goal_id: "goal-1" });
  assert.equal(Object.isFrozen(facts), true);
});
