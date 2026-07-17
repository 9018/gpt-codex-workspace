import test from "node:test";
import assert from "node:assert/strict";

import { notifyAppliedFinalizationCommand } from "../../src/task-finalization/finalization-notifier.mjs";

test("notifyAppliedFinalizationCommand notifies terminal task after complete_task applies", async () => {
  const notified = [];
  const task = { id: "task_1", status: "completed", result: { summary: "done" } };
  const command = {
    id: "pcmd_complete_1",
    status: "applied",
    action: "complete_task",
    task_id: "task_1",
    payload: { task_id: "task_1" },
  };

  const result = await notifyAppliedFinalizationCommand(command, {
    taskResolver: async () => task,
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });

  assert.deepEqual(notified, ["task_1"]);
  assert.deepEqual(result, { notified: true, task_id: "task_1", action: "complete_task" });
});

test("notifyAppliedFinalizationCommand ignores non-applied or non-terminal commands", async () => {
  const notified = [];

  const pending = await notifyAppliedFinalizationCommand({ status: "pending", action: "complete_task", task_id: "task_1" }, {
    taskResolver: async () => ({ id: "task_1", status: "completed" }),
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });
  const cleanup = await notifyAppliedFinalizationCommand({ status: "applied", action: "cleanup_worktree", task_id: "task_1" }, {
    taskResolver: async () => ({ id: "task_1", status: "completed" }),
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });

  assert.deepEqual(notified, []);
  assert.deepEqual(pending, { notified: false, reason: "command_not_applied" });
  assert.deepEqual(cleanup, { notified: false, reason: "not_terminal_notification_command" });
});
