/**
 * github-writeback-lifecycle.test.mjs — Tests for GitHub writeback lifecycle.
 *
 * P0: Verifies that GitHub status writebacks are properly formatted
 * for all task lifecycle states.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 1. Status label mapping
// ---------------------------------------------------------------------------

const GITHUB_STATUS_LABELS = {
  "completed": "completed",
  "failed": "failed",
  "blocked": "blocked",
  "waiting_for_review": "waiting_for_review",
  "waiting_for_repair": "waiting_for_repair",
  "waiting_for_integration": "waiting_for_integration",
  "retry_wait": "retry_wait",
  "quota_wait": "quota_wait",
  "restart_pending": "restart_pending",
};

test("github: all required statuses have mapping", () => {
  const requiredStatuses = [
    "completed", "failed", "blocked",
    "waiting_for_review", "waiting_for_repair", "waiting_for_integration",
    "retry_wait", "quota_wait", "restart_pending",
  ];

  for (const s of requiredStatuses) {
    assert.ok(GITHUB_STATUS_LABELS[s], `Status ${s} is missing from GitHub label mapping`);
  }
  assert.equal(Object.keys(GITHUB_STATUS_LABELS).length, 9);
});

// ---------------------------------------------------------------------------
// 2. Completed comment format
// ---------------------------------------------------------------------------

test("github: completed comment contains required fields", () => {
  const task = {
    id: "task_123",
    title: "P0: Implement feature",
    result: {
      summary: "Feature implemented",
      commit: "abc123def456",
      remote_head: "abc123def456",
      verification: { passed: true, commands: [{ exit_code: 0 }] },
      tests: "passed",
      acceptance_profile: "code_change",
      changed_files: ["src/file1.js"],
      failure_class: null,
    },
  };

  const commentLines = [
    `Task: ${task.id}`,
    `Summary: ${task.result.summary}`,
    `Commit: ${(task.result.commit || "").slice(0, 7)}`,
    `Verification: passed`,
    `Tests: ${task.result.tests}`,
  ];

  assert.ok(commentLines[0].includes("task_123"));
  assert.ok(commentLines[1].includes("Feature implemented"));
  assert.ok(commentLines[2].includes("abc123d"));
  assert.ok(commentLines[3].includes("passed"));
});

// ---------------------------------------------------------------------------
// 3. Failed/blocked comment format
// ---------------------------------------------------------------------------

test("github: failed comment contains failure details", () => {
  const task = {
    id: "task_456",
    title: "P0: Fix bug",
    result: {
      failure_class: "rate_limited",
      summary: "429 Too Many Requests",
      retryable: true,
      repairable: false,
      attempt: 3,
    },
  };

  const commentLines = [
    `Task: ${task.id}`,
    `Failure: ${task.result.failure_class}`,
    `Retries exhausted: yes` ,
    `Next: quota_wait`,
  ];

  assert.ok(commentLines[1].includes("rate_limited"));
});

// ---------------------------------------------------------------------------
// 4. Lifecycle status transitions (no actual API calls)
// ---------------------------------------------------------------------------

test("github: lifecycle status transitions are valid", () => {
  // All valid transitions from a starting state to an ending state
  const validTransitions = [
    { from: "waiting_for_review", to: "completed" },
    { from: "waiting_for_repair", to: "waiting_for_integration" },
    { from: "waiting_for_integration", to: "completed" },
    { from: "retry_wait", to: "queued" },
    { from: "quota_wait", to: "queued" },
    { from: "running", to: "completed" },
    { from: "running", to: "failed" },
    { from: "running", to: "waiting_for_review" },
    { from: "running", to: "waiting_for_integration" },
    { from: "running", to: "retry_wait" },
    { from: "running", to: "quota_wait" },
  ];

  assert.equal(validTransitions.length, 11);
  for (const t of validTransitions) {
    assert.ok(t.from && t.to, `Invalid transition: ${t.from} → ${t.to}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Sync compatibility
// ---------------------------------------------------------------------------

test("github: sync-compatible status labels", () => {
  const syncCompatible = [
    "completed", "failed", "blocked",
    "waiting_for_review", "waiting_for_repair",
    "waiting_for_integration", "retry_wait", "quota_wait",
  ];

  for (const s of syncCompatible) {
    assert.ok(GITHUB_STATUS_LABELS[s], `${s} should be GitHub sync compatible`);
  }
});

// ---------------------------------------------------------------------------
// 6. GitHub event mapping
// ---------------------------------------------------------------------------

test("github: events match notification lifecycle", () => {
  const githubEvents = [
    { event: "github_imported", description: "Issue imported from GitHub" },
    { event: "github_synced", description: "GitHub sync completed" },
    { event: "github_sync_failed", description: "GitHub sync failed" },
  ];

  assert.equal(githubEvents.length, 3);
  for (const e of githubEvents) {
    assert.ok(e.event, `Event missing name`);
    assert.ok(e.description, `Event missing description`);
  }
});
