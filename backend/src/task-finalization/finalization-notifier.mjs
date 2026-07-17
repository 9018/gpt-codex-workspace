export async function notifyAppliedFinalizationCommand(command = {}, {
  taskResolver,
  notifyTerminalTaskFn,
} = {}) {
  if (command.status !== "applied") return { notified: false, reason: "command_not_applied" };
  if (command.action !== "complete_task") return { notified: false, reason: "not_terminal_notification_command" };
  if (typeof taskResolver !== "function") throw new TypeError("taskResolver is required");
  if (typeof notifyTerminalTaskFn !== "function") throw new TypeError("notifyTerminalTaskFn is required");

  const taskId = command.payload?.task_id || command.task_id;
  const task = await taskResolver(taskId, command);
  if (!task) return { notified: false, reason: "task_not_found", task_id: taskId || null };
  await notifyTerminalTaskFn(task);
  return { notified: true, task_id: task.id || taskId || null, action: command.action };
}
