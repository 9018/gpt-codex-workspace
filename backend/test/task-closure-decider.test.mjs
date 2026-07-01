import test from "node:test";
import assert from "node:assert/strict";

import { applyClosureDecisionToTaskResult, decideTaskClosure } from "../src/closure/task-closure-decider.mjs";

function baseContract(overrides = {}) {
  return {
    intent: { operation_kind: "code_change", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: false, requires_deployment: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    ...overrides,
  };
}

function baseVerification(overrides = {}) {
  return {
    passed: true,
    commands: [{ cmd: "npm test", exit_code: 0 }],
    findings: [],
    ...overrides,
  };
}

function baseContractVerification(overrides = {}) {
  return {
    contract_valid: true,
    blocking_passed: true,
    acceptance_status: "satisfied",
    completion_eligible: true,
    blockers: [],
    non_blocking_followups: [],
    quality_notes: [],
    state_assertions: { passed: true, assertions: [], failures: [] },
    ...overrides,
  };
}

test("decideTaskClosure returns auto_completed_clean when blocking gate passes without followups", () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_clean" },
  });

  assert.equal(decision.status, "auto_completed_clean");
  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.auto_complete_allowed, true);
  assert.equal(decision.requires_human_decision, false);
  assert.equal(decision.quality_followups_count, 0);
});

test("decideTaskClosure returns auto_completed_with_followups for quality notes", () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification({ quality_notes: ["Refactor duplicated helper later."] }),
    verification: baseVerification(),
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_quality" },
  });

  assert.equal(decision.status, "auto_completed_with_followups");
  assert.equal(decision.reason, "blocking_gate_passed_with_non_blocking_followups");
  assert.equal(decision.requires_human_decision, false);
  assert.equal(decision.quality_followups_count, 1);
});

test("decideTaskClosure does not require review for non-blocking followups", () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification({
      non_blocking_followups: [{ title: "Add more edge-case tests", severity: "non_blocking" }],
    }),
    verification: baseVerification(),
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_followups" },
  });

  assert.equal(decision.status, "auto_completed_with_followups");
  assert.equal(decision.requires_human_decision, false);
  assert.deepEqual(decision.blockers, []);
});

test("decideTaskClosure requires review when commit evidence is missing", () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    result: { status: "completed", changed_files: ["src/app.mjs"] },
    task: { id: "task_missing_commit" },
  });

  assert.equal(decision.status, "requires_review");
  assert.equal(decision.requires_human_decision, true);
  assert.ok(decision.blockers.some((blocker) => blocker.code === "commit_evidence_missing"));
});

test("decideTaskClosure sends failed verification to waiting_for_repair by default", () => {
  const decision = decideTaskClosure({
    contract: baseContract(),
    contractVerification: baseContractVerification(),
    verification: baseVerification({ passed: false, findings: [{ code: "test_failed", message: "Tests failed" }] }),
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_failed_verification" },
  });

  assert.equal(decision.status, "waiting_for_repair");
  assert.equal(decision.requires_human_decision, false);
  assert.ok(decision.repairable_blockers.some((blocker) => blocker.code === "verification_not_passed"));
});

test("decideTaskClosure requires review for semantic ambiguity", () => {
  const decision = decideTaskClosure({
    contract: baseContract({ intent: { operation_kind: "code_change", semantic_confidence: "low" } }),
    contractVerification: baseContractVerification({ acceptance_status: "indeterminate" }),
    verification: baseVerification(),
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_ambiguous" },
  });

  assert.equal(decision.status, "requires_review");
  assert.ok(decision.blockers.some((blocker) => blocker.code === "semantic_ambiguity"));
});

test("decideTaskClosure does not treat branch_pushed as completed integration", () => {
  const decision = decideTaskClosure({
    contract: baseContract({ requirements: { requires_commit: true, requires_integration: true } }),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    integration: { status: "branch_pushed", merged: false, satisfied: false },
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_branch_pushed" },
  });

  assert.equal(decision.status, "waiting_for_repair");
  assert.ok(decision.repairable_blockers.some((blocker) => blocker.code === "integration_unsatisfied"));
});

test("decideTaskClosure accepts ff_only_merged with post-merge verification", () => {
  const decision = decideTaskClosure({
    contract: baseContract({ requirements: { requires_commit: true, requires_integration: true } }),
    contractVerification: baseContractVerification(),
    verification: baseVerification(),
    integration: { status: "ff_only_merged", satisfied: true, post_merge_verification: { passed: true } },
    result: { status: "completed", commit: "abc123", changed_files: ["src/app.mjs"] },
    task: { id: "task_ff_merged" },
  });

  assert.equal(decision.status, "auto_completed_clean");
});

test("applyClosureDecisionToTaskResult auto-completes with followups without requiring review", () => {
  const taskResult = { next_tasks: [{ title: "Existing", reason: "Already planned" }] };
  const decision = {
    status: "auto_completed_with_followups",
    task_status: "completed",
    reason: "blocking_gate_passed_with_non_blocking_followups",
  };

  const applied = applyClosureDecisionToTaskResult({
    taskStatus: "completed",
    taskResult,
    closureDecision: decision,
    plannedFollowups: [{ title: "Existing", reason: "Already planned" }, { title: "New followup", reason: "Useful later" }],
  });

  assert.equal(applied.taskStatus, "completed");
  assert.equal(applied.taskResult.requires_review, false);
  assert.equal(applied.taskResult.reason, "blocking_gate_passed_with_non_blocking_followups");
  assert.deepEqual(applied.taskResult.next_tasks.map((item) => item.title), ["Existing", "New followup"]);
});

test("applyClosureDecisionToTaskResult maps requires_review without creating blockers from quality notes", () => {
  const applied = applyClosureDecisionToTaskResult({
    taskStatus: "completed",
    taskResult: { quality_notes: ["Later polish"] },
    closureDecision: { status: "requires_review", task_status: "waiting_for_review", reason: "semantic_ambiguity" },
  });

  assert.equal(applied.taskStatus, "waiting_for_review");
  assert.equal(applied.taskResult.requires_review, true);
  assert.equal(applied.taskResult.reason, "semantic_ambiguity");
  assert.deepEqual(applied.taskResult.quality_notes, ["Later polish"]);
});

test("applyClosureDecisionToTaskResult maps waiting_for_repair decisions", () => {
  const applied = applyClosureDecisionToTaskResult({
    taskStatus: "completed",
    taskResult: { summary: "Needs repair" },
    closureDecision: { status: "waiting_for_repair", task_status: "waiting_for_repair", reason: "blocking_requirements_failed_repairable" },
  });

  assert.equal(applied.taskStatus, "waiting_for_repair");
  assert.equal(applied.taskResult.requires_review, false);
  assert.equal(applied.taskResult.reason, "blocking_requirements_failed_repairable");
});
