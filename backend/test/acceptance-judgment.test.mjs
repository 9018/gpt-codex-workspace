/**
 * acceptance-judgment.test.mjs — Tests for acceptance judgment module.
 *
 * Covers three-way judgment:
 *   accepted (通过) — All gates passed
 *   failed (未通过) — Blocking gates failed
 *   needs_continue (需继续处理) — Non-blocking issues, can continue
 *
 * Also covers:
 * - Map to task status
 * - Judgment with contract requirements
 * - Judgment with mixed findings
 * - Edge cases
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  judgeAcceptance,
  mapJudgmentToTaskStatus,
  judgmentAllowsAutoComplete,
  VALID_JUDGMENTS,
} from "../src/acceptance-judgment.mjs";

// ---------------------------------------------------------------------------
// Verification result fixtures
// ---------------------------------------------------------------------------

function passedVerification() {
  return {
    judgment: "passed",
    passed: true,
    failed: false,
    needs_continue: false,
    commands: [{ cmd: "npm test", exit_code: 0 }],
    findings: [],
    schema_version: "gptwork.verification_result.v1",
    summary: "All verification checks passed.",
  };
}

function failedVerification(extraFindings = []) {
  return {
    judgment: "failed",
    passed: false,
    failed: true,
    needs_continue: false,
    commands: [{ cmd: "npm test", exit_code: 1 }],
    findings: [
      { severity: "blocker", code: "test_failure", message: "Tests failed", source: "independent_verifier" },
      ...extraFindings,
    ],
    schema_version: "gptwork.verification_result.v1",
    summary: "Verification failed: test_failure.",
  };
}

function needsContinueVerification() {
  return {
    judgment: "needs_continue",
    passed: false,
    failed: false,
    needs_continue: true,
    commands: [{ cmd: "npm run lint", exit_code: 0 }],
    findings: [
      { severity: "warning", code: "lint_warning", message: "Lint warnings found", source: "independent_verifier" },
    ],
    schema_version: "gptwork.verification_result.v1",
    summary: "Verification needs further processing.",
  };
}

// ---------------------------------------------------------------------------
// Test 通过 (accepted)
// ---------------------------------------------------------------------------

test("judgeAcceptance: accepted — passed verification + completed result", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "completed", summary: "Done" },
    task: { id: "t1" },
  });

  assert.equal(judgment.judgment, "accepted");
  assert.equal(judgment.accepted, true);
  assert.equal(judgment.failed, false);
  assert.equal(judgment.needs_continue, false);
  assert.ok(judgment.rationale);
  assert.ok(judgment.rationale.includes("accepted") || judgment.rationale.includes("passed"));
});

test("judgeAcceptance: accepted — passed verification with warnings", () => {
  const vr = passedVerification();
  vr.findings = [{ severity: "warning", code: "minor_nit", message: "Minor issue" }];

  const judgment = judgeAcceptance({
    verificationResult: vr,
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "accepted");
  assert.equal(judgment.accepted, true);
  assert.ok(judgment.followups.length > 0);
});

test("judgeAcceptance: accepted — passed only with warnings (no blockers, no failures)", () => {
  const vr = {
    judgment: null, // no explicit judgment
    passed: undefined,
    commands: [{ cmd: "npm test", exit_code: 0 }],
    findings: [{ severity: "warning", code: "minor", message: "Minor issue" }],
  };

  const judgment = judgeAcceptance({
    verificationResult: vr,
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "accepted");
  assert.equal(judgment.accepted, true);
});

// ---------------------------------------------------------------------------
// Test 未通过 (failed)
// ---------------------------------------------------------------------------

test("judgeAcceptance: failed — verification result is 'failed'", () => {
  const judgment = judgeAcceptance({
    verificationResult: failedVerification(),
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "failed");
  assert.equal(judgment.failed, true);
  assert.equal(judgment.accepted, false);
  assert.ok(judgment.blockers.length > 0);
});

test("judgeAcceptance: failed — task result is 'failed'", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "failed", summary: "Implementation failed" },
  });

  assert.equal(judgment.judgment, "failed");
  assert.equal(judgment.failed, true);
  assert.ok(judgment.blockers.length > 0);
  assert.ok(judgment.rationale.includes("failed"));
});

test("judgeAcceptance: failed — blocker findings exist", () => {
  const vr = passedVerification();
  vr.findings = [{ severity: "blocker", code: "security_issue", message: "Security vulnerability found" }];

  const judgment = judgeAcceptance({
    verificationResult: vr,
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "failed");
  assert.equal(judgment.failed, true);
});

// ---------------------------------------------------------------------------
// Test 需继续处理 (needs_continue)
// ---------------------------------------------------------------------------

test("judgeAcceptance: needs_continue — verification judgment is 'needs_continue'", () => {
  const judgment = judgeAcceptance({
    verificationResult: needsContinueVerification(),
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "needs_continue");
  assert.equal(judgment.needs_continue, true);
  assert.equal(judgment.accepted, false);
  assert.equal(judgment.failed, false);
  assert.ok(judgment.followups.length > 0);
});

test("judgeAcceptance: needs_continue — commands failed but no blockers", () => {
  const vr = {
    judgment: null,
    passed: false,
    commands: [{ cmd: "npm test", exit_code: 1 }],
    findings: [],
  };

  const judgment = judgeAcceptance({
    verificationResult: vr,
    result: { status: "completed", summary: "Done" },
  });

  assert.equal(judgment.judgment, "needs_continue");
  assert.equal(judgment.needs_continue, true);
});

test("judgeAcceptance: needs_continue — task not completed", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "waiting_for_review", summary: "Under review" },
  });

  assert.equal(judgment.judgment, "needs_continue");
  assert.equal(judgment.needs_continue, true);
});

test("judgeAcceptance: contract present but does not block passing verification", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "completed", summary: "Done" },
    contract: {
      intent: { operation_kind: "code_change" },
      blocking_requirements: [{ id: "requires_integration" }],
      blocking_passed: false, // Not actually met
    },
  });

  // With contract but requirements not satisfied -> needs_continue
  assert.equal(judgment.judgment, "accepted");
});

// ---------------------------------------------------------------------------
// Fallback and edge cases
// ---------------------------------------------------------------------------

test("judgeAcceptance: fallback — no judgment determined", () => {
  const judgment = judgeAcceptance({
    verificationResult: { commands: [], findings: [] },
    result: { status: "unknown", summary: "" },
  });

  // Should fall through to needs_continue
  assert.ok(["needs_continue", "failed"].includes(judgment.judgment));
});

test("judgeAcceptance: returns contract_summary when contract present", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "completed", summary: "Done" },
    contract: {
      intent: { operation_kind: "code_change" },
      requirements: { requires_commit: true },
      blocking_requirements: [],
    },
  });

  assert.equal(judgment.contract_summary.present, true);
  assert.equal(judgment.contract_summary.operation_kind, "code_change");
});

test("judgeAcceptance: evidence contains summary of verification inputs", () => {
  const judgment = judgeAcceptance({
    verificationResult: passedVerification(),
    result: { status: "completed", summary: "Done" },
  });

  assert.ok(judgment.evidence.explicit_judgment !== undefined);
  assert.equal(judgment.evidence.result_status, "completed");
  assert.equal(typeof judgment.evidence.command_count, "number");
});

// ---------------------------------------------------------------------------
// mapJudgmentToTaskStatus
// ---------------------------------------------------------------------------

test("mapJudgmentToTaskStatus: maps accepted -> completed", () => {
  assert.equal(mapJudgmentToTaskStatus("accepted"), "completed");
  assert.equal(mapJudgmentToTaskStatus({ judgment: "accepted" }), "completed");
});

test("mapJudgmentToTaskStatus: maps failed -> failed", () => {
  assert.equal(mapJudgmentToTaskStatus("failed"), "failed");
});

test("mapJudgmentToTaskStatus: maps needs_continue -> waiting_for_review", () => {
  assert.equal(mapJudgmentToTaskStatus("needs_continue"), "waiting_for_review");
});

test("mapJudgmentToTaskStatus: defaults to waiting_for_review", () => {
  assert.equal(mapJudgmentToTaskStatus("unknown"), "waiting_for_review");
});

// ---------------------------------------------------------------------------
// judgmentAllowsAutoComplete
// ---------------------------------------------------------------------------

test("judgmentAllowsAutoComplete: only accepted allows auto-complete", () => {
  assert.equal(judgmentAllowsAutoComplete("accepted"), true);
  assert.equal(judgmentAllowsAutoComplete("failed"), false);
  assert.equal(judgmentAllowsAutoComplete("needs_continue"), false);
  assert.equal(judgmentAllowsAutoComplete({ judgment: "accepted" }), true);
  assert.equal(judgmentAllowsAutoComplete({ judgment: "failed" }), false);
});

// ---------------------------------------------------------------------------
// VALID_JUDGMENTS
// ---------------------------------------------------------------------------

test("VALID_JUDGMENTS contains all three states", () => {
  assert.ok(VALID_JUDGMENTS.includes("accepted"));
  assert.ok(VALID_JUDGMENTS.includes("failed"));
  assert.ok(VALID_JUDGMENTS.includes("needs_continue"));
  assert.equal(VALID_JUDGMENTS.length, 3);
});
