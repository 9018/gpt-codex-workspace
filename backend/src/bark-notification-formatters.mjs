import { STATUS_EMOJI, formatDuration } from "./bark-config.mjs";

export function formatNotification(task, status) {
  const shortTitle = (task.title || "(no title)").slice(0, 80);
  const emoji = STATUS_EMOJI[status] || "\uD83D\uDD14";
  const displayStatus = status.replace(/_/g, " ");
  const title = `${emoji} GPTWork ${displayStatus}: ${shortTitle}`;

  let body = `Task: ${shortTitle}\n`;
  body += `Status: ${status}\n`;

  const mode = task.mode || "";
  const ws = task.workspace_id || "";
  if (mode || ws) {
    if (mode) body += `Mode: ${mode}`;
    if (mode && ws) body += " | ";
    if (ws) body += `Workspace: ${ws}`;
    body += "\n";
  }

  if (task.result?.tests) {
    body += `Tests: ${task.result.tests}\n`;
  }

  const commit = task.result?.commit ? task.result.commit.slice(0, 7) : "";
  const remoteHead = task.result?.remote_head ? task.result.remote_head.slice(0, 7) : "";
  if (commit || remoteHead) {
    if (commit) body += `Commit: ${commit}`;
    if (commit && remoteHead) body += " | ";
    if (remoteHead) body += `Remote: ${remoteHead}`;
    body += "\n";
  }

  if (task.duration) {
    const dur = typeof task.duration === "number" ? formatDuration(task.duration) : task.duration;
    body += `Duration: ${dur}\n`;
  } else if (task.result?.completed_at && task.created_at) {
    const durMs = new Date(task.result.completed_at) - new Date(task.created_at);
    if (durMs > 0) {
      body += `Duration: ${formatDuration(durMs)}\n`;
    }
  }

  if (task.result?.summary) {
    const lines = task.result.summary.split("\n").filter(l => l.trim()).slice(0, 2);
    if (lines.length > 0) {
      body += `Summary: ${lines.join(" | ").slice(0, 300)}\n`;
    }
  }

  if (task.result?.changed_files) {
    const files = Array.isArray(task.result.changed_files)
      ? task.result.changed_files.join(", ").slice(0, 200)
      : String(task.result.changed_files).slice(0, 200);
    if (files.trim()) body += `Files: ${files}\n`;
  }

  if (task.result?.kind) body += `Kind: ${task.result.kind}\n`;
  if (task.result?.reason) body += `Reason: ${task.result.reason}\n`;
  if (task.result?.next_action) body += `Next: ${task.result.next_action}\n`;

  // Truncate to mobile-friendly size
  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}

/**
 * Format a manual test notification.
 * Uses 🧪 prefix and rich body.
 *
 * @returns {{ title: string, body: string }}
 */
export function formatManualTestNotification() {
  const title = "\uD83E\uDDEA GPTWork Bark test";
  const body = [
    "This is a manual Bark notification test.",
    "",
    "If you can read this, Bark notifications are working correctly.",
    `Timestamp: ${new Date().toISOString()}`
  ].join("\n");
  return { title, body };
}

/**
 * Format a Bark notification for task creation.
 *
 * @param {object} task   Task object
 * @returns {{ title: string, body: string }}
 */
export function formatCreatedNotification(task) {
  const shortTitle = (task.title || "(no title)").slice(0, 80);
  const emoji = "\uD83C\uDD95";
  const title = `${emoji} GPTWork task created: ${shortTitle}`;

  let body = `Task: ${shortTitle}\n`;
  body += `Status: ${task.status || "unknown"}\n`;

  const mode = task.mode || "";
  const ws = task.workspace_id || "";
  if (mode || ws) {
    if (mode) body += `Mode: ${mode}`;
    if (mode && ws) body += " | ";
    if (ws) body += `Workspace: ${ws}`;
    body += "\n";
  }

  if (task.id) {
    body += `ID: ${task.id}\n`;
  }

  if (task.goal_id) {
    body += `Goal: ${task.goal_id}\n`;
  }

  if (task.created_at) {
    body += `Created: ${task.created_at}\n`;
  }

  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}

/**
 * Format a quota/rate-limit notification for Bark.
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
    ? "\u26A0\uFE0F GPTWork Codex \u989D\u5EA6\u4E0D\u8DB3"
    : "\u26A0\uFE0F GPTWork Codex \u9650\u6D41\u6216\u989D\u5EA6\u4E0D\u8DB3";
  const emojiPrefix = isQuota ? "\u26A0\uFE0F" : "\uD83D\uDD15";

  let body = `${emojiPrefix} Codex/API ${isQuota ? "quota exhausted" : "rate limited"}`;
  if (taskId) body += `\uFF0C\u4EFB\u52A1\u5DF2\u6682\u505C: ${taskId}`;
  body += "\n\n";

  if (taskId) body += `Task: ${taskId}\n`;
  if (goalId) body += `Goal: ${goalId}\n`;
  if (provider) body += `Provider: ${provider}\n`;
  if (model) body += `Model: ${model}\n`;
  body += `Error: ${errorType || "quota_exhausted"}\n`;
  if (detail) body += `Detail: ${detail.slice(0, 200)}\n`;

  body += "\n\u5EFA\u8BAE: \u5207\u6A21\u578B\u3001\u6362 key\u3001\u7B49\u5F85\u91CD\u7F6E\uFF0C\u6216\u964D\u4F4E\u5E76\u53D1\u3002\n";
  body += "Suggested: switch model, change key, wait for reset, or reduce concurrency.\n";

  // Truncate
  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}
