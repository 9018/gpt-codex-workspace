/**
 * workstream-repair-budget.test.mjs
 * Tests for repair budget enforcement, deduplication, and escalation.
 *
 * Covers:
 *   - MAX_REPAIR_ATTEMPTS = 2
 *   - Repair record deduplication (same root_task_id + kind + attempt)
 *   - Escalation after budget exhaustion
 *   - Convergence goal dedup
 *   - Edge cases: partial accepts, blocked acceptance
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { scheduleRepairAction, findExistingRepairRecord, MAX_REPAIR_ATTEMPTS, REPAIR_KIND } from "../src/acceptance/workstream-repair-task-factory.mjs";

// ===========================================================================
// Budget constants
// ===========================================================================

test("MAX_REPAIR_ATTEMPTS is 2", () => {
  assert.equal(MAX_REPAIR_ATTEMPTS, 2);
});

// ===========================================================================
// Budget enforcement: first repair
// ===========================================================================

test("first repair attempt creates repair goal", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r1", id: "t1" },
    goal: { id: "g1" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_failed", message: "Tests failed" }],
    },
    currentAttempt: 0,
  });

  assert.equal(result.action, "create_repair_goal");
  assert.equal(result.payload.repair_attempt, 1);
  assert.equal(result.payload.max_attempts, 2);
  assert.equal(result.payload.failure_class, "failed");
  assert.equal(result.record.kind, REPAIR_KIND.REPAIR_TASK);
});

test("second repair attempt creates repair goal", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r2", id: "t2" },
    goal: { id: "g2" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_failed", message: "Tests still failing" }],
    },
    currentAttempt: 1,
  });

  assert.equal(result.action, "create_repair_goal");
  assert.equal(result.payload.repair_attempt, 2);
});

// ===========================================================================
// Budget exhaustion: third failed → escalation
// ===========================================================================

test("third failed attempt triggers ChatGPT escalation", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r3", id: "t3" },
    goal: { id: "g3" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_failed", message: "Tests failed thrice" }],
    },
    currentAttempt: 2, // Max attempts (=2) already used
  });

  assert.equal(result.action, "chatgpt_escalation");
  assert.ok(result.payload);
  assert.equal(result.payload.escalation_category, "acceptance_escalation");
  assert.equal(result.record.kind, REPAIR_KIND.CHATGPT_ESCALATION);
});

test("budget exhaustion with currentAttempt beyond max", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r4", id: "t4" },
    goal: { id: "g4" },
    acceptanceDecision: { verdict: "failed", findings: [] },
    currentAttempt: 5, // Well beyond max
  });

  assert.equal(result.action, "chatgpt_escalation");
});

// ===========================================================================
// Deduplication tests
// ===========================================================================

test("dedup: same repair task attempt not duplicated", () => {
  const records = [
    { root_task_id: "r5", kind: REPAIR_KIND.REPAIR_TASK, attempt: 1, id: "existing_repair_1" },
  ];

  const result = scheduleRepairAction({
    task: { root_task_id: "r5", id: "t5" },
    goal: { id: "g5" },
    acceptanceDecision: { verdict: "failed", findings: [] },
    repairRecords: records,
    currentAttempt: 0,
  });

  assert.equal(result.action, "deduplicated");
  assert.equal(result.existing_record.id, "existing_repair_1");
});

test("dedup: convergence goal not duplicated", () => {
  const records = [
    { root_task_id: "r6", kind: REPAIR_KIND.CONVERGENCE_GOAL, failure_class: "partial", id: "existing_convergence" },
  ];

  const result = scheduleRepairAction({
    task: { root_task_id: "r6", id: "t6" },
    goal: { id: "g6" },
    acceptanceDecision: { verdict: "partial", findings: [{ severity: "blocker", code: "b1" }, { severity: "blocker", code: "b2" }, { severity: "blocker", code: "b3" }, { severity: "minor", code: "m1" }] },
    repairRecords: records,
    currentAttempt: 0,
  });

  assert.equal(result.action, "deduplicated");
});

test("dedup: escalation not duplicated", () => {
  const records = [
    { root_task_id: "r7", kind: REPAIR_KIND.CHATGPT_ESCALATION, id: "existing_escalation" },
  ];

  const result = scheduleRepairAction({
    task: { root_task_id: "r7", id: "t7" },
    goal: { id: "g7" },
    acceptanceDecision: { verdict: "blocked", findings: [] },
    repairRecords: records,
  });

  assert.equal(result.action, "deduplicated");
});

// ===========================================================================
// findExistingRepairRecord edge cases
// ===========================================================================

test("findExistingRepairRecord: no match with different root_task_id", () => {
  const records = [
    { root_task_id: "r_a", kind: REPAIR_KIND.REPAIR_TASK, attempt: 1 },
  ];
  const result = findExistingRepairRecord({ repairRecords: records, rootTaskId: "r_b", kind: REPAIR_KIND.REPAIR_TASK, attempt: 1 });
  assert.equal(result.exists, false);
});

test("findExistingRepairRecord: convergence by root + kind + failureClass", () => {
  const records = [
    { root_task_id: "r8", kind: REPAIR_KIND.CONVERGENCE_GOAL, failure_class: "partial", id: "c1" },
  ];

  const result = findExistingRepairRecord({ repairRecords: records, rootTaskId: "r8", kind: REPAIR_KIND.CONVERGENCE_GOAL, failureClass: "partial" });
  assert.equal(result.exists, true);
  assert.equal(result.existing.id, "c1");
});

test("findExistingRepairRecord: convergence not match different failureClass", () => {
  const records = [
    { root_task_id: "r9", kind: REPAIR_KIND.CONVERGENCE_GOAL, failure_class: "partial", id: "c2" },
  ];

  const result = findExistingRepairRecord({ repairRecords: records, rootTaskId: "r9", kind: REPAIR_KIND.CONVERGENCE_GOAL, failureClass: "blocked" });
  assert.equal(result.exists, false);
});

// ===========================================================================
// Partial and blocked edge cases
// ===========================================================================

test("partial acceptance creates convergence goal", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r10", id: "t10" },
    goal: { id: "g10" },
    acceptanceDecision: {
      verdict: "partial",
      findings: [
        { severity: "blocker", code: "b1", message: "Blocker 1" },
        { severity: "blocker", code: "b2", message: "Blocker 2" },
        { severity: "blocker", code: "b3", message: "Blocker 3" },
        { severity: "minor", code: "n1", message: "Note" },
      ],
    },
    currentAttempt: 0,
  });

  assert.equal(result.action, "create_convergence_goal");
  assert.ok(result.payload);
  assert.equal(result.payload.failure_class, "partial_acceptance");
});

test("blocked acceptance triggers escalation", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r11" },
    acceptanceDecision: {
      verdict: "blocked",
      findings: [{ severity: "blocker", code: "env_issue", message: "Environment broken" }],
    },
  });

  assert.equal(result.action, "chatgpt_escalation");
  assert.ok(result.payload);
});

test("passed acceptance returns no action", () => {
  const result = scheduleRepairAction({
    task: { root_task_id: "r12" },
    acceptanceDecision: { verdict: "passed", findings: [] },
  });

  assert.equal(result.action, "none");
});
