const SILENT_NOTIFICATION_POLICIES = new Set(["silent", "suppress", "suppressed", "none", "off", "disabled"]);

function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
}

function isFalseFlag(value) {
  if (value === false) return true;
  if (typeof value === "string") return ["false", "0", "no", "off"].includes(value.trim().toLowerCase());
  return false;
}

function normalizeTitle(title) {
  return String(title || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyTaskNotificationSuppression(task = {}) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const notificationPolicy = task.notification_policy ?? metadata.notification_policy;
  if (
    isFalseFlag(task.notify ?? metadata.notify) ||
    isTruthyFlag(task.silent ?? metadata.silent) ||
    isTruthyFlag(task.suppress_notifications ?? metadata.suppress_notifications) ||
    SILENT_NOTIFICATION_POLICIES.has(String(notificationPolicy || "").trim().toLowerCase())
  ) {
    return { suppressed: true, reason: "suppressed:task_policy" };
  }

  const title = normalizeTitle(task.title);
  const syntheticKinds = ["test", "demo", "diagnostic", "synthetic"];
  for (const kind of syntheticKinds) {
    if (
      title === `${kind} task` ||
      title.startsWith(`[${kind}]`) ||
      title.startsWith(`${kind} task:`) ||
      title.startsWith(`${kind} task -`) ||
      title.startsWith(`${kind} task `)
    ) {
      return { suppressed: true, reason: kind === "test" ? "suppressed:test_task" : "suppressed:synthetic_task" };
    }
  }

  return { suppressed: false, reason: "not suppressed" };
}

export function classifyNotification(task, policy = {}) {
  const notifyTasks = policy.notifyTasks ?? process.env.GPTWORK_BARK_NOTIFY_TASKS !== "false";
  const notifyReadonly = policy.notifyReadonly ?? process.env.GPTWORK_BARK_NOTIFY_READONLY === "true";
  const notifyInternal = policy.notifyInternal ?? process.env.GPTWORK_BARK_NOTIFY_INTERNAL === "true";
  const notifyTests = policy.notifyTests ?? process.env.GPTWORK_BARK_NOTIFY_TESTS === "true";
  const notifyCancelled = policy.notifyCancelled ?? process.env.GPTWORK_BARK_NOTIFY_CANCELLED === "true";
  const notifyWaitingReview = policy.notifyWaitingReview ?? process.env.GPTWORK_BARK_NOTIFY_WAITING_REVIEW !== "false";
  const notifyFailures = policy.notifyFailures ?? process.env.GPTWORK_BARK_NOTIFY_FAILURES !== "false";
  const notifyTimeouts = policy.notifyTimeouts ?? process.env.GPTWORK_BARK_NOTIFY_TIMEOUTS !== "false";
  const notifyCompleted = policy.notifyCompleted ?? process.env.GPTWORK_BARK_NOTIFY_COMPLETED !== "false";

  if (!notifyTasks) {
    return { should_notify: false, reason: "notifications globally disabled (GPTWORK_BARK_NOTIFY_TASKS)" };
  }

  const mode = (task.mode || "").toLowerCase();
  const status = (task.status || "").toLowerCase();
  const title = (task.title || "").toLowerCase();

  const suppression = classifyTaskNotificationSuppression(task);
  if (suppression.suppressed) {
    return { should_notify: false, reason: suppression.reason };
  }

  // Suppress readonly tasks by default
  if (mode === "readonly" && !notifyReadonly) {
    return { should_notify: false, reason: "readonly task suppressed by policy" };
  }

  // Suppress internal tasks by default
  if (mode === "internal" && !notifyInternal) {
    return { should_notify: false, reason: "internal task suppressed by policy" };
  }

  // Suppress test mode tasks by default
  if (mode === "test" && !notifyTests) {
    return { should_notify: false, reason: "test task suppressed by policy" };
  }

  // Suppress Codex session inventory tasks
  if (title.includes("codex session inventory") && !notifyInternal) {
    return { should_notify: false, reason: "session inventory suppressed by policy" };
  }

  // Suppress cancelled by default
  if (status === "cancelled" && !notifyCancelled) {
    return { should_notify: false, reason: "cancelled suppressed by policy" };
  }

  // Status-based filtering
  if (status === "completed" && !notifyCompleted) {
    return { should_notify: false, reason: "completed suppressed by policy" };
  }
  if ((status === "failed" || status === "codex_error") && !notifyFailures) {
    return { should_notify: false, reason: "failure suppressed by policy" };
  }
  if ((status === "timed_out" || status === "codex_timeout") && !notifyTimeouts) {
    return { should_notify: false, reason: "timeout suppressed by policy" };
  }
  if ((status === "waiting_review" || status === "waiting_for_review") && !notifyWaitingReview) {
    return { should_notify: false, reason: "waiting review suppressed by policy" };
  }

  // Only notify for terminal/user-visible statuses
  const notifyStatuses = [
    "completed", "failed", "codex_error", "codex_timeout",
    "timed_out", "waiting_review", "waiting_for_review",
    "cancelled"
  ];
  if (!notifyStatuses.includes(status)) {
    return { should_notify: false, reason: `status "${status}" not in notification targets` };
  }

  return { should_notify: true, reason: "policy allows notification" };
}



/**
 * Classify a task for CREATED notification policy compliance.
 *
 * Determines whether a Bark notification should be sent for task creation.
 * Suppressed by default for draft, readonly, internal, test mode tasks.
 *
 * @param {object} task   Task object with { mode, status, title, assignee }
 * @param {object} [policy]  Optional policy overrides
 * @returns {{ should_notify: boolean, reason: string }}
 */
export function classifyCreatedNotification(task, policy = {}) {
  const notifyCreated = policy.notifyCreated ?? process.env.GPTWORK_BARK_NOTIFY_CREATED !== "false";
  const notifyTasks = policy.notifyTasks ?? process.env.GPTWORK_BARK_NOTIFY_TASKS !== "false";
  const notifyReadonly = policy.notifyReadonly ?? process.env.GPTWORK_BARK_NOTIFY_READONLY === "true";
  const notifyInternal = policy.notifyInternal ?? process.env.GPTWORK_BARK_NOTIFY_INTERNAL === "true";
  const notifyTests = policy.notifyTests ?? process.env.GPTWORK_BARK_NOTIFY_TESTS === "true";

  if (!notifyTasks) {
    return { should_notify: false, reason: "notifications globally disabled (GPTWORK_BARK_NOTIFY_TASKS)" };
  }
  if (!notifyCreated) {
    return { should_notify: false, reason: "created notifications disabled by policy (GPTWORK_BARK_NOTIFY_CREATED)" };
  }

  const mode = (task.mode || "").toLowerCase();
  const status = (task.status || "").toLowerCase();
  const title = (task.title || "").toLowerCase();

  const suppression = classifyTaskNotificationSuppression(task);
  if (suppression.suppressed) {
    return { should_notify: false, reason: suppression.reason };
  }

  // Suppress draft tasks
  if (status === "draft") {
    return { should_notify: false, reason: "draft task suppressed" };
  }

  // Suppress tasks not assigned to Codex
  if ((task.assignee || "").toLowerCase() !== "codex") {
    return { should_notify: false, reason: "task not assigned to Codex" };
  }

  // Suppress readonly tasks by default
  if (mode === "readonly" && !notifyReadonly) {
    return { should_notify: false, reason: "readonly task suppressed by policy" };
  }

  // Suppress internal tasks by default
  if (mode === "internal" && !notifyInternal) {
    return { should_notify: false, reason: "internal task suppressed by policy" };
  }

  // Suppress test mode tasks by default
  if (mode === "test" && !notifyTests) {
    return { should_notify: false, reason: "test task suppressed by policy" };
  }

  // Suppress Codex session inventory tasks
  if (title.includes("codex session inventory") && !notifyInternal) {
    return { should_notify: false, reason: "session inventory suppressed by policy" };
  }

  return { should_notify: true, reason: "created notification allowed" };
}

//
// ================================================================
// Notification formatters
// ================================================================

/**
 * Format a notification title and body for a task status change.
 * Uses emoji fallback in title.
 *
 * @param {object} task   Task object
 * @param {string} status Task status string
 * @returns {{ title: string, body: string }}
 */
