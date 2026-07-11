import { STATUS_EMOJI, STATUS_ZH, formatDuration } from "./bark-config.mjs";

/**
 * Resolve Chinese display label for an internal status string.
 * Falls back to the original if no mapping exists.
 */
function zhStatus(status) {
  return STATUS_ZH[status] || status.replace(/_/g, " ");
}

/**
 * Format a Bark notification for a task status change.
 * All user-facing content is in Chinese.
 *
 * @param {object} task   Task object
 * @param {string} status Task status string
 * @returns {{ title: string, body: string }}
 */
export function formatNotification(task, status) {
  const shortTitle = (task.title || "(无标题)").slice(0, 80);
  const emoji = STATUS_EMOJI[status] || "\uD83D\uDD14";
  const zh = zhStatus(status);
  const title = `${emoji} GPTWork ${zh}: ${shortTitle}`;

  let body = `任务: ${shortTitle}\n`;
  body += `状态: ${zh}\n`;

  const mode = task.mode || "";
  const ws = task.workspace_id || "";
  if (mode || ws) {
    if (mode) body += `模式: ${mode}`;
    if (mode && ws) body += " | ";
    if (ws) body += `工作区: ${ws}`;
    body += "\n";
  }

  if (task.result?.tests) {
    body += `测试: ${task.result.tests}\n`;
  }

  const commit = task.result?.commit ? task.result.commit.slice(0, 7) : "";
  const remoteHead = task.result?.remote_head ? task.result.remote_head.slice(0, 7) : "";
  if (commit || remoteHead) {
    if (commit) body += `提交: ${commit}`;
    if (commit && remoteHead) body += " | ";
    if (remoteHead) body += `远端: ${remoteHead}`;
    body += "\n";
  }

  if (task.duration) {
    const dur = typeof task.duration === "number" ? formatDuration(task.duration) : task.duration;
    body += `耗时: ${dur}\n`;
  } else if (task.result?.completed_at && task.created_at) {
    const durMs = new Date(task.result.completed_at) - new Date(task.created_at);
    if (durMs > 0) {
      body += `耗时: ${formatDuration(durMs)}\n`;
    }
  }

  if (task.result?.summary) {
    const lines = task.result.summary.split("\n").filter(l => l.trim()).slice(0, 2);
    if (lines.length > 0) {
      body += `摘要: ${lines.join(" | ").slice(0, 300)}\n`;
    }
  }

  if (task.result?.changed_files) {
    const files = Array.isArray(task.result.changed_files)
      ? task.result.changed_files.join(", ").slice(0, 200)
      : String(task.result.changed_files).slice(0, 200);
    if (files.trim()) body += `文件: ${files}\n`;
  }

  if (task.result?.kind) body += `类型: ${task.result.kind}\n`;
  if (task.result?.reason) body += `原因: ${task.result.reason}\n`;
  if (task.result?.next_action) body += `下一步: ${task.result.next_action}\n`;

  // Truncate to mobile-friendly size
  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}

/**
 * Format a manual test notification.
 * Uses 🧪 prefix and Chinese rich body.
 *
 * @returns {{ title: string, body: string }}
 */
export function formatManualTestNotification() {
  const title = "\uD83E\uDDEA GPTWork Bark 测试通知";
  const body = [
    "这是一条手动 Bark 通知测试。",
    "",
    "如果你能读到这条消息，说明 Bark 通知功能正常工作。",
    `时间: ${new Date().toISOString()}`
  ].join("\n");
  return { title, body };
}

/**
 * Format a Bark notification for task creation.
 * All user-facing content is in Chinese.
 *
 * @param {object} task   Task object
 * @returns {{ title: string, body: string }}
 */
export function formatCreatedNotification(task) {
  const shortTitle = (task.title || "(无标题)").slice(0, 80);
  const emoji = "\uD83C\uDD95";
  const title = `${emoji} GPTWork 新任务: ${shortTitle}`;

  let body = `任务: ${shortTitle}\n`;
  body += `状态: ${zhStatus(task.status || "unknown")}\n`;

  const mode = task.mode || "";
  const ws = task.workspace_id || "";
  if (mode || ws) {
    if (mode) body += `模式: ${mode}`;
    if (mode && ws) body += " | ";
    if (ws) body += `工作区: ${ws}`;
    body += "\n";
  }

  if (task.id) {
    body += `ID: ${task.id}\n`;
  }

  if (task.goal_id) {
    body += `目标: ${task.goal_id}\n`;
  }

  if (task.created_at) {
    body += `创建时间: ${task.created_at}\n`;
  }

  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}

/**
 * Format a quota/rate-limit notification for Bark.
 * Title is already in Chinese. Body uses mixed Chinese/English for clarity.
 *
 * @param {object} options
 * @param {string} options.taskId - Task ID
 * @param {string} options.goalId - Goal ID (optional)
 * @param {string} options.provider - Provider name (optional)
 * @param {string} options.model - Model name (optional)
 * @param {string} options.errorType - Error type: "quota_exhausted" or "rate_limited"
 * @param {string} [options.detail] - Additional detail message
 * @returns {{ title: string, body: string }}
 */
export function formatQuotaNotification({ taskId, goalId, provider, model, errorType, detail } = {}) {
  const isQuota = errorType === "quota_exhausted" || !errorType || errorType.includes("quota");
  const title = isQuota
    ? "\u26A0\uFE0F GPTWork Codex 额度不足"
    : "\u26A0\uFE0F GPTWork Codex 限流或额度不足";
  const emojiPrefix = isQuota ? "\u26A0\uFE0F" : "\uD83D\uDD15";

  let body = `${emojiPrefix} Codex/API ${isQuota ? "额度耗尽" : "触发限流"}`;
  if (taskId) body += `，任务已暂停: ${taskId}`;
  body += "\n\n";

  if (taskId) body += `任务: ${taskId}\n`;
  if (goalId) body += `目标: ${goalId}\n`;
  if (provider) body += `提供商: ${provider}\n`;
  if (model) body += `模型: ${model}\n`;
  body += `错误: ${errorType || "quota_exhausted"}\n`;
  if (detail) body += `详情: ${detail.slice(0, 200)}\n`;

  body += "\n建议: 切换模型、换 key、等待重置，或降低并发。\n";

  // Truncate
  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}
