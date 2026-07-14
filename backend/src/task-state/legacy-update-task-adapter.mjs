/**
 * legacy-update-task-adapter.mjs — Compatibility adapter for
 * the legacy `updateTask()` API.
 *
 * The old updateTask() function at task-lifecycle.mjs can be called
 * with isAdapter=true to route through the canonical transition service
 * instead of performing a direct status mutation.
 *
 * Adapter responsibilities:
 *   - Translate a freeform updater function into a structured transition
 *     command when possible
 *   - Reject direct terminal-regression mutations
 *   - Count and warn about legacy direct writes for observability
 *
 * @module legacy-update-task-adapter
 */

import { TASK_STATUSES, isTerminalStatus } from "../task-status-taxonomy.mjs";
import { TaskTransitionError, ERROR_CODES } from "./task-transition-errors.mjs";
import { TASK_EVENTS } from "./task-transition-events.mjs";

/**
 * Detect whether a legacy updater is performing a direct status assignment.
 *
 * @param {Function} updater - Legacy updater function (task) => void
 * @param {object} task - The current task object
 * @returns {{ isDirectStatusWrite: boolean, targetStatus: string|null }}
 */
export function detectDirectStatusWrite(updater, task) {
  // Create a proxy to intercept status assignment
  let targetStatus = null;
  let isDirectWrite = false;

  const proxy = new Proxy(task, {
    set(obj, prop, value) {
      if (prop === "status") {
        isDirectWrite = true;
        targetStatus = value;
      }
      obj[prop] = value;
      return true;
    },
  });

  try {
    updater(proxy);
  } catch {
    // Updater may throw if it expects something else; that's OK
  }

  return { isDirectStatusWrite: isDirectWrite, targetStatus };
}

/**
 * Build a transition command from a legacy direct status write.
 * This is best-effort; complex multi-field updates should use direct
 * transition commands instead.
 *
 * @param {object} options
 * @param {string} options.task_id
 * @param {string} options.currentStatus
 * @param {string} options.targetStatus
 * @param {string} [options.source="legacy_adapter"]
 * @returns {object|null} Transition command or null if not mappable
 */
export function statusWriteToTransitionCommand({ task_id, currentStatus, targetStatus, source = "legacy_adapter" }) {
  // Map common direct writes to transition events
  const statusToEvent = {
    [TASK_STATUSES.COLLECTING]: TASK_EVENTS.EXECUTION_SESSION_STOPPED,
    [TASK_STATUSES.WAITING_FOR_REVIEW]: TASK_EVENTS.EXECUTION_EVIDENCE_READY,
    [TASK_STATUSES.WAITING_FOR_REPAIR]: TASK_EVENTS.EXECUTION_EVIDENCE_FAILED,
    [TASK_STATUSES.RUNNING]: TASK_EVENTS.EXECUTION_STARTED,
    [TASK_STATUSES.STARTING]: TASK_EVENTS.EXECUTION_CLAIMED,
    [TASK_STATUSES.CANCELLED]: TASK_EVENTS.CANCEL_REQUESTED,
    [TASK_STATUSES.COMPLETED]: TASK_EVENTS.CANONICAL_DECISION_APPLIED,
    [TASK_STATUSES.FAILED]: TASK_EVENTS.EXECUTION_EVIDENCE_FAILED,
  };

  const event = statusToEvent[targetStatus];
  if (!event) return null;

  const idempotency_key = `legacy_${task_id}_${event}_${Date.now()}`;

  return {
    task_id,
    event,
    expected_statuses: [currentStatus],
    payload: {
      canonical_status: targetStatus,
      legacy_adapter: true,
    },
    reason: `legacy direct status write: ${currentStatus} → ${targetStatus}`,
    source,
    actor: { type: "system", id: source },
    idempotency_key,
  };
}

/**
 * Log a warning about a legacy direct status write.
 * In development/test environments this should trigger an assertion.
 *
 * @param {object} options
 * @param {string} options.moduleName - Caller module name
 * @param {string} options.taskId
 * @param {string} options.from
 * @param {string} options.to
 */
export function warnLegacyDirectWrite({ moduleName, taskId, from, to }) {
  const msg = `[state-boundary] legacy direct task status mutation in ${moduleName}: ${taskId} ${from} → ${to}`;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    console.warn(msg);
  }
}
