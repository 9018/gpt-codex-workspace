/**
 * bark-quota-notifier.mjs — Quota/rate-limit Bark notifications with dedup/throttle.
 *
 * Provides:
 *   sendQuotaNotification(barkNotifier, options) — Send deduped notification
 *   getQuotaNotificationState() — Inspect dedup state
 *   resetQuotaNotificationState() — Reset dedup state
 *
 * Dedup key: provider + model + error_type
 * Throttle window: 5 minutes by default per key
 * Same-task repeat: suppressed within window
 */

// ---------------------------------------------------------------------------
// In-memory deduplication state
// ---------------------------------------------------------------------------

const _state = {
  // Map of dedupKey => { lastSentAt, taskIds }
  sent: new Map(),
  // Default throttle window: 5 minutes
  defaultWindowMs: 5 * 60 * 1000,
};

/**
 * Compute dedup key for a quota/rate-limit event.
 *
 * @param {object} options
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.errorType]
 * @returns {string}
 */
export function computeQuotaDedupKey({ provider, model, errorType } = {}) {
  return [provider || "unknown", model || "unknown", errorType || "quota_exhausted"].join(":").toLowerCase();
}

/**
 * Reset the deduplication state (useful for testing).
 */
export function resetQuotaNotificationState() {
  _state.sent.clear();
}

/**
 * Get current deduplication state snapshot.
 *
 * @returns {{ entries: Array<{key: string, lastSentAt: string|null, taskIds: string[]}>, defaultWindowMs: number }}
 */
export function getQuotaNotificationState() {
  const entries = [];
  for (const [key, value] of _state.sent.entries()) {
    entries.push({
      key,
      lastSentAt: value.lastSentAt || null,
      taskIds: Array.from(value.taskIds || []),
    });
  }
  return { entries, defaultWindowMs: _state.defaultWindowMs };
}

/**
 * Check if a quota notification should be sent based on dedup state.
 *
 * @param {object} options
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.errorType] - "quota_exhausted" or "rate_limited"
 * @param {string} [options.taskId]
 * @param {number} [options.cooldownMs] - Cooldown window. Default: 300000 (5 min)
 * @returns {{ suppress: boolean, reason: string }}
 */
export function shouldSendQuotaNotification({ provider, model, errorType, taskId, cooldownMs } = {}) {
  const key = computeQuotaDedupKey({ provider, model, errorType });
  const windowMs = cooldownMs || _state.defaultWindowMs;
  const now = Date.now();
  const entry = _state.sent.get(key);

  if (!entry) {
    return { suppress: false, reason: "first occurrence for this key" };
  }

  // Check time-based throttle
  if (entry.lastSentAt && (now - entry.lastSentAt) < windowMs) {
    return { suppress: true, reason: `throttled: last sent ${Math.round((now - entry.lastSentAt) / 1000)}s ago (window: ${windowMs / 1000}s)` };
  }

  // Check same-task dedup within window
  if (taskId && entry.taskIds && entry.taskIds.has(taskId)) {
    // Only suppress if the task was already notified within the window
    if (entry.lastSentAt && (now - entry.lastSentAt) < windowMs) {
      return { suppress: true, reason: `task ${taskId} already notified within window` };
    }
  }

  return { suppress: false, reason: "cooldown expired or new task" };
}

/**
 * Record that a quota notification was sent for dedup tracking.
 *
 * @param {object} options
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.errorType]
 * @param {string} [options.taskId]
 */
export function recordQuotaNotificationSent({ provider, model, errorType, taskId } = {}) {
  const key = computeQuotaDedupKey({ provider, model, errorType });
  const now = Date.now();
  let entry = _state.sent.get(key);

  if (!entry) {
    entry = { lastSentAt: now, taskIds: new Set() };
    _state.sent.set(key, entry);
  } else {
    entry.lastSentAt = now;
  }

  if (taskId) {
    entry.taskIds.add(taskId);
  }
}

/**
 * Send a deduplicated quota/rate-limit Bark notification.
 *
 * @param {object} barkNotifier - createBarkNotifier() instance
 * @param {object} options
 * @param {string} [options.taskId]
 * @param {string} [options.goalId]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.errorType] - "quota_exhausted" or "rate_limited"
 * @param {string} [options.detail]
 * @param {number} [options.cooldownMs] - Throttle window in ms. Default: 300000 (5 min)
 * @returns {Promise<{ sent: boolean, suppress: boolean, reason: string, result?: object }>}
 */
export async function sendQuotaNotification(barkNotifier, {
  taskId,
  goalId,
  provider,
  model,
  errorType = "quota_exhausted",
  detail,
  cooldownMs,
} = {}) {
  // Check dedup/throttle
  const check = shouldSendQuotaNotification({ provider, model, errorType, taskId, cooldownMs });
  if (check.suppress) {
    return { sent: false, suppress: true, reason: check.reason };
  }

  // Bark must be available
  if (!barkNotifier || !barkNotifier.isEnabled || !barkNotifier.isEnabled()) {
    return { sent: false, suppress: false, reason: "bark notifier not available or disabled" };
  }

  // Format notification
  const { formatQuotaNotification } = await import("./bark-notification-formatters.mjs");
  const { title, body } = formatQuotaNotification({ taskId, goalId, provider, model, errorType, detail });

  // Use "quota" group for these notifications
  const result = await barkNotifier.send(title, body, "quota");

  if (result.ok) {
    recordQuotaNotificationSent({ provider, model, errorType, taskId });
    return { sent: true, suppress: false, reason: "notification sent", result };
  }

  return { sent: false, suppress: false, reason: result.error || "notification failed", result };
}
