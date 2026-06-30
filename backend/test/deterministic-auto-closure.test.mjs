import test from "node:test";
import assert from "node:assert/strict";

import { decideTaskClosure, mapClosureStatusToTaskStatus } from "../src/closure/task-closure-decider.mjs";
import { planFollowupTasks } from "../src/closure/followup-task-planner.mjs";

function decide({ operationKind, result = {}, contractVerification = {}, contract = {}, verification = {} }) {
  const resolvedContract = {
    intent: { operation_kind: operationKind, semantic_confidence: "high", ...(contract.intent || {}) },
    requirements: { requires_commit: false, requires_integration: false, requires_deployment: false, ...(contract.requirements || {}) },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    ...contract,
  };
  return decideTaskClosure({
    contract: resolvedContract,
    contractVerification: {
      contract_valid: true,
      blocking_passed: true,
      acceptance_status: "satisfied",
      completion_eligible: true,
      blockers: [],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, failures: [] },
      ...contractVerification,
    },
    verification: { passed: true, findings: [], commands: [{ cmd: "check", exit_code: 0 }], ...verification },
    result: { status: "completed", operation_kind: operationKind, ...result },
    task: { id: `task_${operationKind}`, title: `${operationKind} task` },
  });
}

test("deterministic closure maps clean and followup statuses to completed", () => {
  const clean = decide({ operationKind: "diagnostic", result: { diagnostic_evidence: { summary: "ok" }, repo_mutated: false } });
  const followup = decide({
    operationKind: "diagnostic",
    result: { diagnostic_evidence: { summary: "ok" }, repo_mutated: false },
    contractVerification: { quality_notes: ["Make report prettier."] },
  });

  assert.equal(clean.status, "auto_completed_clean");
  assert.equal(followup.status, "auto_completed_with_followups");
  assert.equal(mapClosureStatusToTaskStatus(clean.status), "completed");
  assert.equal(mapClosureStatusToTaskStatus(followup.status), "completed");
});

test("restart health pass completes but health fail requires review", () => {
  const passed = decide({
    operationKind: "restart",
    contract: { requirements: { requires_runtime_health: true } },
    result: {
      restart_evidence: {
        restart_marker: "restart-1",
        before_pid: 10,
        after_pid: 11,
        health_check: { status: 200, runtime_commit_matches: true },
      },
      runtime: { running_commit: "abc123" },
      commit: "abc123",
    },
  });
  const failed = decide({
    operationKind: "restart",
    contract: { requirements: { requires_runtime_health: true } },
    result: {
      restart_evidence: {
        restart_marker: "restart-1",
        before_pid: 10,
        after_pid: 11,
        health_check: { status: 500 },
      },
    },
  });

  assert.equal(passed.status, "auto_completed_clean");
  assert.equal(failed.status, "requires_review");
  assert.ok(failed.blockers.some((blocker) => blocker.code === "deployment_health_unsatisfied"));
});

test("diagnostic report with no mutation completes", () => {
  const decision = decide({
    operationKind: "diagnostic",
    contract: { requirements: { requires_no_mutation: true } },
    result: { diagnostic_evidence: { summary: "No issue", repo_mutated: false }, repo_mutated: false },
  });

  assert.equal(decision.status, "auto_completed_clean");
});

test("cleanup dry-run and apply evidence completes", () => {
  const decision = decide({
    operationKind: "cleanup",
    result: {
      cleanup_evidence: {
        dry_run_summary: "Would remove 3 expired records",
        apply_summary: "Removed 3 expired records",
        before_counts: { expired: 3 },
        after_counts: { expired: 0 },
        active_items_preserved: true,
        audit_log_written: true,
      },
    },
  });

  assert.equal(decision.status, "auto_completed_clean");
});

test("admin command without audit requires review", () => {
  const decision = decide({
    operationKind: "admin_command",
    contract: { requirements: { requires_audit: true } },
    result: { admin_evidence: { command_id: "rotate-key", exit_code: 0, pre_state_snapshot: {}, post_state_snapshot: {} } },
  });

  assert.equal(decision.status, "requires_review");
  assert.ok(decision.blockers.some((blocker) => blocker.code === "audit_evidence_missing"));
});

test("followup planner output does not block current task completion", () => {
  const closureDecision = decide({
    operationKind: "diagnostic",
    result: { diagnostic_evidence: { summary: "ok" }, repo_mutated: false },
    contractVerification: { non_blocking_followups: [{ title: "Add dashboard", reason: "Operational polish" }] },
  });
  const nextTasks = planFollowupTasks({
    task: { id: "task_diag", title: "Run diagnostic" },
    goal: { id: "goal_diag" },
    closureDecision,
  });

  assert.equal(closureDecision.status, "auto_completed_with_followups");
  assert.equal(mapClosureStatusToTaskStatus(closureDecision.status), "completed");
  assert.equal(nextTasks.length, 1);
  assert.equal(nextTasks[0].auto_enqueue, false);
});

