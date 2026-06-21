let createdTaskNotifier = null;

export function setCreatedTaskNotifier(fn) {
  createdTaskNotifier = fn;
}

export function notifyCreatedTask(task) {
  createdTaskNotifier?.(task);
}
