import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationService } from "../src/notification-service.mjs";
import { createBarkNotifier } from "../src/bark-notifier.mjs";

// ================================================================
// Tests: createNotificationService
// ================================================================

test("createNotificationService returns object with both notify functions", () => {
  const bark = createBarkNotifier();
  const svc = createNotificationService(bark);
  assert.ok(svc);
  assert.equal(typeof svc.notifyTerminalTaskIfNeeded, "function");
  assert.equal(typeof svc.notifyCreatedTaskIfNeeded, "function");
});

test("createNotificationService with disabled notifier — notifyTerminalTaskIfNeeded is no-op", async () => {
  const bark = createBarkNotifier();
  const svc = createNotificationService(bark);
  const task = { status: "completed", title: "test" };
  await svc.notifyTerminalTaskIfNeeded(task);
  // No bark notification sent, task unchanged
  assert.equal(task.notifications, undefined);
  assert.equal(task.notified_at, undefined);
});

test("createNotificationService with disabled notifier — notifyCreatedTaskIfNeeded is no-op", async () => {
  const bark = createBarkNotifier();
  const svc = createNotificationService(bark);
  const task = { status: "assigned", title: "test", assignee: "codex" };
  await svc.notifyCreatedTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
  assert.equal(task.notified_at, undefined);
});

test("notifyTerminalTaskIfNeeded handles null notifier gracefully", async () => {
  const svc = createNotificationService(null);
  const task = { status: "completed", title: "test" };
  await svc.notifyTerminalTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
});

test("notifyCreatedTaskIfNeeded handles null notifier gracefully", async () => {
  const svc = createNotificationService(null);
  const task = { status: "assigned", title: "test", assignee: "codex" };
  await svc.notifyCreatedTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
});

test("notifyTerminalTaskIfNeeded skips non-terminal states", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = { status: "draft", title: "test" };
  await svc.notifyTerminalTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
});

test("notifyCreatedTaskIfNeeded dedup via notified:bark:created flag", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = {
    status: "assigned",
    title: "test",
    assignee: "codex",
    mode: "builder",
    "notified:bark:created": true
  };
  await svc.notifyCreatedTaskIfNeeded(task);
  // Already notified, should skip
  assert.equal(task.notifications, undefined);
});

test("notifyTerminalTaskIfNeeded dedup via notified:bark:status flag", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = {
    status: "completed",
    title: "test",
    mode: "builder",
    "notified:bark:completed": true
  };
  await svc.notifyTerminalTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
});

test("notifyTerminalTaskIfNeeded respects classifyNotification policy denial", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = { status: "completed", title: "test", mode: "internal" };
  await svc.notifyTerminalTaskIfNeeded(task);
  // Policy suppressed — no notification sent
  assert.equal(task.notifications, undefined);
  assert.equal(task.last_notification_policy, "internal task suppressed by policy");
});

test("notifyCreatedTaskIfNeeded respects classifyCreatedNotification policy denial", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = { status: "assigned", title: "test", assignee: "codex", mode: "internal" };
  await svc.notifyCreatedTaskIfNeeded(task);
  assert.equal(task.notifications, undefined);
  assert.equal(task.last_notification_policy, "internal task suppressed by policy");
});

test("notifyTerminalTaskIfNeeded catches errors from barkNotifier.send gracefully", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = { status: "completed", title: "test", mode: "builder" };
  // Send will fail (no actual Bark server), but error is caught
  await svc.notifyTerminalTaskIfNeeded(task);
  // The function attempted to send, but whether it modifies notifications
  // depends on the send attempt. The key behavior: no throw.
  // Since send fails, notifications should still be pushed with ok:false
  assert.ok(task.notifications);
  assert.equal(task.notifications.length, 1);
  assert.equal(task.notifications[0].ok, false);
  assert.equal(task.notifications[0].channel, "bark");
});

test("notifyCreatedTaskIfNeeded catches errors from barkNotifier.send gracefully", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const svc = createNotificationService(bark);
  const task = { status: "assigned", title: "Test created", mode: "builder", assignee: "codex" };
  await svc.notifyCreatedTaskIfNeeded(task);
  assert.ok(task.notifications);
  assert.equal(task.notifications.length, 1);
  assert.equal(task.notifications[0].ok, false);
  assert.equal(task.notifications[0].channel, "bark");
});

test("suppressed Test task does not call barkNotifier.send for created or completed notifications", async () => {
  let sendCount = 0;
  const bark = {
    isEnabled: () => true,
    getStatus: () => ({ source: "test", group: "gptwork", key_set: true }),
    send: async () => {
      sendCount++;
      return { ok: true, bark_id: "sent" };
    }
  };
  const svc = createNotificationService(bark);
  const task = { status: "assigned", title: "Test task", mode: "builder", assignee: "codex" };

  await svc.notifyCreatedTaskIfNeeded(task);
  task.status = "completed";
  await svc.notifyTerminalTaskIfNeeded(task);

  assert.equal(sendCount, 0);
  assert.equal(task.notifications, undefined);
  assert.equal(task.last_notification_policy, "suppressed:test_task");
});

test("suppressed notification policy does not call barkNotifier.send for waiting_for_review", async () => {
  let sendCount = 0;
  const bark = {
    isEnabled: () => true,
    getStatus: () => ({ source: "test", group: "gptwork", key_set: true }),
    send: async () => {
      sendCount++;
      return { ok: true, bark_id: "sent" };
    }
  };
  const svc = createNotificationService(bark);
  const task = { status: "waiting_for_review", title: "Review quiet task", mode: "builder", assignee: "codex", notification_policy: "silent" };

  await svc.notifyTerminalTaskIfNeeded(task);

  assert.equal(sendCount, 0);
  assert.equal(task.notifications, undefined);
  assert.equal(task.last_notification_policy, "suppressed:task_policy");
});

// ================================================================
// Tests: global notifier pattern (setCreatedTaskNotifier / notifyCreatedTask)
// ================================================================

test("notifyCreatedTask calls the global notifier when set", async () => {
  const { setCreatedTaskNotifier, notifyCreatedTask } = await import("../src/goal-task-notifier.mjs");
  let called = false;
  let calledTask = null;
  setCreatedTaskNotifier((task) => { called = true; calledTask = task; });
  const taskObj = { id: "task_test", status: "assigned", assignee: "codex" };
  notifyCreatedTask(taskObj);
  assert.equal(called, true, "global notifier should be called");
  assert.equal(calledTask, taskObj, "task should be passed through");
  // Clean up
  setCreatedTaskNotifier(null);
});

test("notifyCreatedTask does not throw when no notifier is set", async () => {
  const { setCreatedTaskNotifier, notifyCreatedTask } = await import("../src/goal-task-notifier.mjs");
  setCreatedTaskNotifier(null);
  const taskObj = { id: "task_test", status: "assigned" };
  notifyCreatedTask(taskObj); // Should not throw
});

test("setCreatedTaskNotifier can be set and cleared", async () => {
  const { setCreatedTaskNotifier, notifyCreatedTask } = await import("../src/goal-task-notifier.mjs");
  let callCount = 0;
  setCreatedTaskNotifier(() => { callCount++; });
  notifyCreatedTask({ id: "t1" });
  assert.equal(callCount, 1);
  // Clear
  setCreatedTaskNotifier(null);
  notifyCreatedTask({ id: "t2" });
  assert.equal(callCount, 1, "should not increment after clearing");
});
