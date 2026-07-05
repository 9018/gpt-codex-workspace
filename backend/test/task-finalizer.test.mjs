import test from "node:test";
import assert from "node:assert/strict";

import { decideTaskFinalState } from "../src/task-finalizer.mjs";

function passedEvidence(overrides = {}) {
  return {
    current_status: "completed",
    codex_result: {
      status: "completed",
      kind: "codex_executed",
      changed_files: ["backend/src/task-finalizer.mjs"],
      commit: "abc123",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      contract_verification: {
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
        blockers: [],
      },
      integration: { status: "merged", merged: true },
      acceptance_findings: [],
    },
    verification: { passed: true, findings: [] },
    acceptance: { passed: true, status: "accepted" },
    contract_verification: {
      blocking_passed: true,
      completion_eligible: true,
      requires_review: false,
      blockers: [],
    },
    integration: { required: true, status: "merged", merged: true },
    repair_budget: { attempts_remaining: 1 },
    ...overrides,
  };
}

test("task-finalizer: accepted verified contract-passed integration-satisfied evidence completes", () => {
  const decision = decideTaskFinalState(passedEvidence());

  assert.equal(decision.status, "completed");
  assert.equal(decision.safe_to_auto_advance, true);
  assert.equal(decision.reason, "terminal_evidence_satisfied");
});

test("task-finalizer: accepted verified code change waits for non-terminal integration", () => {
  const decision = decideTaskFinalState(passedEvidence({
    current_status: "waiting_for_integration",
    integration: { required: true, status: "branch_pushed", merged: false, pushed: true },
    codex_result: {
      ...passedEvidence().codex_result,
      integration: { status: "branch_pushed", merged: false, pushed: true },
    },
  }));

  assert.equal(decision.status, "waiting_for_integration");
  assert.equal(decision.safe_to_auto_advance, false);
  assert.equal(decision.reason, "integration_required_not_terminal");
});

test("task-finalizer: codex_failed with repair proposals and attempts remaining waits for repair", () => {
  const decision = decideTaskFinalState({
    current_status: "failed",
    codex_result: {
      status: "failed",
      kind: "codex_failed",
      summary: "Codex failed before writing result.json",
      stderr: "process exited 1",
      repair_proposals: [{ title: "Repair result", proposed_action: "Rerun finalizer" }],
    },
    verification: { passed: false, failure_class: "missing_result_json" },
    repair_budget: { attempts_remaining: 1 },
  });

  assert.equal(decision.status, "waiting_for_repair");
  assert.equal(decision.reason, "codex_failed_repairable");
  assert.equal(decision.repairable_blockers.length, 1);
});

test("task-finalizer: result_missing codex_failed with follow-up evidence is repair before terminal failure", () => {
  const decision = decideTaskFinalState({
    current_status: "failed",
    codex_result: {
      status: "failed",
      kind: "codex_failed",
      failure_class: "result_missing",
      summary: "Execution ended before result.json was produced",
      stderr: "process exited 1",
      repair_proposals: [{ title: "Repair missing result", proposed_action: "Re-run with output contract" }],
      delivery_result_recovery: { status: "failed", reason: "no_changed_files" },
    },
    verification: { passed: false, failure_class: "result_missing" },
    repair_budget: { attempts_remaining: 1 },
  });

  assert.equal(decision.status, "waiting_for_repair");
  assert.equal(decision.reason, "codex_failed_repairable");
  assert.equal(decision.repairable_blockers[0].code, "codex_failed");
});

test("task-finalizer: quota and rate-limit failures wait for capacity before repair or review", () => {
  const decision = decideTaskFinalState({
    current_status: "failed",
    codex_result: {
      status: "failed",
      kind: "codex_failed",
      summary: "OpenAI 429 rate_limit_exceeded insufficient_quota billing hard limit",
      repair_proposals: [{ title: "Do not use" }],
    },
    verification: { passed: false, failure_class: "test_failed" },
    repair_budget: { attempts_remaining: 2 },
  });

  assert.equal(decision.status, "waiting_for_capacity");
  assert.equal(decision.safe_to_auto_advance, false);
  assert.equal(decision.reason, "external_capacity_failure");
  assert.equal(decision.repairable_blockers.length, 0);
});

test("task-finalizer: semantic ambiguity and unsafe approval route to manual review", () => {
  const semantic = decideTaskFinalState(passedEvidence({
    contract_verification: { blocking_passed: true, completion_eligible: true, semantic_ambiguity: true, blockers: [] },
  }));
  const unsafe = decideTaskFinalState(passedEvidence({
    runtime_guard: { manual_approval_required: true, reason: "unsafe operation" },
  }));

  assert.equal(semantic.status, "waiting_for_review");
  assert.equal(semantic.reason, "manual_review_required");
  assert.equal(unsafe.status, "waiting_for_review");
  assert.equal(unsafe.reason, "manual_review_required");
});

test("task-finalizer: completed terminal evidence is idempotent despite stale review fields", () => {
  const evidence = passedEvidence({
    current_status: "completed",
    previous_status: "completed",
    codex_result: {
      ...passedEvidence().codex_result,
      requires_review: true,
      review_reason: "stale_result_contract_or_operational_guard",
      closure_decision: { status: "requires_review", reason: "stale_review" },
      acceptance_findings: [
        { severity: "blocker", code: "runtime_code_changed_without_safe_restart", message: "stale", resolved: true },
      ],
    },
  });

  const first = decideTaskFinalState(evidence);
  const second = decideTaskFinalState({ ...evidence, codex_result: { ...evidence.codex_result, finalizer_decision: first } });

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.safe_to_auto_advance, true);
});

test("task-finalizer: G8/G9/G10 style auto integration success maps to completed", () => {
  const decision = decideTaskFinalState(passedEvidence({
    integration: { required: true, status: "merged", merged: true, auto_completed: true },
    codex_result: {
      ...passedEvidence().codex_result,
      auto_integration_completion: {
        attempted: true,
        completed: true,
        verification_report: { passed: true, dirty: false },
      },
      integration: { status: "merged", merged: true, auto_completed: true },
    },
  }));

  assert.equal(decision.status, "completed");
  assert.equal(decision.integration_effect.status, "satisfied");
});

test("task-finalizer: unrecoverable failed execution can remain failed", () => {
  const decision = decideTaskFinalState({
    current_status: "failed",
    codex_result: { status: "failed", kind: "codex_failed", summary: "fatal non-repairable failure" },
    verification: { passed: false, failure_class: "unknown" },
    repair_budget: { attempts_remaining: 0 },
    policy: { terminal_failed_when_unrecoverable: true },
  });

  assert.equal(decision.status, "failed");
  assert.equal(decision.reason, "unrecoverable_execution_failure");
});

test("task-finalizer: P0-MA19 diagnostic/no-mutation task with changed_files=[] completes automatically", () => {
  const decision = decideTaskFinalState({
    current_status: "completed",
    codex_result: {
      status: "completed",
      kind: "codex_executed",
      operation_kind: "diagnostic",
      changed_files: [],
      commit: "abc123",
      no_mutation: true,
      needs_integration: false,
      acceptance_contract: {
        intent: { operation_kind: "diagnostic" },
        requirements: { requires_integration: false },
        verification_plan: { profile: "diagnostic", required_commands: [], report_must_be_clean: false },
        completion_policy: { auto_complete_when_blocking_requirements_pass: true },
        blocking_requirements: [
          { id: "diagnostic_report", evidence: ["report"] },
          { id: "no_mutation_evidence", evidence: ["no_mutation"] },
        ],
      },
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      contract_verification: {
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
        blockers: [],
      },
      acceptance_findings: [],
    },
    verification: { passed: true, findings: [] },
    acceptance: { passed: true, status: "accepted" },
    contract_verification: {
      blocking_passed: true,
      completion_eligible: true,
      requires_review: false,
      blockers: [],
    },
    integration: { required: false },
    repair_budget: { attempts_remaining: 0 },
  });

  assert.equal(decision.status, "completed",
    "Diagnostic task should be completed, not waiting_for_review");
  assert.equal(decision.safe_to_auto_advance, true,
    "Completed diagnostic task should allow auto-advance");
  assert.equal(decision.integration_effect.required, false,
    "Diagnostic task should not require integration");
});

test("task-finalizer: P0-MA19 diagnostic/no-mutation task without explicit no_mutation field still completes via terminal evidence", () => {
  const decision = decideTaskFinalState({
    current_status: "completed",
    codex_result: {
      status: "completed",
      kind: "codex_executed",
      changed_files: [],
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      contract_verification: {
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
        blockers: [],
      },
      acceptance_findings: [],
    },
    verification: { passed: true, findings: [] },
    acceptance: { passed: true, status: "accepted" },
    repair_budget: { attempts_remaining: 0 },
  });
  assert.equal(decision.status, "completed");
});
