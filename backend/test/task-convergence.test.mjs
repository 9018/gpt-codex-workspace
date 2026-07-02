/**
 * task-convergence.test.mjs — Tests for the unified convergence module.
 *
 * P0: Tests the convergeTaskAfterRun function and its decision matrix.
 *
 * Covers:
 *   - Acceptance passed + verification passed → completed
 *   - 429/quota → quota_wait (no repair)
 *   - 502/503/gateway → retry_wait (no repair)
 *   - Verification failed → waiting_for_repair
 *   - sync_only success → completed (no tests needed)
 *   - verification_only success → completed (no tests needed)
 *   - result missing + no diff → retry_wait
 *   - result missing + diff → waiting_for_review
 *   - Repair exhausted → blocked/failed
 *   - Runtime changes → restart_pending
 */

import test from "node:test";
import assert from "node:assert/strict";
import { convergeTaskAfterRun, CONVERGENCE_STATUSES, CLOSURE_REASONS, detectAcceptanceProfile, consolidateBatchConvergence } from "../src/task-convergence.mjs";

// ---------------------------------------------------------------------------
// 1. Acceptance passed + verification passed → completed
// ---------------------------------------------------------------------------

test("converge: accepted + verified → completed", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t1", status: "running", title: "Test task" },
    taskResult: {
      status: "completed",
      summary: "Task completed successfully",
      verification: { passed: true },
    },
    acceptance: {
      passed: true,
      status: "accepted",
      findings: [],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
  assert.equal(result.closureReason, CLOSURE_REASONS.ACCEPTED);
  assert.equal(result.repairPlan, null);
  assert.equal(result.retryPlan, null);
});

// ---------------------------------------------------------------------------
// 2. 429/quota → quota_wait, no repair
// ---------------------------------------------------------------------------

test("converge: rate_limited → quota_wait, no repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t2", status: "running" },
    taskResult: {
      failure_class: "rate_limited",
      summary: "429 Too Many Requests",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.QUOTA_WAIT);
  assert.equal(result.repairPlan, null, "429 should NOT create a repair plan");
  assert.ok(result.retryPlan !== null, "429 should have a retry plan");
  assert.ok(result.retryPlan.delay > 0, "429 should have a backoff delay");
});

test("converge: quota_exceeded → quota_wait, no repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t2b", status: "running" },
    taskResult: {
      failure_class: "quota_exceeded",
      summary: "quota exceeded for API usage",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.QUOTA_WAIT);
  assert.equal(result.repairPlan, null);
});

// ---------------------------------------------------------------------------
// 3. 502/503/gateway → retry_wait, no repair
// ---------------------------------------------------------------------------

test("converge: gateway_error → retry_wait, no repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t3", status: "running" },
    taskResult: {
      failure_class: "gateway_error",
      summary: "502 Bad Gateway",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(result.repairPlan, null, "gateway error should NOT create a repair plan");
  assert.ok(result.retryPlan !== null);
});

test("converge: service_unavailable → retry_wait, no repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t3b", status: "running" },
    taskResult: {
      failure_class: "service_unavailable",
      summary: "503 Service Unavailable",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(result.repairPlan, null);
});

// ---------------------------------------------------------------------------
// 4. Verification failed → waiting_for_repair
// ---------------------------------------------------------------------------

test("converge: verification failed → waiting_for_repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t4", status: "running", repair_attempt: 0 },
    taskResult: {
      status: "completed",
      summary: "Tests failed",
      verification: { passed: false },
      failure_class: "verification_failed",
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "blocker", code: "test_failed", message: "tests failed" }],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.WAITING_FOR_REPAIR);
  assert.ok(result.repairPlan !== null, "Should have a repair plan");
});


test("detectAcceptanceProfile: builder-mode repository sync task is sync_only", () => {
  const profile = detectAcceptanceProfile(
    {
      id: "sync-builder",
      mode: "builder",
      title: "P0: 同步本地 main 到远端 main",
      description: "同步当前本地 main 到远端 main，报告 local_head remote_head ahead/behind",
    },
    {
      kind: "codex_executed",
      changed_files: [],
      commit: "abc123",
      remote_head: "abc123",
      verification: { passed: true },
      summary: "remote head updated, ahead/behind 0/0",
    }
  );
  assert.equal(profile, "sync_only");
});

// ---------------------------------------------------------------------------
// 5. sync_only success → completed (no tests/changed_files needed)
// ---------------------------------------------------------------------------

test("converge: builder-mode repository sync with tests_missing → completed", () => {
  const result = convergeTaskAfterRun({
    task: {
      id: "sync-builder-converge",
      status: "running",
      mode: "builder",
      title: "P0: 同步1b6a359到远端main",
      description: "同步当前本地 main 到远端 main，报告 local_head remote_head ahead/behind",
    },
    taskResult: {
      status: "completed",
      summary: "remote head updated, ahead/behind 0/0",
      changed_files: [],
      commit: "abc123",
      remote_head: "abc123",
      verification: { passed: true },
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "major", code: "tests_missing", message: "Contract violation: tests_missing" }],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
  assert.equal(result.profile, "sync_only");
});

test("converge: sync_only with non-blocker findings → completed", () => {
  // sync_only with tests_missing finding should still complete
  const result = convergeTaskAfterRun({
    task: { id: "t5", status: "running", mode: "sync" },
    taskResult: {
      status: "completed",
      summary: "Sync completed",
      verification: { passed: true },
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "major", code: "tests_missing", message: "No tests" }],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "sync_only with tests_missing should complete");
});

// ---------------------------------------------------------------------------
// 6. verification_only success → completed
// ---------------------------------------------------------------------------

test("converge: verification_only with tests_missing → completed", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t6", status: "running", mode: "verification" },
    taskResult: {
      status: "completed",
      summary: "Verification passed",
      verification: { passed: true },
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "major", code: "tests_missing", message: "No tests" }],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "verification_only with tests_missing should complete");
});

// ---------------------------------------------------------------------------
// 7. result missing + no diff → retry_wait
// ---------------------------------------------------------------------------

test("converge: result missing + no diff → retry_wait", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t7", status: "running" },
    taskResult: { summary: "No result produced" },  // No status/kind → result missing
    hasWorktreeDiff: false,
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
});


test("converge: result_missing execution failure → retry_wait without repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "no-result", status: "running" },
    taskResult: { kind: "failed", failure_class: "result_missing", changed_files: [], tests: null, commit: null, from_json: false },
    acceptance: { passed: false, status: "needs_fix", findings: [{ severity: "blocker", code: "summary_missing", message: "missing" }] },
    attempt: 0,
  });
  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(result.repairPlan, null);
  assert.ok(result.retryPlan);
});

test("converge: exhausted result_missing repair/no-result chain → failed without review", () => {
  const result = convergeTaskAfterRun({
    task: { id: "no-result-repair", status: "running", parent_task_id: "root", repair_attempt: 1 },
    taskResult: { kind: "failed", failure_class: "result_missing", changed_files: [], tests: null, commit: null, from_json: false },
    acceptance: { passed: false, status: "needs_fix", findings: [{ severity: "blocker", code: "summary_missing", message: "missing" }] },
    attempt: 1,
  });
  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.FAILED);
  assert.equal(result.repairPlan, null);
  assert.ok(result.retryPlan?.exhausted);
});

// ---------------------------------------------------------------------------
// 8. result missing + diff → waiting_for_review
// ---------------------------------------------------------------------------

test("converge: result missing + diff → waiting_for_missing_evidence_repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t8", status: "running" },
    taskResult: { summary: "No result produced" },
    hasWorktreeDiff: true,
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.WAITING_FOR_MISSING_EVIDENCE_REPAIR);
});

test("converge: result_missing_but_verified_commit → completed", () => {
  const result = convergeTaskAfterRun({
    task: { id: "verified-missing-result", status: "running" },
    taskResult: {
      kind: "codex_failed",
      failure_class: "result_missing",
      from_json: false,
      delivery_result_recovery: {
        reason: "result_missing_but_verified_commit",
        passed: true,
      },
      verification: {
        passed: true,
        commands: [{ cmd: "npm test", exit_code: 0 }],
      },
      commit: "a".repeat(40),
      remote_head: "a".repeat(40),
    },
    repoState: {
      canonical_clean: true,
      commit_integrated: true,
      local_head: "a".repeat(40),
      remote_head: "a".repeat(40),
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
  assert.equal(result.closureReason, CLOSURE_REASONS.RESULT_MISSING_BUT_VERIFIED_COMMIT);
  assert.equal(result.repairPlan, null);
  assert.ok(result.findings.some((finding) => finding.code === "result_missing_but_verified_commit"));
});

test("converge: result_missing_without_verification does not complete", () => {
  const result = convergeTaskAfterRun({
    task: { id: "unverified-missing-result", status: "running" },
    taskResult: {
      kind: "codex_failed",
      failure_class: "result_missing",
      from_json: false,
      delivery_result_recovery: {
        reason: "result_missing_but_verified_commit",
        passed: false,
      },
      commit: "a".repeat(40),
      remote_head: "a".repeat(40),
    },
    repoState: {
      canonical_clean: true,
      commit_integrated: true,
    },
    attempt: 0,
  });

  assert.notEqual(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
  assert.equal(result.repairPlan, null);
});

test("converge: codex_exit_1_with_verified_commit avoids code repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "exit-one-verified", status: "running" },
    taskResult: {
      kind: "codex_failed",
      failure_class: "codex_failed",
      diagnostics: { exit_code: 1 },
      delivery_result_recovery: {
        reason: "delivery_result_writeback_missing",
        passed: true,
      },
      verification: {
        passed: true,
        commands: [{ cmd: "node --test backend/test/task-convergence.test.mjs", exit_code: 0 }],
      },
      commit: "b".repeat(40),
      remote_head: "b".repeat(40),
    },
    repoState: {
      canonical_clean: true,
      commit_integrated: true,
      local_head: "b".repeat(40),
      remote_head: "b".repeat(40),
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
  assert.equal(result.repairPlan, null);
  assert.equal(result.closureReason, CLOSURE_REASONS.RESULT_MISSING_BUT_VERIFIED_COMMIT);
});

// ---------------------------------------------------------------------------
// 9. Runtime changes → restart_pending
// ---------------------------------------------------------------------------

test("converge: runtime changes → restart_pending", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t9", status: "running" },
    taskResult: {
      status: "completed",
      summary: "Runtime change",
      verification: { passed: true },
    },
    acceptance: {
      passed: true,
      status: "accepted",
      findings: [],
    },
    runtimeState: {
      runningCommit: "abc123",
      repoHead: "def456",
      runtimeChanged: true,
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RESTART_PENDING);
  assert.ok(result.restartPlan !== null);
  assert.equal(result.restartPlan.runningCommit, "abc123");
});

// ---------------------------------------------------------------------------
// 10. Already completed/failed → terminal
// ---------------------------------------------------------------------------

test("converge: already completed → no change", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t10", status: "completed" },
    taskResult: {},
  });

  assert.equal(result.nextStatus, "completed");
});

// ---------------------------------------------------------------------------
// 11. detectAcceptanceProfile
// ---------------------------------------------------------------------------

test("detectAcceptanceProfile: sync_only mode", () => {
  const p = detectAcceptanceProfile({ mode: "sync" }, {});
  assert.equal(p, "sync_only");
});

test("detectAcceptanceProfile: github_sync_only mode", () => {
  const p = detectAcceptanceProfile({ mode: "github_sync" }, {});
  assert.equal(p, "github_sync_only");
});

test("detectAcceptanceProfile: verification_only mode", () => {
  const p = detectAcceptanceProfile({ mode: "verification" }, {});
  assert.equal(p, "verification_only");
});

test("detectAcceptanceProfile: repair task with no changes", () => {
  const p = detectAcceptanceProfile(
    { parent_task_id: "parent1", repair_of_task_id: "parent1" },
    { changed_files: [] }
  );
  assert.equal(p, "repair_noop");
});

test("detectAcceptanceProfile: repair task with changes", () => {
  const p = detectAcceptanceProfile(
    { parent_task_id: "parent1", repair_of_task_id: "parent1" },
    { changed_files: ["src/file1.js"] }
  );
  assert.equal(p, "repair_code_change");
});

test("detectAcceptanceProfile: network_retry status", () => {
  const p = detectAcceptanceProfile({ status: "retry_wait" }, {});
  assert.equal(p, "network_retry");
});

// ---------------------------------------------------------------------------
// 12. consolidateBatchConvergence
// ---------------------------------------------------------------------------

test("consolidateBatchConvergence: healthy when no stale states", () => {
  const decisions = [
    { nextStatus: "completed" },
    { nextStatus: "completed" },
    { nextStatus: "failed" },
  ];
  const r = consolidateBatchConvergence(decisions);
  assert.equal(r.healthy, true);
  assert.equal(r.staleReviewCount, 0);
});

test("consolidateBatchConvergence: detects stale states", () => {
  const decisions = [
    { nextStatus: "completed" },
    { nextStatus: "waiting_for_review" },
    { nextStatus: "waiting_for_repair" },
    { nextStatus: "waiting_for_integration" },
  ];
  const r = consolidateBatchConvergence(decisions);
  assert.equal(r.healthy, false);
  assert.equal(r.staleReviewCount, 1);
  assert.equal(r.staleRepairCount, 1);
  assert.equal(r.staleIntegrationCount, 1);
});

// ---------------------------------------------------------------------------
// 13. Edge cases
// ---------------------------------------------------------------------------

test("converge: repair exhausted → blocked/failed", () => {
  // Simulate budget exhausted: attempt >= maxRetries
  const result = convergeTaskAfterRun({
    task: { id: "t13", status: "running", repair_attempt: 3 },
    taskResult: {
      failure_class: "verification_failed",
      summary: "Verification failed repeatedly",
      verification: { passed: false },
    },
    acceptance: {
      passed: false,
      findings: [{ severity: "blocker", code: "test_failed", message: "tests failed" }],
    },
    attempt: 10,  // Simulate many retries → exhausted
  });

  // Should be blocked or failed, not waiting_for_repair
  assert.ok(
    result.nextStatus === "blocked" || result.nextStatus === "failed",
    `Expected blocked/failed, got ${result.nextStatus}`
  );
});

test("converge: provider_interruption → retry_wait", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t14", status: "running" },
    taskResult: {
      failure_class: "provider_interruption",
      summary: "Provider interruption (stdout empty, exit 1)",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(result.repairPlan, null);
});

test("converge: execution_timeout → retry_wait", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t15", status: "running" },
    taskResult: {
      failure_class: "execution_timeout",
      summary: "Codex execution timed out",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT);
  assert.equal(result.repairPlan, null);
});

test("converge: noop acceptance should complete", () => {
  const result = convergeTaskAfterRun({
    task: { id: "t16", status: "running", mode: "noop" },
    taskResult: {
      noop: true,
      kind: "noop",
      summary: "No changes needed",
    },
    acceptance: {
      passed: true,
      status: "accepted",
      findings: [],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED);
});
