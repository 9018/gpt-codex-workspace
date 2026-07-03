/**
 * p0-c7-repair-loop-productization.test.mjs
 *
 * P0-C7: Productize Repair Loop and Failure Classification
 *
 * Tests covering:
 *   1. codex_failed auto-repair → execution_failed classification
 *   2. Result contract invalid repair
 *   3. Integration failed repair
 *   4. Repair budget exhausted
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ===========================================================================
// Imports from failure-classifier
// ===========================================================================

import {
  classifyTaskFailure,
  classifyFailure,
  classifyFailureStructured,
  canRetryTask,
  failureClassRequiresRepair,
  failureClassIsTerminalNonRepairable,
  getFailureClassDefinition,
} from "../src/failure-classifier.mjs";

// ===========================================================================
// Imports from repair-loop
// ===========================================================================

import {
  buildRepairPrompt,
  createRepairGoalFromFindings,
  shouldAttemptRepair,
} from "../src/repair-loop.mjs";

// ===========================================================================
// Imports from task-review-status-taxonomy
// ===========================================================================

import {
  REVIEW_STATES,
  classifyReviewState,
  createReviewStateBlock,
} from "../src/task-review-status-taxonomy.mjs";

// ===========================================================================
// SCENARIO 1: codex_failed auto-repair → execution_failed classification
// ===========================================================================

test("P0-C7 SCENARIO 1: codex_failed auto-repair → execution_failed classification", async (t) => {
  await t.test("classifies execution_failed from codexResult kind: codex_failed", () => {
    const failure = classifyTaskFailure({
      codexResult: { kind: "codex_failed", summary: "Codex encountered an error during execution" },
    });
    assert.equal(failure.failure_class, "execution_failed");
    assert.equal(failure.repairable, true);
    assert.equal(failure.repair_strategy, "repair_execution");
  });

  await t.test("classifies execution_failed from codexResult kind: execution_failed", () => {
    const failure = classifyTaskFailure({
      codexResult: { kind: "execution_failed", summary: "Task execution failed" },
    });
    assert.equal(failure.failure_class, "execution_failed");
    assert.equal(failure.repairable, true);
  });

  await t.test("classifies execution_failed from data_loss signal", () => {
    const failure = classifyTaskFailure({
      codexResult: { kind: "codex_failed", summary: "data_loss: could not recover task state" },
    });
    assert.equal(failure.failure_class, "execution_failed");
    assert.equal(failure.repairable, true);
  });

  await t.test("execution_failed is repairable in failureClassRequiresRepair", () => {
    assert.equal(failureClassRequiresRepair("execution_failed"), true);
  });

  await t.test("execution_failed is NOT terminal in failureClassIsTerminalNonRepairable", () => {
    assert.equal(failureClassIsTerminalNonRepairable("execution_failed"), false);
  });

  await t.test("execution_failed has structured definition with waiting_for_repair hint", () => {
    const def = getFailureClassDefinition("execution_failed");
    assert.ok(def, "execution_failed should have a structured definition");
    assert.equal(def.repairable, true);
    assert.equal(def.nextStatusHint, "waiting_for_repair");
    assert.equal(def.confidence, "high");
  });

  await t.test("execution_failed is repairable and can be retried", () => {
    const failure = classifyTaskFailure({
      codexResult: { kind: "codex_failed", summary: "Execution failed" },
    });
    assert.equal(canRetryTask({ attempt: 0, max_attempts: 2 }, failure), true);
    assert.equal(canRetryTask({ attempt: 1, max_attempts: 2 }, failure), false);
  });

  await t.test("buildRepairPrompt includes codex_failed repair instructions", () => {
    const prompt = buildRepairPrompt({
      task: { id: "task_exec", title: "Fix codex execution" },
      goal: { id: "goal_exec", goal_prompt: "Run codex task" },
      failure: { failure_class: "execution_failed", reason: "Execution failed", repair_strategy: "repair_execution" },
      verification: {},
    });
    assert.match(prompt, /failure_class: execution_failed/);
    assert.match(prompt, /Codex execution failed/);
    assert.match(prompt, /Re-run with adjusted parameters/);
  });

  await t.test("review state: codex_failed blocker routes to missing_evidence_repair (P0-C7 change)", () => {
    const result = classifyReviewState({ blockers: [{ code: "codex_failed" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  });

  await t.test("review state: execution_failed blocker routes to missing_evidence_repair", () => {
    const result = classifyReviewState({ blockers: [{ code: "execution_failed" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  });
});

// ===========================================================================
// SCENARIO 2: Result contract invalid repair
// ===========================================================================

test("P0-C7 SCENARIO 2: Result contract invalid repair", async (t) => {
  await t.test("classifies result_contract_invalid from blocker code", () => {
    const failure = classifyTaskFailure({
      codexResult: { failure_class: "result_contract_invalid", summary: "Contract validation failed" },
    });
    assert.equal(failure.failure_class, "result_contract_invalid");
    assert.equal(failure.repairable, true);
    assert.equal(failure.repair_strategy, "repair_result_contract");
  });

  await t.test("classifies result_contract_invalid from contract_invalid text", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "contract_invalid", message: "Result contract is invalid" }] },
    });
    assert.equal(failure.failure_class, "result_contract_invalid");
    assert.equal(failure.repairable, true);
  });

  await t.test("result_contract_invalid is repairable", () => {
    assert.equal(failureClassRequiresRepair("result_contract_invalid"), true);
  });

  await t.test("result_contract_invalid has structured definition", () => {
    const def = getFailureClassDefinition("result_contract_invalid");
    assert.ok(def, "result_contract_invalid should have a structured definition");
    assert.equal(def.repairable, true);
    assert.equal(def.nextStatusHint, "waiting_for_repair");
  });

  await t.test("buildRepairPrompt includes contract repair instructions", () => {
    const prompt = buildRepairPrompt({
      task: { id: "task_contract", title: "Fix contract", result: { summary: "Wrote code" } },
      goal: { id: "goal_contract", goal_prompt: "Implement feature" },
      failure: { failure_class: "result_contract_invalid", reason: "Invalid result.json", repair_strategy: "repair_result_contract" },
      verification: { findings: [{ severity: "blocker", code: "contract_invalid", message: "Result.json missing required fields" }] },
    });
    assert.match(prompt, /failure_class: result_contract_invalid/);
    assert.match(prompt, /Repair the result contract/);
    assert.match(prompt, /produce a valid result using the required contract format/);
    assert.match(prompt, /Do not rewrite unrelated business code/);
  });

  await t.test("review state: contract_invalid routes to result_contract_repair", () => {
    const result = classifyReviewState({ blockers: [{ code: "contract_invalid" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR);
  });

  await t.test("review state: acceptance_failed routes to result_contract_repair (P0-C7)", () => {
    const result = classifyReviewState({ blockers: [{ code: "acceptance_failed" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_RESULT_CONTRACT_REPAIR);
  });

  await t.test("missing_result_json is still classified correctly (backward compat)", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "result_json_missing", message: "No task result data" }] },
    });
    assert.equal(failure.failure_class, "missing_result_json");
    assert.equal(failure.repairable, true);
  });

  await t.test("createRepairGoalFromFindings includes tracking fields for contract repair", () => {
    const task = {
      id: "task_contract_repair",
      title: "Contract repair test",
      root_task_id: "task_root",
      repair_attempt: 0,
      max_attempts: 3,
    };
    const goal = { goal_prompt: "Implement feature with valid result contract" };
    const findings = [{ severity: "blocker", code: "result_contract_invalid", message: "Result contract invalid" }];
    const repair = createRepairGoalFromFindings({ task, goal, findings });
    assert.equal(repair.repair_budget, 3);
    assert.equal(repair.superseded_by_task_id, null);
    assert.equal(repair.resolved_by_task_id, null);
    assert.equal(repair.failure_class, "result_contract_invalid");
    assert.equal(repair.repair_attempt, 1);
  });
});

// ===========================================================================
// SCENARIO 3: Integration failed repair
// ===========================================================================

test("P0-C7 SCENARIO 3: Integration failed repair", async (t) => {
  await t.test("classifies integration_failed from blocker code", () => {
    const failure = classifyTaskFailure({
      codexResult: { failure_class: "integration_failed", summary: "Integration failed: merge conflict" },
    });
    assert.equal(failure.failure_class, "integration_failed");
    assert.equal(failure.repairable, true);
    assert.equal(failure.repair_strategy, "repair_integration");
  });

  await t.test("classifies integration_failed from integration_conflict text", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "integration_conflict", message: "Merge conflict in app.mjs" }] },
    });
    assert.equal(failure.failure_class, "integration_failed");
    assert.equal(failure.repairable, true);
  });

  await t.test("classifies integration_failed from push failure text", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "integration_push_failed", message: "Push rejected" }] },
    });
    assert.equal(failure.failure_class, "integration_failed");
    assert.equal(failure.repairable, true);
  });

  await t.test("integration_failed is repairable", () => {
    assert.equal(failureClassRequiresRepair("integration_failed"), true);
  });

  await t.test("integration_failed has structured definition", () => {
    const def = getFailureClassDefinition("integration_failed");
    assert.ok(def, "integration_failed should have a structured definition");
    assert.equal(def.repairable, true);
    assert.equal(def.nextStatusHint, "waiting_for_repair");
  });

  await t.test("buildRepairPrompt includes integration repair instructions", () => {
    const prompt = buildRepairPrompt({
      task: { id: "task_integration", title: "Fix integration", result: { summary: "Initial implementation" } },
      goal: { id: "goal_integration", goal_prompt: "Implement feature with integration" },
      failure: { failure_class: "integration_failed", reason: "PR failed checks", repair_strategy: "repair_integration" },
      verification: { commands: [{ cmd: "git push", exit_code: 1, stderr_tail: "push rejected" }] },
    });
    assert.match(prompt, /failure_class: integration_failed/);
    assert.match(prompt, /Integration step failed/);
  });

  await t.test("review state: integration_conflict routes to integration_recovery", () => {
    const result = classifyReviewState({ blockers: [{ code: "integration_conflict" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY);
  });

  await t.test("review state: integration_push_failed routes to integration_recovery", () => {
    const result = classifyReviewState({ blockers: [{ code: "integration_push_failed" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_INTEGRATION_RECOVERY);
  });
});

// ===========================================================================
// SCENARIO 4: Repair budget exhausted
// ===========================================================================

test("P0-C7 SCENARIO 4: Repair budget exhausted", async (t) => {
  await t.test("classifies repair_budget_exhausted from failure class", () => {
    const failure = classifyTaskFailure({
      codexResult: { failure_class: "repair_budget_exhausted", summary: "Repair budget exhausted after 3 attempts" },
    });
    assert.equal(failure.failure_class, "repair_budget_exhausted");
    assert.equal(failure.repairable, false);
    assert.equal(failure.repair_strategy, "human_interrupt_budget_exhausted");
  });

  await t.test("classifies repair_budget_exhausted from task failure_class", () => {
    const failure = classifyTaskFailure({
      task: { failure_class: "repair_budget_exhausted" },
    });
    assert.equal(failure.failure_class, "repair_budget_exhausted");
    assert.equal(failure.repairable, false);
  });

  await t.test("repair_budget_exhausted is terminal non-repairable", () => {
    assert.equal(failureClassIsTerminalNonRepairable("repair_budget_exhausted"), true);
    assert.equal(failureClassRequiresRepair("repair_budget_exhausted"), false);
  });

  await t.test("repair_budget_exhausted has structured definition", () => {
    const def = getFailureClassDefinition("repair_budget_exhausted");
    assert.ok(def, "repair_budget_exhausted should have a structured definition");
    assert.equal(def.repairable, false);
    assert.equal(def.nextStatusHint, "failed");
    assert.equal(def.confidence, "high");
    assert.match(def.description, /Repair budget exhausted/);
  });

  await t.test("shouldAttemptRepair returns false when budget exhausted", () => {
    const result = shouldAttemptRepair({
      task: { repair_attempt: 3, max_attempts: 3 },
      maxAttempts: 3,
    });
    assert.equal(result.should_repair, false);
    assert.match(result.reason, /exceeds max/);
  });

  await t.test("repair_budget_exhausted cannot be retried", () => {
    const failure = { failure_class: "repair_budget_exhausted", repairable: false };
    assert.equal(canRetryTask({ attempt: 0, max_attempts: 2 }, failure), false);
  });

  await t.test("review state: repair budget exhausted routes to human_interrupted", () => {
    const result = classifyReviewState({
      reason: "repair_budget_exhausted",
      blockers: [{ code: "repair_budget_exhausted" }],
      repairBudgetExhausted: true,
    });
    assert.equal(result.reviewState, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
  });

  await t.test("review state: repairBudgetExhausted flag takes priority over other blockers", () => {
    const result = classifyReviewState({
      reason: "repair_budget_exhausted",
      blockers: [{ code: "codex_failed" }, { code: "repair_budget_exhausted" }],
      repairBudgetExhausted: true,
    });
    assert.equal(result.reviewState, REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
  });

  await t.test("HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED has resume options", async (t) => {
    const { getResumeOptions, getNextAction } = await import("../src/task-review-status-taxonomy.mjs");
    const options = getResumeOptions(REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED);
    assert.ok(options.includes("review_exhausted"));
    assert.ok(options.includes("extend_budget"));
    assert.ok(options.includes("override_status"));
    assert.equal(getNextAction(REVIEW_STATES.HUMAN_INTERRUPTED_FOR_REPAIR_BUDGET_EXHAUSTED), "human_review_of_exhausted_repairs");
  });
});

// ===========================================================================
// ADDITIONAL: New failure class taxonomy consistency tests
// ===========================================================================

test("P0-C7: All 8 required failure classes are recognized", () => {
  const requiredClasses = [
    "execution_failed",
    "result_contract_invalid",
    "verification_failed",
    "acceptance_failed",
    "integration_failed",
    "deployment_failed",
    "context_missing",
    "repair_budget_exhausted",
  ];

  for (const fc of requiredClasses) {
    const def = getFailureClassDefinition(fc);
    assert.ok(def, `${fc} should have a structured definition`);

    // Check repairable classification matches accepted behavior
    if (fc === "deployment_failed" || fc === "repair_budget_exhausted") {
      assert.equal(def.repairable, false, `${fc} should be non-repairable`);
      assert.equal(failureClassIsTerminalNonRepairable(fc), true, `${fc} should be terminal`);
      assert.equal(failureClassRequiresRepair(fc), false, `${fc} should not require repair`);
    } else {
      assert.equal(def.repairable, true, `${fc} should be repairable`);
      assert.equal(failureClassIsTerminalNonRepairable(fc), false, `${fc} should not be terminal`);
      assert.equal(failureClassRequiresRepair(fc), true, `${fc} should require repair`);
    }
  }
});

test("P0-C7: deployment_failed is terminal and routes to human review", async (t) => {
  await t.test("classifies deployment_failed from text pattern", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "deployment_failed", message: "Deployment failed" }] },
    });
    assert.equal(failure.failure_class, "deployment_failed");
    assert.equal(failure.repairable, false);
  });

  await t.test("deployment_failed has structured definition", () => {
    const def = getFailureClassDefinition("deployment_failed");
    assert.ok(def);
    assert.equal(def.repairable, false);
    assert.equal(def.nextStatusHint, "failed");
  });

  await t.test("deployment_failed is terminal non-repairable", () => {
    assert.equal(failureClassIsTerminalNonRepairable("deployment_failed"), true);
    assert.equal(failureClassRequiresRepair("deployment_failed"), false);
  });

  await t.test("review state: deployment_failed routes to human review", () => {
    const result = classifyReviewState({ blockers: [{ code: "deployment_failed" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW);
  });
});

test("P0-C7: context_missing is repairable and routes to missing evidence repair", async (t) => {
  await t.test("classifies context_missing from text pattern", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "context_missing", message: "Required context is missing" }] },
    });
    assert.equal(failure.failure_class, "context_missing");
    assert.equal(failure.repairable, true);
  });

  await t.test("context_missing has structured definition", () => {
    const def = getFailureClassDefinition("context_missing");
    assert.ok(def);
    assert.equal(def.repairable, true);
    assert.equal(def.nextStatusHint, "waiting_for_repair");
  });

  await t.test("review state: context_missing routes to missing_evidence_repair", () => {
    const result = classifyReviewState({ blockers: [{ code: "context_missing" }] });
    assert.equal(result.reviewState, REVIEW_STATES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
  });
});

test("P0-C7: acceptance_failed is repairable and routes to contract repair", async (t) => {
  await t.test("classifies acceptance_failed from text pattern", () => {
    const failure = classifyTaskFailure({
      verification: { findings: [{ code: "acceptance_failed", message: "Acceptance criteria not met" }] },
    });
    assert.equal(failure.failure_class, "acceptance_failed");
    assert.equal(failure.repairable, true);
  });

  await t.test("acceptance_failed has structured definition", () => {
    const def = getFailureClassDefinition("acceptance_failed");
    assert.ok(def);
    assert.equal(def.repairable, true);
    assert.equal(def.nextStatusHint, "waiting_for_repair");
  });
});

test("P0-C7: verification_failed has structured definition", () => {
  const def = getFailureClassDefinition("verification_failed");
  assert.ok(def);
  assert.equal(def.repairable, true);
  assert.equal(def.nextStatusHint, "waiting_for_repair");
  assert.equal(failureClassRequiresRepair("verification_failed"), true);
});

test("P0-C7: createRepairGoalFromFindings tracks superseded_by_task_id and resolved_by_task_id", () => {
  const task = {
    id: "task_tracking",
    title: "Tracking test",
    root_task_id: "task_root_track",
    repair_attempt: 0,
    superseded_by_task_id: "task_superseder",
    resolved_by_task_id: "task_resolver",
  };
  const goal = { goal_prompt: "Test tracking fields" };
  const findings = [{ severity: "blocker", code: "execution_failed", message: "Failed" }];
  const repair = createRepairGoalFromFindings({ task, goal, findings });
  assert.equal(repair.superseded_by_task_id, "task_superseder");
  assert.equal(repair.resolved_by_task_id, "task_resolver");
  assert.equal(repair.repair_budget, 2); // default max_attempts
});

