/**
 * p0-07-codex-exec-production-hardening.test.mjs
 *
 * Tests for codex_exec production path hardening.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// =========================================================================
// 1. classifyRunFailure — no_first_output_timeout
// =========================================================================

test("classifyRunFailure: no_first_output_timeout returns failure_class", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    noFirstOutputTimeout: true,
    exitCode: null,
    stdout: "",
    stderr: "no first output",
  });

  assert.equal(result.failure_class, "no_first_output_timeout");
  assert.equal(result.severity, "recoverable");
  assert.equal(result.creates_repair_task, false);
  assert.equal(result.creates_retry_followup, true);
});

test("classifyRunFailure: no_first_output_timeout has P0-07 fields", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    noFirstOutputTimeout: true,
    exitCode: null,
  });

  assert.equal(result.can_auto_retry, true);
  assert.equal(result.healing_action, "compact_and_retry");
  assert.equal(result.creates_delivery_recovery, false);
  assert.equal(result.review_reason, null);
  assert.equal(result.diagnostics.no_first_output_timeout, true);
});

// =========================================================================
// 2. classifyRunFailure — codex_timeout (timedOut flag)
// =========================================================================

test("classifyRunFailure: timedOut without evidence", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    timedOut: true,
    exitCode: null,
    stdout: "",
    stderr: "",
    hasCommit: false,
    hasGitChanges: false,
  });

  assert.equal(result.failure_class, "codex_timeout");
  assert.equal(result.severity, "failed");
  assert.equal(result.can_auto_retry, true);
  assert.equal(result.healing_action, "compact_and_retry");
  assert.equal(result.creates_delivery_recovery, false);
  assert.equal(result.review_reason, null);
});

test("classifyRunFailure: timedOut with partial evidence", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    timedOut: true,
    exitCode: null,
    stdout: "partial output",
    stderr: "",
    hasCommit: true,
    hasGitChanges: true,
  });

  assert.equal(result.failure_class, "codex_timeout");
  assert.equal(result.severity, "recoverable");
  assert.equal(result.can_auto_retry, true);
  assert.equal(result.healing_action, "compact_and_retry");
  assert.equal(result.creates_delivery_recovery, true);
  assert.equal(result.review_reason, "codex_timeout_with_partial_evidence");
  assert.ok(result.detected_reason.includes("commit=true"));
  assert.ok(result.detected_reason.includes("git_changes=true"));
  assert.ok(result.detected_reason.includes("stdout=true"));
});

test("classifyRunFailure: timedOut flag in diagnostics", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    timedOut: true,
    exitCode: 124,
  });

  assert.equal(result.diagnostics.timed_out, true);
  assert.equal(result.diagnostics.no_first_output_timeout, false);
  assert.equal(result.failure_class, "codex_timeout");
});

test("classifyRunFailure: no timeout flags, normal failure falls to existing classifiers", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    exitCode: 1,
    stdout: "",
    stderr: "error occurred",
    hasCommit: false,
    hasGitChanges: false,
    hasResultJson: false,
  });

  assert.equal(result.failure_class, "codex_failed");
});

// =========================================================================
// 3. classifyRunFailure — existing paths still work
// =========================================================================

test("classifyRunFailure: quota_exhausted still works", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    stdout: "",
    stderr: "429 Too Many Requests",
    exitCode: 1,
  });

  assert.equal(result.failure_class, "quota_exhausted_or_rate_limited");
});

test("classifyRunFailure: result_missing classified correctly", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    exitCode: 0,
    stdout: "some output",
    stderr: "",
    hasResultJson: false,
    resultJson: null,
    hasCommit: false,
    hasGitChanges: false,
  });

  assert.equal(result.failure_class, "result_missing");
});

test("classifyRunFailure: no_result_json_with_commit still works", async () => {
  const { classifyRunFailure } = await import("../src/codex-run-diagnostics.mjs");

  const result = classifyRunFailure({
    exitCode: 0,
    stdout: "committed",
    hasCommit: true,
    hasResultJson: false,
    hasGitChanges: false,
  });

  assert.equal(result.failure_class, "no_result_json_with_commit");
});

// =========================================================================
// 4. Self-healing policy — DIRTY_WORKTREE_AFTER_CODEX
// =========================================================================

test("classifyError: dirty worktree returns DIRTY_WORKTREE_AFTER_CODEX", async () => {
  const { classifyError, ERROR_CATEGORIES } = await import("../src/self-healing-policy.mjs");

  const r1 = classifyError(new Error("dirty worktree after codex"));
  assert.equal(r1.category, ERROR_CATEGORIES.DIRTY_WORKTREE_AFTER_CODEX);
  assert.equal(r1.code, "dirty_worktree_after_codex");
  assert.equal(r1.recoverable, true);

  const r2 = classifyError(new Error("dirty_worktree_after_codex detected"));
  assert.equal(r2.category, ERROR_CATEGORIES.DIRTY_WORKTREE_AFTER_CODEX);

  const r3 = classifyError(new Error("worktree is dirty"));
  assert.equal(r3.category, ERROR_CATEGORIES.DIRTY_WORKTREE_AFTER_CODEX);
});

test("determineHealingAction: dirty worktree classified but budget=0", async () => {
  const { determineHealingAction, classifyError, ERROR_CATEGORIES } = await import("../src/self-healing-policy.mjs");

  const action = determineHealingAction({
    error: new Error("dirty worktree after codex"),
    task: { id: "t1" },
    retryCount: 0,
  });

  // retry_budget=0 → falls to waiting_for_human_review
  assert.equal(action.action, "waiting_for_human_review");

  const cls = classifyError(new Error("dirty worktree after codex"));
  assert.equal(cls.category, ERROR_CATEGORIES.DIRTY_WORKTREE_AFTER_CODEX);
});

// =========================================================================
// 5. Self-healing policy — CHANGED_FILES_MISMATCH
// =========================================================================

test("classifyError: changed_files mismatch", async () => {
  const { classifyError, ERROR_CATEGORIES } = await import("../src/self-healing-policy.mjs");

  const r1 = classifyError(new Error("changed_files mismatch: expected different files"));
  assert.equal(r1.category, ERROR_CATEGORIES.CHANGED_FILES_MISMATCH);
  assert.equal(r1.recoverable, true);

  const r2 = classifyError(new Error("changed_files inconsistent"));
  assert.equal(r2.category, ERROR_CATEGORIES.CHANGED_FILES_MISMATCH);

  const r3 = classifyError(new Error("changed_files discrepancy"));
  assert.equal(r3.category, ERROR_CATEGORIES.CHANGED_FILES_MISMATCH);
});

test("determineHealingAction: changed_files mismatch classified but budget=0", async () => {
  const { determineHealingAction, classifyError, ERROR_CATEGORIES } = await import("../src/self-healing-policy.mjs");

  const action = determineHealingAction({
    error: new Error("changed_files mismatch"),
    retryCount: 0,
  });

  assert.equal(action.action, "waiting_for_human_review");

  const cls = classifyError(new Error("changed_files mismatch error"));
  assert.equal(cls.category, ERROR_CATEGORIES.CHANGED_FILES_MISMATCH);
});

// =========================================================================
// 6. No-mutation + changed_files=[] acceptance
// =========================================================================

test("no-mutation task: changed_files=[] accepted for diagnostic tasks", async () => {
  const isDiagnostic = (result) => {
    return (result.operation_kind === 'diagnostic')
      || (result.acceptance_profile === 'diagnostic')
      || (result.mutation_scope === 'none');
  };

  assert.equal(isDiagnostic({ operation_kind: 'diagnostic' }), true);
  assert.equal(isDiagnostic({ acceptance_profile: 'diagnostic' }), true);
  assert.equal(isDiagnostic({ mutation_scope: 'none' }), true);
  assert.equal(isDiagnostic({ operation_kind: 'codex_exec' }), false);
  assert.equal(isDiagnostic({}), false);
});

// =========================================================================
// 7. analyzeDeliveryRecoveryCandidate — handles resolved repo without worktree
// =========================================================================

test("analyzeDeliveryRecoveryCandidate: handles resolved repo without worktree", async () => {
  const { analyzeDeliveryRecoveryCandidate } = await import("../src/delivery-result-recovery.mjs");

  const candidate = analyzeDeliveryRecoveryCandidate({
    task: { id: "task_no_changes" },
    taskResult: {
      changed_files: [],
      commit: "abc123def456",
      acceptance_findings: [{ code: "commit_missing" }],
    },
    parsedResult: { status: "completed", changed_files: [], commit: "abc123def456" },
    resolvedRepo: {},
    cr: { returncode: 0 },
  });

  assert.equal(candidate.attempted, true);
  assert.ok(candidate.blockers.length > 0);
  assert.ok(candidate.blockers.some((b) => b.code === "not_git_worktree"));
});

// =========================================================================
// 8. task-codex-execution utilities
// =========================================================================

test("extractHeaderMetadata: parses model/provider/reasoning", async () => {
  const { extractHeaderMetadata } = await import("../src/task-codex-execution.mjs");

  const meta = extractHeaderMetadata("model: gpt-4o\nprovider: openai\nreasoning effort: high\n");
  assert.equal(meta.model, "gpt-4o");
  assert.equal(meta.provider, "openai");
  assert.equal(meta.reasoning_effort, "high");

  const emptyMeta = extractHeaderMetadata("");
  assert.equal(emptyMeta.model, null);
  assert.equal(emptyMeta.provider, null);
  assert.equal(emptyMeta.reasoning_effort, null);
});

test("isCodexContentfulOutput: detects meaningful content", async () => {
  const { isCodexContentfulOutput } = await import("../src/task-codex-execution.mjs");

  assert.equal(isCodexContentfulOutput({ streamName: "stderr", chunk: "" }), false);
  assert.equal(isCodexContentfulOutput({ streamName: "stdout", chunk: "" }), false);
  assert.equal(isCodexContentfulOutput({ streamName: "stdout", chunk: "model: gpt-4o\nprovider: openai\n" }), true);
  assert.equal(isCodexContentfulOutput({ streamName: "stdout", chunk: "banner line" }), true);
});

test("resolveCodexExecArgs: returns default when no args configured", async () => {
  const { resolveCodexExecArgs } = await import("../src/task-codex-execution.mjs");

  const args = resolveCodexExecArgs({});
  assert.equal(args, "--yolo --skip-git-repo-check");
});

// =========================================================================
// 9. normalizeCommit
// =========================================================================

test("normalizeCommit: empty values return null", () => {
  const EMPTY_COMMIT_VALUES = new Set(["", "none", "null", "undefined"]);

  function normalizeCommit(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return EMPTY_COMMIT_VALUES.has(text.toLowerCase()) ? null : text;
  }

  assert.equal(normalizeCommit(null), null);
  assert.equal(normalizeCommit(undefined), null);
  assert.equal(normalizeCommit(""), null);
  assert.equal(normalizeCommit("none"), null);
  assert.equal(normalizeCommit("abc123"), "abc123");
});

// =========================================================================
// 10. Self-healing: network errors not affected
// =========================================================================

test("classifyError: network errors unaffected", async () => {
  const { classifyError, ERROR_CATEGORIES } = await import("../src/self-healing-policy.mjs");

  const rateLimited = classifyError(new Error("429 Too Many Requests"));
  assert.equal(rateLimited.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(rateLimited.retry_budget, 3);

  const gateway = classifyError(new Error("502 Bad Gateway"));
  assert.equal(gateway.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(gateway.retry_budget, 3);
});

// =========================================================================
// 11. task-final-writeback module loads
// =========================================================================

test("task-final-writeback module loads", async () => {
  const mod = await import("../src/task-final-writeback.mjs");
  assert.ok(typeof mod.finalizeCodexTaskRun === "function");
});

