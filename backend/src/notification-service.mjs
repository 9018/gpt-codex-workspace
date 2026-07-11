/**
 * Notification service module for GPTWork.
 *
 * Provides notifyTerminalTaskIfNeeded, notifyCreatedTaskIfNeeded, and
 * emitTaskLifecycleEvent helpers that wrap Bark notification logic
 * with deduplication and policy gating.
 *
 * EmitTaskLifecycleEvent is the unified entry point for all lifecycle
 * events (P0). It handles Bark notification, GitHub writeback, and
 * notification state persistence with stable dedupe keys.
 *
 * All user-facing notification text is in Chinese.
 */

import {
  classifyNotification,
  classifyCreatedNotification,
  classifyTaskNotificationSuppression,
  formatNotification,
  formatCreatedNotification,
} from "./bark-notifier.mjs";
import { EVENT_ZH } from "./bark-config.mjs";

/**
 * Create a notification service bound to a Bark notifier instance.
 *
 * @param {object} barkNotifier  A Bark notifier instance (from createBarkNotifier)
 * @returns {{
 *   notifyTerminalTaskIfNeeded,
 *   notifyCreatedTaskIfNeeded,
 *   emitTaskLifecycleEvent,
 *   buildLifecycleEventMap,
 * }}
 */
export function createNotificationService(barkNotifier) {
  /** Terminal states that trigger a notification. */
  const TERMINAL_STATES = [
    "completed", "failed", "cancelled", "timed_out",
    "codex_timeout", "waiting_for_review", "waiting_review",
    "blocked",
  ];

  /**
   * Build the shared notification record pushed onto task.notifications[].
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
      url_action_set: (barkNotifier.getStatus ? barkNotifier.getStatus().url_action_set : false) || false,
    };
  }

  /**
   * Build a stable dedupe key for a lifecycle event.
   *
   * @param {string} event - Event name (e.g., "task_completed", "repair_created")
   * @param {string} taskId - Task ID
   * @param {number} [attempt] - Optional attempt number
   * @param {string} [failureClass] - Optional failure class
   * @returns {string} Stable dedupe key
   */
  function _buildDedupeKey(event, taskId, attempt, failureClass) {
    const parts = [event, taskId];
    if (attempt != null && attempt > 0) parts.push(String(attempt));
    if (failureClass) parts.push(failureClass);
    return parts.join(":");
  }

  /**
   * Send a Bark notification for a terminal task state change.
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
      } else {
        // Record failure with task metadata
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
   */
  async function notifyCreatedTaskIfNeeded(task) {
    if (!barkNotifier || !barkNotifier.isEnabled()) return;
    const channelKey = "notified:bark:created";
    if (task[channelKey]) return;

    const classification = classifyCreatedNotification(task);
    if (!classification.should_notify) {
      task.last_notification_policy = classification.reason;
      return;
    }

    try {
      const { title, body } = formatCreatedNotification(task);
      const nres = await barkNotifier.send(title, body, "task-created");
      if (nres.ok) {
        task[channelKey] = true;
        task.notified_at = new Date().toISOString();
      }
      if (barkNotifier._setTaskMetadata) {
        barkNotifier._setTaskMetadata(task.id, task.status, "created");
      }
      task.notifications ||= [];
      task.notifications.push(_buildNotificationRecord(nres));
    } catch {
      // notification failure is non-critical
    }
  }

  // ---------------------------------------------------------------------------
  // P0: Unified lifecycle event emission
  // ---------------------------------------------------------------------------

  /**
   * Event-to-group mapping for Bark notifications.
   */
  const EVENT_GROUPS = {
    task_created: "task-created",
    task_started: "task-started",
    task_running: "task-running",
    task_completed: "task-completed",
    task_failed: "task-failed",
    task_blocked: "task-blocked",
    task_timeout: "task-timeout",
    task_cancelled: "task-cancelled",
    task_retry_wait: "task-retry",
    task_quota_wait: "task-quota",
    task_waiting_for_review: "task-review",
    task_waiting_for_repair: "task-repair",
    repair_created: "repair-created",
    repair_started: "repair-started",
    repair_completed: "repair-completed",
    repair_failed: "repair-failed",
    github_imported: "github-import",
    github_synced: "github-sync",
    github_sync_failed: "github-sync",
    restart_required: "restart",
    restart_completed: "restart",
  };

  /**
   * Resolve Chinese event label.
   */
  function _zhEvent(event) {
    return EVENT_ZH[event] || event;
  }

  /**
   * Emit a lifecycle event for a task.
   *
   * Unified entry point for all lifecycle events. Handles:
   * 1. Bark notification (with deduplication)
   * 2. Task notification state persistence
   * 3. Diagnostics recording
   *
   * Bark failures are non-critical and do not throw.
   * Failure details are recorded in task.notifications[].
   *
   * @param {object} options
   * @param {object} options.task - Task object (mutated in place for notification state)
   * @param {object} [options.taskResult] - Task result object
   * @param {string} options.event - Event name from the lifecycle matrix
   * @param {string} [options.previousStatus] - Previous task status
   * @param {string} [options.nextStatus] - Next task status
   * @param {number} [options.attempt] - Attempt number
   * @param {string} [options.failureClass] - Failure class
   * @param {number} [options.githubIssue] - GitHub issue number
   * @param {string} [options.commit] - Commit hash
   * @param {object} [options.verification] - Verification result
   * @param {string} [options.dedupeKey] - Override dedupe key (auto-computed if omitted)
   * @param {boolean} [options.force] - Force notification even if dedup key exists
   * @returns {Promise<{ ok: boolean, dedupeKey: string, error?: string }>}
   */
  async function emitTaskLifecycleEvent({
    task,
    taskResult,
    event,
    previousStatus,
    nextStatus,
    attempt,
    failureClass,
    githubIssue,
    commit,
    verification,
    dedupeKey,
    force,
  } = {}) {
    if (!task || !event) {
      return { ok: false, dedupeKey: "", error: "Missing task or event" };
    }

    // Compute stable dedupe key
    const dk = dedupeKey || _buildDedupeKey(event, task.id, attempt, failureClass);

    // Check deduplication (skip when force=true for repair/replay)
    const notifiedKey = `notified:${dk}`;
    if (!force && task[notifiedKey]) {
      return { ok: true, dedupeKey: dk, deduplicated: true };
    }
    // Check task-level notification suppression BEFORE sending Bark
    // This ensures lifecycle events respect the same suppression policies
    // as notifyTerminalTaskIfNeeded and notifyCreatedTaskIfNeeded.
    const suppression = classifyTaskNotificationSuppression(task);
    if (suppression.suppressed) {
      task.last_notification_policy = suppression.reason;
      // Mark as notified so dedupe key is consumed and subsequent
      // lifecycle events for the same dedupe key are skipped.
      task[notifiedKey] = true;
      task.notifications ||= [];
      task.notifications.push({ channel: "bark", lifecycle_event: event, dedupe_key: dk, suppressed: true, reason: suppression.reason, attempted_at: new Date().toISOString() });
      return { ok: false, dedupeKey: dk, suppressed: true, reason: suppression.reason, deduplicated: false };
    }


    // Format and send Bark notification
    if (barkNotifier && barkNotifier.isEnabled()) {
      try {
        const { title, body } = _formatLifecycleEvent(event, task, taskResult, {
          previousStatus,
          nextStatus,
          attempt,
          failureClass,
          githubIssue,
          commit,
          verification,
        });
        const group = EVENT_GROUPS[event] || "gptwork";
        const nres = await barkNotifier.send(title, body, group);

        if (nres.ok) {
          task[notifiedKey] = true;
          task.last_event = event;
          task.last_event_at = new Date().toISOString();
          if (barkNotifier._setTaskMetadata) {
            barkNotifier._setTaskMetadata(task.id, nextStatus || task.status, event);
          }
        } else {
          // Record failure metadata even on send failure
          if (barkNotifier._setTaskMetadata) {
            barkNotifier._setTaskMetadata(task.id, nextStatus || task.status, event);
          }
        }

        task.notifications ||= [];
        task.notifications.push({
          ..._buildNotificationRecord(nres),
          lifecycle_event: event,
          dedupe_key: dk,
        });

        return { ok: nres.ok, dedupeKey: dk, error: nres.ok ? null : (nres.reason || nres.error) };
      } catch (err) {
        // Non-critical - record failure details persistently
        task.notifications ||= [];
        task.notifications.push({
          channel: "bark",
          lifecycle_event: event,
          dedupe_key: dk,
          ok: false,
          error_short: err.message || String(err),
          attempted_at: new Date().toISOString(),
        });
        // Also record task metadata so notification_status reflects the attempt
        if (barkNotifier._setTaskMetadata) {
          barkNotifier._setTaskMetadata(task.id, nextStatus || task.status, event);
        }
        return { ok: false, dedupeKey: dk, error: err.message };
      }
    }

    return { ok: false, dedupeKey: dk, error: "Bark notifier unavailable" };
  }

  /**
   * Build a map of all lifecycle events and their dedupe keys for a task.
   *
   * Useful for testing and audit.
   *
   * @param {object} task - Task object
   * @returns {object} Event → dedupeKey map
   */
  function buildLifecycleEventMap(task) {
    const events = Object.keys(EVENT_GROUPS);
    const map = {};
    for (const event of events) {
      map[event] = _buildDedupeKey(event, task.id);
    }
    return map;
  }

  /**
   * Scan tasks for missed lifecycle notifications and replay them.
   * Called during worker recovery (enabled_but_not_running → running).
   *
   * @param {object[]} tasks - Array of task objects
   * @param {object} [opts]
   * @param {string[]} [opts.targetEvents] - Events to scan for (default: all terminal + running)
   * @param {boolean} [opts.dryRun] - If true, only report what would be sent
   * @returns {Promise<{replayed: string[], errors: string[]}>}
   */
  async function recoverMissedNotifications(tasks, opts = {}) {
    const targetEvents = opts.targetEvents || [
      "task_created", "task_started", "task_running",
      "task_completed", "task_failed", "task_timeout",
      "task_cancelled", "task_blocked", "task_waiting_for_review",
    ];
    const replayed = [];
    const errors = [];
    const dryRun = opts.dryRun === true;

    for (const task of (tasks || [])) {
      for (const event of targetEvents) {
        // Skip events that don't match the task's current lifecycle position
        if (event === "task_created" && !["queued", "assigned", "running", "completed", "failed"].includes(task.status)) continue;
        if (event === "task_started" && task.status !== "running") continue;
        if (event === "task_running" && task.status !== "running") continue;
        if (event === "task_completed" && task.status !== "completed") continue;
        if (event === "task_failed" && task.status !== "failed") continue;
        if (event === "task_timeout" && !["timed_out", "codex_timeout"].includes(task.status)) continue;
        if (event === "task_cancelled" && task.status !== "cancelled") continue;
        if (event === "task_blocked" && task.status !== "blocked") continue;
        if (event === "task_waiting_for_review" && !["waiting_for_review", "waiting_review"].includes(task.status)) continue;

        const dk = _buildDedupeKey(event, task.id);
        const notifiedKey = `notified:${dk}`;
        if (task[notifiedKey]) continue; // already notified

        if (dryRun) {
          replayed.push(`${task.id}:${event} (dry-run)`);
          continue;
        }

        try {
          await emitTaskLifecycleEvent({
            task,
            event,
            nextStatus: task.status,
            force: true,
          });
          replayed.push(`${task.id}:${event}`);
        } catch (err) {
          errors.push(`${task.id}:${event} - ${err.message}`);
        }
      }
    }
    return { replayed, errors };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle event formatter (all Chinese content)
  // ---------------------------------------------------------------------------

  function _formatLifecycleEvent(event, task, taskResult, extra = {}) {
    const shortTitle = (task.title || "(无标题)").slice(0, 80);
    const emojiMap = {
      task_created: "\uD83C\uDD95",
      task_started: "\u25B6\uFE0F",
      task_running: "\uD83D\uDCBB",
      task_completed: "\u2705",
      task_failed: "\u274C",
      task_blocked: "\uD83D\uDD34",
      task_timeout: "\u23F3",
      task_cancelled: "\uD83D\uDEAB",
      task_retry_wait: "\uD83D\uDD04",
      task_quota_wait: "\uD83D\uDCB0",
      task_waiting_for_review: "\uD83D\uDC40",
      task_waiting_for_repair: "\uD83D\uDD27",
      repair_created: "\uD83D\uDD28",
      repair_started: "\uD83D\uDD27",
      repair_completed: "\u2705",
      repair_failed: "\u274C",
      github_imported: "\uD83D\uDCCB",
      github_synced: "\uD83D\uDD17",
      github_sync_failed: "\uD83D\uDD17",
      restart_required: "\uD83D\uDD04",
      restart_completed: "\u2705",
    };
    const emoji = emojiMap[event] || "\uD83D\uDD14";
    const zhLabel = _zhEvent(event);
    const title = `${emoji} GPTWork ${zhLabel}: ${shortTitle}`;

    let body = `任务: ${shortTitle}\n`;
    body += `事件: ${zhLabel}\n`;
    body += `状态: ${extra.nextStatus || task.status || "未知"}\n`;

    if (extra.previousStatus) body += `之前状态: ${extra.previousStatus}\n`;
    if (extra.attempt != null) body += `尝试: ${extra.attempt}\n`;
    if (extra.failureClass) body += `失败类型: ${extra.failureClass}\n`;
    if (extra.githubIssue) body += `Issue: #${extra.githubIssue}\n`;
    if (extra.commit) body += `提交: ${extra.commit.slice(0, 7)}\n`;

    const taskResultData = taskResult || task.result || {};
    if (taskResultData.summary) {
      const lines = taskResultData.summary.split("\n").filter(l => l.trim()).slice(0, 2);
      if (lines.length > 0) body += `摘要: ${lines.join(" | ").slice(0, 300)}\n`;
    }
    if (taskResultData.changed_files) {
      const files = Array.isArray(taskResultData.changed_files)
        ? taskResultData.changed_files.join(", ").slice(0, 200)
        : String(taskResultData.changed_files).slice(0, 200);
      if (files.trim()) body += `文件: ${files}\n`;
    }

    if (body.length > 4000) body = body.slice(0, 3997) + "...";
    return { title, body };
  }

  return {
    notifyTerminalTaskIfNeeded,
    notifyCreatedTaskIfNeeded,
    emitTaskLifecycleEvent,
    buildLifecycleEventMap,
    recoverMissedNotifications,
  };
}
