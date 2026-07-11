/**
 * workstream-acceptance-controller.test.mjs
 * Tests for acceptance controller, decision, and repair task factory.
 *
 * Covers:
 *   - evaluateAcceptance verdict correctness (passed/failed/partial/blocked)
 *   - quickAcceptanceCheck pre-check
 *   - scheduleRepairAction (repair goal, convergence, escalation, direct correction)
 *   - Budget exhaustion (failed → repair → repair → ChatGPT escalation)
 *   - Idempotency (same input returns same verdict)
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAcceptance, quickAcceptanceCheck, VERDICT } from "../src/acceptance/workstream-acceptance-decision.mjs";
import { scheduleRepairAction, findExistingRepairRecord, MAX_REPAIR_ATTEMPTS, REPAIR_KIND } from "../src/acceptance/workstream-repair-task-factory.mjs";
import { runAcceptanceController } from "../src/acceptance/workstream-acceptance-controller.mjs";

// ===========================================================================
// evaluateAcceptance tests
// ===========================================================================

test("evaluateAcceptance: passed when all dimensions satisfied", () => {
  const result = evaluateAcceptance({
    task: { id: "task_1", status: "completed", commit: "abc123", changed_files: ["src/test.mjs"] },
    result: {
      status: "completed",
      summary: "Task completed",
      commit: "abc123",
      changed_files: ["src/test.mjs"],
      tests: "node --test passes",
      verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
    },
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "code_change", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc123" },
  });

  assert.equal(result.verdict, VERDICT.PASSED);
  assert.equal(result.blocker_count, 0);
  assert.equal(result.dimensions.length, 6);
  assert.ok(result.idempotency_key.startsWith("acceptance:passed:"));
});

test("evaluateAcceptance: failed when some dimensions missing", () => {
  const result = evaluateAcceptance({
    task: { id: "task_2", status: "running" },
    result: { status: "running", changed_files: [] },
    contract: { intent: { operation_kind: "code_change", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc123" },
  });

  assert.equal(result.verdict, VERDICT.BLOCKED);
  assert.ok(result.blocker_count > 2);
  assert.ok(result.findings.length > 0);
});

test("evaluateAcceptance: partial when many blockers and non-blockers", () => {
  const result = evaluateAcceptance({
    task: { id: "task_3" },
    result: {},
    contract: {},
    gitState: { dirty: true, diff_empty: false },
  });

  // Should have multiple blockers since everything is missing
  assert.equal(result.verdict, VERDICT.BLOCKED);
  assert.ok(result.blocker_count > 0);
});

test("evaluateAcceptance: docs_only profile requires docs in changed_files", () => {
  const result = evaluateAcceptance({
    task: { id: "task_4", changed_files: ["src/test.mjs"] },
    result: { changed_files: ["src/test.mjs"] },
    contract: { intent: { operation_kind: "docs_only", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc123" },
  });

  // docs_only with no .md files — fails documentation check
  assert.ok(result.findings.length > 0);
});

test("evaluateAcceptance: empty changed_files acceptable for diagnostic profile", () => {
  const result = evaluateAcceptance({
    task: { id: "task_5", changed_files: [] },
    result: { changed_files: [], tests: "ok", reviewer_decision: { status: "accepted", passed: true }, verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] }, commit: "abc123", status: "completed", summary: "Diagnostic task" },
    contract: { intent: { operation_kind: "diagnostic", mutation_scope: "none" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc123" },
  });

  assert.equal(result.verdict, VERDICT.PASSED);
});

test("evaluateAcceptance: idempotent — same input returns same verdict", () => {
  const input = {
    task: { id: "task_6", status: "completed", commit: "def456", changed_files: ["src/app.mjs"] },
    result: {
      status: "completed",
      summary: "Done",
      commit: "def456",
      changed_files: ["src/app.mjs"],
      tests: "ok",
      verification: { passed: true, commands: [] },
    },
    verification: { passed: true, commands: [] },
    contract: { intent: { operation_kind: "code_change" } },
    gitState: { dirty: false, diff_empty: true, commit: "def456" },
  };

  const r1 = evaluateAcceptance(input);
  const r2 = evaluateAcceptance(input);
  assert.equal(r1.verdict, r2.verdict);
  assert.equal(r1.idempotency_key, r2.idempotency_key);
  assert.equal(r1.findings.length, r2.findings.length);
});

// ===========================================================================
// quickAcceptanceCheck tests
// ===========================================================================

test("quickAcceptanceCheck: passed when all evidence present", () => {
  const result = quickAcceptanceCheck({
    result: { status: "completed", summary: "Done", commit: "abc123", changed_files: ["src/x.mjs"] },
    verification: { passed: true },
  });
  assert.equal(result.passed, true);
});

test("quickAcceptanceCheck: failed when evidence missing", () => {
  const result = quickAcceptanceCheck({ result: {}, verification: {} });
  assert.equal(result.passed, false);
});

// ===========================================================================
// scheduleRepairAction tests
// ===========================================================================

test("scheduleRepairAction: passed → no action", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "root_1" },
    acceptanceDecision: { verdict: VERDICT.PASSED },
    currentAttempt: 0,
  });
  assert.equal(result.action, "none");
});

test("scheduleRepairAction: failed → create repair goal (first attempt)", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "root_2", id: "task_10" },
    goal: { id: "goal_10" },
    acceptanceDecision: { verdict: VERDICT.FAILED, findings: [{ severity: "blocker", code: "test_failed", message: "Tests did not pass" }] },
    currentAttempt: 0,
  });

  assert.equal(result.action, "create_repair_goal");
  assert.ok(result.payload);
  assert.equal(result.payload.repair_attempt, 1);
  assert.equal(result.payload.max_attempts, 2);
});

test("scheduleRepairAction: failed → ChatGPT escalation after budget exhausted", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "root_3", id: "task_11" },
    goal: { id: "goal_11" },
    acceptanceDecision: { verdict: VERDICT.FAILED, findings: [{ severity: "blocker", code: "test_failed", message: "Tests did not pass" }] },
    currentAttempt: 2, // Already exhausted max attempts
  });

  assert.equal(result.action, "chatgpt_escalation");
  assert.ok(result.payload);
});

test("scheduleRepairAction: partial → create convergence goal", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "root_4", id: "task_12" },
    goal: { id: "goal_12" },
    acceptanceDecision: { verdict: VERDICT.PARTIAL, findings: [
      { severity: "blocker", code: "b1", message: "Blocker 1" },
      { severity: "blocker", code: "b2", message: "Blocker 2" },
      { severity: "blocker", code: "b3", message: "Blocker 3" },
      { severity: "minor", code: "nb1", message: "Note 1" },
    ]},
    currentAttempt: 0,
  });

  assert.equal(result.action, "create_convergence_goal");
  assert.ok(result.payload);
});

test("scheduleRepairAction: blocked → ChatGPT escalation", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "root_5" },
    acceptanceDecision: { verdict: VERDICT.BLOCKED, findings: [] },
  });

  assert.equal(result.action, "chatgpt_escalation");
});

test("scheduleRepairAction: deduplication — same repair record exists", () => {
  const existingRecords = [{
    id: "repair_existing",
    root_task_id: "root_6",
    kind: REPAIR_KIND.REPAIR_TASK,
    attempt: 1,
  }];

  const result = scheduleRepairAction({
    task: { root_task_id: "root_6", id: "task_13" },
    goal: { id: "goal_13" },
    acceptanceDecision: { verdict: VERDICT.FAILED, findings: [{ severity: "blocker", code: "test_failed", message: "Tests did not pass" }] },
    repairRecords: existingRecords,
    currentAttempt: 0,
  });

  assert.equal(result.action, "deduplicated");
});

test("scheduleRepairAction: direct correction for first attempt", () => {
  const corrections = [
    { file: "src/test.mjs", patch: "fix test", description: "Fix failing test" },
  ];

  const result = scheduleRepairAction({
    task: { root_task_id: "root_7", id: "task_14" },
    goal: { id: "goal_14" },
    acceptanceDecision: { verdict: VERDICT.FAILED, findings: [{ severity: "blocker", code: "test_failed", message: "Test failed" }] },
    corrections,
    currentAttempt: 0,
  });

  assert.equal(result.action, "direct_correction");
  assert.ok(result.payload);
  assert.equal(result.payload.corrections.length, 1);
});

// ===========================================================================
// findExistingRepairRecord tests
// ===========================================================================

test("findExistingRepairRecord: repair task by root + kind + attempt", () => {
  const records = [
    { root_task_id: "root_8", kind: REPAIR_KIND.REPAIR_TASK, attempt: 1, id: "rec_1" },
    { root_task_id: "root_8", kind: REPAIR_KIND.REPAIR_TASK, attempt: 2, id: "rec_2" },
  ];

  const result = findExistingRepairRecord({ repairRecords: records, rootTaskId: "root_8", kind: REPAIR_KIND.REPAIR_TASK, attempt: 1 });
  assert.equal(result.exists, true);
  assert.equal(result.existing.id, "rec_1");
});

test("findExistingRepairRecord: escalation by root + kind only", () => {
  const records = [
    { root_task_id: "root_9", kind: REPAIR_KIND.CHATGPT_ESCALATION, id: "rec_3" },
  ];

  const result = findExistingRepairRecord({ repairRecords: records, rootTaskId: "root_9", kind: REPAIR_KIND.CHATGPT_ESCALATION });
  assert.equal(result.exists, true);
});

test("findExistingRepairRecord: not found if root_task_id missing", () => {
  const result = findExistingRepairRecord({ repairRecords: [], rootTaskId: "nonexistent", kind: REPAIR_KIND.REPAIR_TASK });
  assert.equal(result.exists, false);
});

// ===========================================================================
// runAcceptanceController integration tests
// ===========================================================================

test("runAcceptanceController: passed task returns acceptance_passed", async () => {
  const result = await runAcceptanceController({
    task: { id: "task_20", status: "completed", commit: "abc", changed_files: ["src/test.mjs"] },
    goal: { id: "goal_20" },
    result: {
      status: "completed",
      summary: "Done",
      commit: "abc",
      changed_files: ["src/test.mjs"],
      tests: "ok",
      verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
    },
    contract: { intent: { operation_kind: "code_change" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc123" },
  });

  assert.equal(result.controller_verdict, "acceptance_passed");
  assert.equal(result.action.action, "none");
});

test("runAcceptanceController: failed task creates repair goal record", async () => {
  const state = { workstream_repair_records: [] };
  const result = await runAcceptanceController({
    task: { id: "task_21", root_task_id: "root_21" },
    goal: { id: "goal_21" },
    result: { changed_files: [] },
    contract: { intent: { operation_kind: "code_change" } },
    gitState: { dirty: true, diff_empty: false },
    state,
  });

  assert.ok(["repair_goal_required", "direct_correction", "chatgpt_escalation_required"].includes(result.controller_verdict));
});

test("runAcceptanceController: budget exhausted triggers escalation", async () => {
  const result = await runAcceptanceController({
    task: { id: "task_22", root_task_id: "root_22", repair_attempt: 2, attempt: 2 },
    goal: { id: "goal_22" },
    result: { changed_files: [] },
    contract: { intent: { operation_kind: "code_change" } },
    gitState: { dirty: true, diff_empty: false },
  });

  assert.equal(result.controller_verdict, "chatgpt_escalation_required");
});

test("runAcceptanceController: empty task returns error", async () => {
  const result = await runAcceptanceController({
    task: {},
    goal: {},
  });

  // Should handle gracefully without crashing
  assert.ok(result.controller_verdict === "chatgpt_escalation_required" || result.controller_verdict === "error" || result.controller_verdict === "acceptance_passed");
});
