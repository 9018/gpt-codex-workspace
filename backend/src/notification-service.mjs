/**
 * Notification service module for GPTWork.
 *
 * Provides notifyTerminalTaskIfNeeded and notifyCreatedTaskIfNeeded
 * helpers that wrap Bark notification logic with deduplication and
 * policy gating. These were extracted from gptwork-server.mjs to
 * reduce its complexity.
 */
import { classifyNotification, classifyCreatedNotification, formatNotification, formatCreatedNotification } from "./bark-notifier.mjs";

/**
 * Create a notification service bound to a Bark notifier instance.
 *
 * @param {object} barkNotifier  A Bark notifier instance (from createBarkNotifier)
 * @returns {{ notifyTerminalTaskIfNeeded, notifyCreatedTaskIfNeeded }}
 */
export function createNotificationService(barkNotifier) {
  /** Terminal states that trigger a notification. */
  const TERMINAL_STATES = ["completed", "failed", "cancelled", "timed_out", "codex_timeout", "waiting_for_review", "waiting_review"];

  /**
   * Build the shared notification record pushed onto task.notifications[].
   * Uses safe diagnostic metadata from the barkNotifier (no secrets).
   */
  function _buildNotificationRecord(nres) {
    return {
      channel: "bark",
      event: nres.ok ? "sent" : "failed",
      attempted_at: new Date().toISOString(),
      ok: nres.ok,
      response_code: nres.ok ? 200 : null,
      response_message: nres.ok ? (nres.bark_id || "ok") : null,
      error_short: nres.ok ? null : (nres.reason || nres.error || null),
      source: (barkNotifier.getStatus ? barkNotifier.getStatus().source : null) || "unknown",
      group: (barkNotifier.getStatus ? barkNotifier.getStatus().group : null) || "gptwork",
      endpoint_kind: (() => {
        const st = barkNotifier.getStatus ? barkNotifier.getStatus() : {};
        return st.url_set ? "url" : st.key_set ? "key" : "none";
      })(),
      icon_set: (barkNotifier.getStatus ? barkNotifier.getStatus().icon_set : false) || false,
      url_action_set: (barkNotifier.getStatus ? barkNotifier.getStatus().url_action_set : false) || false
    };
  }

  /**
   * Send a Bark notification for a terminal task state change.
   * Deduplicated per task/status/channel and policy-gated.
   * Transient states such as waiting_for_lock are intentionally excluded.
   *
   * @param {object} task  Task object (mutated in place)
   */
  async function notifyTerminalTaskIfNeeded(task) {
    if (!barkNotifier || !barkNotifier.isEnabled()) return;
    const channelKey = `notified:bark:${task.status}`;
    if (!TERMINAL_STATES.includes(task.status) || task[channelKey]) return;

    const classification = classifyNotification(task);
    if (!classification.should_notify) {
      task.last_notification_policy = classification.reason;
      return;
    }

    try {
      const { title, body } = formatNotification(task, task.status);
      const nres = await barkNotifier.send(title, body, `task-${task.status}`);
      if (nres.ok) {
        task[channelKey] = true;
        task.notified_at = new Date().toISOString();
        if (barkNotifier._setTaskMetadata) {
          barkNotifier._setTaskMetadata(task.id, task.status, task.status);
        }
      }
      task.notifications ||= [];
      task.notifications.push(_buildNotificationRecord(nres));
    } catch {
      // notification failure is non-critical
    }
  }

  /**
   * Send a Bark notification for a newly created/assigned task.
   * Deduplicated (one `created` notification per task) and policy-gated.
   * Suppressed for draft tasks, readonly/internal/test mode tasks by default.
   *
   * @param {object} task  Task object (mutated in place)
   */
  async function notifyCreatedTaskIfNeeded(task) {
    if (!barkNotifier || !barkNotifier.isEnabled()) return;
    const channelKey = 'notified:bark:created';
    if (task[channelKey]) return;

    const classification = classifyCreatedNotification(task);
    if (!classification.should_notify) {
      task.last_notification_policy = classification.reason;
      return;
    }

    try {
      const { title, body } = formatCreatedNotification(task);
      const nres = await barkNotifier.send(title, body, 'task-created');
      if (nres.ok) {
        task[channelKey] = true;
        task.notified_at = new Date().toISOString();
        if (barkNotifier._setTaskMetadata) {
          barkNotifier._setTaskMetadata(task.id, task.status, task.status);
        }
      }
      if (barkNotifier._setTaskMetadata) {
        barkNotifier._setTaskMetadata(task.id, task.status, 'created');
      }
      task.notifications ||= [];
      task.notifications.push(_buildNotificationRecord(nres));
    } catch {
      // notification failure is non-critical
    }
  }

  return { notifyTerminalTaskIfNeeded, notifyCreatedTaskIfNeeded };
}
