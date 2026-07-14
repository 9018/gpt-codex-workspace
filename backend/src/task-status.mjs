/**
 * Pure task status and queue selector helpers.
 *
 * This module contains only pure, side-effect-free functions that inspect
 * task state or extract configuration from task descriptions.  No lifecycle
 * mutation, worker logic, safe restart, goal-files, prompt builder, workspace
 * IO, or public schema logic should be placed here.
 */

import { TASK_STATUSES, normalizeTaskStatus } from "./task-status-taxonomy.mjs";

const TASK_STATUS_TERMINAL_FOR_SESSION_INVENTORY = new Set([
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.CANCELLED,
]);

/**
 * Check whether a task has reached a terminal status.
 *
 * @param {object|null|undefined} task
 * @returns {boolean}
 */
export function isTaskTerminal(task) {
  return TASK_STATUS_TERMINAL_FOR_SESSION_INVENTORY.has(normalizeTaskStatus(task?.status));
}

/**
 * Check whether a task is a codex-session-inventory task (fully qualified).
 *
 * @param {object|null|undefined} task
 * @returns {boolean}
 */
export function isCodexSessionInventoryTask(task) {
  return task?.assignee === "codex"
    && normalizeTaskStatus(task?.status) === TASK_STATUSES.ASSIGNED
    && ((task?.mode === "full" && task?.legacy_mode === "readonly") || task?.mode === "readonly")
    && isCodexSessionInventoryTaskKind(task);
}

/**
 * Check whether a task matches the codex-session-inventory pattern by title
 * and description content (ignoring status/mode constraints).
 *
 * @param {object|null|undefined} task
 * @returns {boolean}
 */
export function isCodexSessionInventoryTaskKind(task) {
  return task?.assignee === "codex"
    && /Codex session metadata/i.test(task?.title || "")
    && /Do not read session file contents/i.test(task?.description || "");
}

/**
 * Extract a bounded numeric limit from a task description string.
 *
 * @param {string} [description=""]
 * @param {number} [fallback=50]
 * @returns {number}
 */
export function extractTaskLimit(description = "", fallback = 50) {
  const match = String(description).match(/Return at most\s+(\d+)\s+files/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(Number(match[1]) || fallback, 200));
}
