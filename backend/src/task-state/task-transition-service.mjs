/**
 * task-transition-service.mjs — Atomic task transition service.
 *
 * This is the ONLY code path that may change a task's canonical status.
 * All other modules (TUI tools, exec tools, finalizer, reconciler) must
 * call this service rather than setting task.status directly.
 *
 * The service provides:
 *   - Atomic (currentStatus, event) -> nextStatus via state-store.mutate()
 *   - Idempotency via idempotency key deduplication
 *   - Event recording and activity logging
 *   - Lifecycle event emission
 *
 * @module task-transition-service
 */

import { randomUUID, createHash } from "node:crypto";
import { normalizeTaskTransitionCommand, applyPermittedTaskPatch } from "./task-transition-command.mjs";
import { resolveTaskTransition } from "./task-state-model.mjs";
import { taskNotFoundError, statusConflictError, transitionNotAllowedError } from "./task-transition-errors.mjs";

/**
 * Create the canonical task transition service.
 *
 * @param {object} options
 * @param {object}   options.store             - StateStore instance (must have .mutate() and .load())
 * @param {Function} [options.now]             - Timestamp generator (default: Date.now ISO)
 * @param {Function} [options.emit]            - Lifecycle event emitter, called as emit(eventRecord, task)
 * @returns {object} { transitionTask }
 */
export function createTaskTransitionService({ store, now, emit }) {
  const _now = now || (() => new Date().toISOString());
  const _emit = emit || null;

  /**
   * Perform a canonical task transition.
   *
   * @param {object} input - Raw transition input
   * @returns {Promise<{
   *   applied: boolean,
   *   idempotent_replay: boolean,
   *   task: object|null,
   *   previous_status: string|null,
   *   next_status: string|null,
   *   event_record: object|null,
   * }>}
   */
  async function transitionTask(input) {
    const command = normalizeTaskTransitionCommand(input);

    let result;
    await store.mutate(async (state) => {
      // Ensure transition state containers exist
      state.task_transition_events ||= [];
      state.task_transition_idempotency ||= {};

      // --- Idempotency check ---
      const previousEventId = state.task_transition_idempotency[command.idempotency_key];
      if (previousEventId) {
        const event = (state.task_transition_events || []).find((ev) => ev.id === previousEventId);
        if (event) {
          const task = (state.tasks || []).find((t) => t.id === command.task_id);
          result = {
            applied: false,
            idempotent_replay: true,
            task: task || null,
            previous_status: event.previous_status,
            next_status: event.next_status,
            event_record: event,
          };
          return;
        }
      }

      // --- Find task ---
      const task = (state.tasks || []).find((t) => t.id === command.task_id);
      if (!task) throw taskNotFoundError(command.task_id);

      const previousStatus = task.status;

      // --- Expected status gate ---
      if (command.expected_statuses.length > 0 && !command.expected_statuses.includes(previousStatus)) {
        throw statusConflictError(command.expected_statuses, previousStatus);
      }

      // --- Resolve transition ---
      const resolved = resolveTaskTransition({
        currentStatus: previousStatus,
        event: command.event,
        payload: command.payload,
        task,
      });

      if (!resolved.allowed) {
        throw transitionNotAllowedError(previousStatus, command.event, resolved.reason);
      }

      // --- Apply transition ---
      const nowStr = _now();
      task.status = resolved.nextStatus;
      task.updated_at = nowStr;

      // Set terminal timestamps
      if (resolved.terminal) {
        if (resolved.nextStatus === "completed") task.completed_at = task.completed_at || nowStr;
        if (resolved.nextStatus === "failed") task.failed_at = task.failed_at || nowStr;
        if (resolved.nextStatus === "cancelled") task.cancelled_at = task.cancelled_at || nowStr;
      }

      // Apply permitted task patches (result, etc.)
      applyPermittedTaskPatch(task, command);

      // --- Create event record ---
      const eventId = "transition_" + randomUUID();
      const persistedAt = nowStr;
      const eventRecord = {
        id: eventId,
        task_id: task.id,
        event: command.event,
        previous_status: previousStatus,
        next_status: resolved.nextStatus,
        source: command.source,
        actor: command.actor,
        reason: command.reason,
        payload_digest: sha256Hex(JSON.stringify(command.payload)),
        evidence_ref: command.payload?.evidence_ref || null,
        execution_id: command.payload?.execution_id || null,
        idempotency_key: command.idempotency_key,
        occurred_at: command.occurred_at,
        persisted_at: persistedAt,
      };

      state.task_transition_events.push(eventRecord);
      state.task_transition_idempotency[command.idempotency_key] = eventId;

      // --- Activity log ---
      state.activities ||= [];
      state.activities.push({
        time: persistedAt,
        type: "task.transitioned",
        task_id: task.id,
        event: command.event,
        previous_status: previousStatus,
        status: resolved.nextStatus,
      });

      result = {
        applied: true,
        idempotent_replay: false,
        task: JSON.parse(JSON.stringify(task)),
        previous_status: previousStatus,
        next_status: resolved.nextStatus,
        event_record: eventRecord,
      };
    });

    // --- Post-mutation lifecycle emission (fire-and-forget) ---
    if (result.applied && _emit && result.event_record) {
      Promise.resolve().then(() => {
        try { _emit(result.event_record, result.task); } catch { /* non-fatal */ }
      }).catch(() => { /* non-fatal */ });
    }

    return result;
  }

  return { transitionTask };
}

/**
 * Simple SHA-256 hex digest helper.
 */
function sha256Hex(str) {
  return createHash("sha256").update(str).digest("hex");
}
