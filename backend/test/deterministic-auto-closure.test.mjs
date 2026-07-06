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


test("sync operation kind completes cleanly", () => {
  const decision = decide({
    operationKind: "sync",
    result: { changed_files: [], status: "completed" },
  });

  assert.equal(decision.status, "auto_completed_clean");
  assert.equal(mapClosureStatusToTaskStatus(decision.status), "completed");
  assert.equal(decision.blocking_passed, true);
});

test("contract_invalid requires review", () => {
  const decision = decideTaskClosure({
    contract: null,
    contractVerification: {
      contract_valid: false,
      blockers: [{ code: "missing_contract", message: "No contract provided", severity: "blocker" }],
    },
    verification: { passed: true, findings: [] },
    result: { status: "completed", summary: "completed" },
    task: { id: "task_invalid" },
  });

  assert.equal(decision.status, "requires_review");
  assert.ok(decision.blockers.some((b) => b.code === "missing_contract"));
});

test("failed result status maps to failed closure", () => {
  const decision = decide({
    operationKind: "code_change",
    result: { status: "failed", summary: "Build failure" },
  });

  assert.equal(decision.status, "failed");
  assert.equal(mapClosureStatusToTaskStatus(decision.status), "failed");
});

test("missing commit evidence when requires_commit is set requires review", () => {
  const decision = decideTaskClosure({
    contract: {
      intent: { operation_kind: "code_change" },
      requirements: { requires_commit: true, requires_integration: false },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
    contractVerification: {
      contract_valid: true, blocking_passed: true, acceptance_status: "satisfied",
      completion_eligible: true, blockers: [], non_blocking_followups: [],
      quality_notes: [], state_assertions: { passed: true, failures: [] },
    },
    verification: { passed: true, findings: [], commands: [{ cmd: "check", exit_code: 0 }] },
    result: { status: "completed", summary: "code change done", changed_files: ["src/app.mjs"] },
    task: { id: "task_commit_missing" },
  });

  assert.equal(decision.status, "requires_review");
  assert.ok(decision.blockers.some((b) => b.code === "commit_evidence_missing"));
});

// ---------------------------------------------------------------------------
// P0-AFC2: Evidence classification rules
// ---------------------------------------------------------------------------

test("non_blocking_followups without unresolved blockers completes with followups", () => {
  const decision = decide({
    operationKind: "code_change",
    result: { changed_files: ["src/main.mjs"], commit: "abc123" },
    contractVerification: {
      non_blocking_followups: [{ title: "Refactor helpers", reason: "Post-beta polish" }],
      quality_notes: [],
    },
  });

  // Followups are non-blocking → auto_completed (not requires_review)
  assert.equal(decision.status, "auto_completed_with_followups");
  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.non_blocking_followups.length, 1);
  assert.equal(decision.quality_notes.length, 0);
});

test("quality notes without unresolved blockers completes with followups", () => {
  const decision = decide({
    operationKind: "diagnostic",
    result: { diagnostic_evidence: { summary: "ok" }, repo_mutated: false },
    contractVerification: {
      quality_notes: ["Consider adding explicit type annotations."],
      non_blocking_followups: [],
    },
  });

  // Quality notes are non-blocking → auto_completed (not requires_review)
  assert.equal(decision.status, "auto_completed_with_followups");
  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.quality_notes.length, 1);
  assert.equal(decision.non_blocking_followups.length, 0);
});

test("resolved findings (previously-blocking items now in followups) still complete cleanly", () => {
  // Scenario: blockers existed previously but were resolved — they now appear
  // only as followups, not in blockers.  Closure must not resurrect them.
  const decision = decide({
    operationKind: "code_change",
    result: { changed_files: ["src/lib.mjs"], commit: "def456" },
    contractVerification: {
      blockers: [],  // previously-blocking findings resolved
      non_blocking_followups: [
        { title: "Add missing docs", reason: "Resolved: commit exists, docs optional" },
      ],
      quality_notes: ["Ensure inline comments are added in follow-up PR."],
    },
  });

  assert.equal(decision.blocking_passed, true);
  assert.equal(decision.status, "auto_completed_with_followups");
  assert.equal(decision.blockers.length, 0);
  // Followups and notes are both propagated
  assert.equal(decision.non_blocking_followups.length, 1);
  assert.equal(decision.quality_notes.length, 1);
});

test("unresolved blockers produce requires_review", () => {
  const decision = decideTaskClosure({
    contract: {
      intent: { operation_kind: "code_change" },
      requirements: { requires_commit: false, requires_integration: false },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
    contractVerification: {
      contract_valid: true,
      blocking_passed: false,
      acceptance_status: "unsatisfied",
      completion_eligible: false,
      blockers: [
        { severity: "blocker", code: "state_assertion_failed", message: "Required test step not evidenced." },
      ],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, failures: [] },
    },
    verification: { passed: true, findings: [], commands: [{ cmd: "check", exit_code: 0 }] },
    result: { status: "completed", summary: "code change partial" },
    task: { id: "task_unresolved_blockers" },
  });

  assert.equal(decision.status, "requires_review");
  assert.equal(decision.blocking_passed, false);
  assert.ok(decision.blockers.length > 0);
  assert.ok(decision.blockers.some((b) => b.code === "state_assertion_failed"));
});

test("already-satisfied delivery evidence with already_integrated status completes cleanly", () => {
  // Scenario: a code_change task has already_integrated delivery evidence
  // (commit is already on canonical).  Even with requires_integration: true,
  // the system must NOT produce a false review/repair state.
  const decision = decide({
    operationKind: "code_change",
    contract: {
      requirements: { requires_integration: true, requires_commit: true },
    },
    result: {
      changed_files: ["src/fix.mjs"],
      commit: "aaa111",
      integration: {
        status: "already_integrated",
        merged: true,
        satisfied: true,
      },
    },
  });

  assert.equal(decision.blocking_passed, true);
  // Already-satisfied integration should not trigger requires_review
  assert.equal(decision.status, "auto_completed_clean");
  assert.equal(decision.blockers.length, 0);
});
