const RESERVED = /[\\/:*?"<>|\u0000-\u001f]/g;

export function shortEntityId(id, prefix = "") {
  const text = String(id || "").trim().replace(/^(goal|task|session)_/i, "").replace(/-/g, "");
  const value = (text || "unknown").slice(0, 8).toLowerCase();
  return `${prefix}${value}`;
}

export function sanitizeDisplayName(value, fallback = "未命名") {
  const normalized = String(value || "")
    .replace(RESERVED, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (normalized || fallback).slice(0, 80);
}

export function goalDisplayName(goal = {}) {
  return sanitizeDisplayName(goal.title || goal.user_request || goal.description, "未命名目标");
}

export function taskDisplayName(task = {}, goal = {}) {
  return sanitizeDisplayName(task.title || task.description || goal.title, "未命名任务");
}

export function humanGoalDirName(goal = {}) {
  return `${goalDisplayName(goal)}--${shortEntityId(goal.id, "g")}`;
}

export function humanTaskDirName(task = {}, goal = {}) {
  return `${taskDisplayName(task, goal)}--${shortEntityId(task.id, "t")}`;
}

export function humanReadableWorkspaceView(goal = {}, task = null) {
  const goalDir = `.gptwork/views/goals/${humanGoalDirName(goal)}`;
  const taskDir = task?.id ? `${goalDir}/tasks/${humanTaskDirName(task, goal)}` : null;
  return {
    project_title: sanitizeDisplayName(goal.project_title || goal.project_id || goal.workspace_id, "项目"),
    goal_title: goalDisplayName(goal),
    goal_short_id: shortEntityId(goal.id, "G"),
    goal_dir: goalDir,
    task_title: task ? taskDisplayName(task, goal) : null,
    task_short_id: task?.id ? shortEntityId(task.id, "T") : null,
    task_dir: taskDir,
  };
}

export function humanStatusText(status, { provider = "Codex" } = {}) {
  const value = String(status || "").toLowerCase();
  if (["running", "collecting", "evaluating"].includes(value)) return `${provider} 正在运行`;
  if (["queued", "pending", "assigned", "created", "starting", "ready"].includes(value)) return "等待执行";
  if (["completed", "succeeded", "passed", "verified"].includes(value)) return "已完成";
  if (["failed", "timed_out", "cancelled"].includes(value)) return "执行失败";
  if (value.startsWith("waiting_for_")) return "等待处理";
  return status || "状态未知";
}
