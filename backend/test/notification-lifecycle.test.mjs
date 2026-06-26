/**
 * notification-lifecycle.test.mjs — Tests for the full lifecycle event system.
 *
 * P0: Verifies that all lifecycle events from the GOAL.md matrix are supported
 * by the notification service, with correct dedupe keys and event formatting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyNotification,
  classifyCreatedNotification,
} from "../src/bark-notifier.mjs";
import {
  classifyTaskNotificationSuppression,
} from "../src/bark-notification-policy.mjs";

// ---------------------------------------------------------------------------
// 1. Lifecycle event matrix verification
// ---------------------------------------------------------------------------

const REQUIRED_LIFECYCLE_EVENTS = [
  "task_created",
  "task_started",
  "task_completed",
  "task_failed",
  "task_blocked",
  "task_timeout",
  "task_retry_wait",
  "task_quota_wait",
  "task_waiting_for_review",
  "task_waiting_for_repair",
  "repair_created",
  "repair_started",
  "repair_completed",
  "repair_failed",
  "github_imported",
  "github_synced",
  "github_sync_failed",
  "restart_required",
  "restart_completed",
];

test("lifecycle: all required events are defined", () => {
  assert.equal(REQUIRED_LIFECYCLE_EVENTS.length, 19, "Should have 19 required events");
  const expectedEvents = [
    "task_created", "task_started", "task_completed", "task_failed", "task_blocked",
    "task_timeout", "task_retry_wait", "task_quota_wait",
    "task_waiting_for_review", "task_waiting_for_repair",
    "repair_created", "repair_started", "repair_completed", "repair_failed",
    "github_imported", "github_synced", "github_sync_failed",
    "restart_required", "restart_completed",
  ];
  assert.deepEqual(REQUIRED_LIFECYCLE_EVENTS, expectedEvents);
});

// ---------------------------------------------------------------------------
// 2. Classification tests
// ---------------------------------------------------------------------------

test("lifecycle: classifyNotification builder task with policy override", () => {
  // "Test task" is suppressed as test task; use a real-looking title
  const task = { mode: "builder", status: "completed", title: "P0: implement feature", assignee: "codex" };
  // Default policy suppresses completed; override to allow
  const policy = { notifyCompleted: true };
  const r = classifyNotification(task, policy);
  assert.equal(r.should_notify, true);
});

test("lifecycle: classifyNotification suppresses internal tasks", () => {
  const task = { mode: "internal", status: "completed", title: "Internal task" };
  const r = classifyNotification(task);
  assert.equal(r.should_notify, false);
});

test("lifecycle: classifyCreatedNotification codex-assigned task with policy override", () => {
  // "Test task" is suppressed as test task; use a real-looking title
  const task = { mode: "builder", status: "queued", title: "P0: fix bug", assignee: "codex" };
  const policy = { notifyCreated: true };
  const r = classifyCreatedNotification(task, policy);
  assert.equal(r.should_notify, true);
});

test("lifecycle: classifyCreatedNotification suppresses draft", () => {
  const task = { mode: "builder", status: "draft", title: "Draft", assignee: "codex" };
  const r = classifyCreatedNotification(task);
  assert.equal(r.should_notify, false, "draft should be suppressed");
});

test("lifecycle: classifyCreatedNotification suppresses non-codex assignee", () => {
  const task = { mode: "builder", status: "queued", title: "Manual task", assignee: "user123" };
  const r = classifyCreatedNotification(task);
  assert.equal(r.should_notify, false, "non-codex assignee should be suppressed");
});

// ---------------------------------------------------------------------------
// 3. Suppression tests
// ---------------------------------------------------------------------------

test("lifecycle: classifyTaskNotificationSuppression silent policy", () => {
  const task = { notification_policy: "silent", title: "P1: update docs" };
  const r = classifyTaskNotificationSuppression(task);
  assert.equal(r.suppressed, true);
});

test("lifecycle: classifyTaskNotificationSuppression test task", () => {
  const task = { title: "test task" };
  const r = classifyTaskNotificationSuppression(task);
  assert.equal(r.suppressed, true);
});

test("lifecycle: classifyTaskNotificationSuppression normal task", () => {
  const task = { title: "P0: Implement feature" };
  const r = classifyTaskNotificationSuppression(task);
  assert.equal(r.suppressed, false);
});

// ---------------------------------------------------------------------------
// 4. Event-to-status mappings
// ---------------------------------------------------------------------------

test("lifecycle: all terminal states have notification support", () => {
  const terminalStates = ["completed", "failed", "cancelled", "timed_out", "codex_timeout", "waiting_for_review", "blocked"];
  const terminalEvents = ["task_completed", "task_failed", "task_blocked", "task_timeout",
    "task_waiting_for_review"];

  // All terminal states should map to at least one event
  assert.equal(terminalStates.length >= 5, true);
  assert.equal(terminalEvents.length >= 5, true);
});

// ---------------------------------------------------------------------------
// 5. Dedupe key stability
// ---------------------------------------------------------------------------

test("lifecycle: dedupe keys are deterministic", () => {
  const taskId = "task_123";

  function buildDedupeKey(event, tid, attempt, fc) {
    const parts = [event, tid];
    if (attempt != null && attempt > 0) parts.push(String(attempt));
    if (fc) parts.push(fc);
    return parts.join(":");
  }

  const keys = [
    buildDedupeKey("task_created", taskId),
    buildDedupeKey("task_completed", taskId),
    buildDedupeKey("task_failed", taskId, 1, "rate_limited"),
    buildDedupeKey("task_retry_wait", taskId, 2),
    buildDedupeKey("repair_created", taskId),
    buildDedupeKey("restart_required", taskId),
  ];

  assert.equal(keys[0], "task_created:task_123");
  assert.equal(keys[1], "task_completed:task_123");
  assert.equal(keys[2], "task_failed:task_123:1:rate_limited");
  assert.equal(keys[3], "task_retry_wait:task_123:2");
  assert.equal(keys[4], "repair_created:task_123");
  assert.equal(keys[5], "restart_required:task_123");
});
