/**
 * task-transition-command.mjs — Transition command normalization
 * and validation utilities.
 *
 * A "transition command" is the structured input to the transition service.
 * This module validates and normalizes raw input into a canonical command.
 *
 * @module task-transition-command
 */

import { randomUUID } from "node:crypto";
import { TASK_EVENTS, isKnownTaskEvent, isKnownTaskEventSource } from "./task-transition-events.mjs";
import { TaskTransitionError, ERROR_CODES, missingCanonicalDecisionError } from "./task-transition-errors.mjs";

/**
 * Validate and normalize a raw transition input into a canonical command.
 *
 * @param {object} input - Raw input
 * @param {string} [input.task_id]
 * @param {string} [input.event]
 * @param {string[]} [input.expected_statuses]
 * @param {object} [input.payload]
 * @param {string} [input.reason]
 * @param {string} [input.source]
 * @param {object} [input.actor]
 * @param {string} [input.idempotency_key]
 * @param {string} [input.occurred_at]
 * @returns {object} Normalized command
 * @throws {TaskTransitionError} On validation failure
 */
export function normalizeTaskTransitionCommand(input) {
  if (!input || typeof input !== "object") {
    throw new TaskTransitionError(
      ERROR_CODES.TASK_TRANSITION_INVALID,
      "Input must be a non-null object",
    );
  }

  const { task_id, event, payload, reason, source, actor, idempotency_key, occurred_at } = input;
  let { expected_statuses } = input;

  // --- Required fields ---

  if (!task_id || typeof task_id !== "string") {
    throw new TaskTransitionError(
      ERROR_CODES.TASK_TRANSITION_INVALID,
      "task_id is required and must be a string",
      { task_id },
    );
  }

  if (!event || !isKnownTaskEvent(event)) {
    throw new TaskTransitionError(
      ERROR_CODES.TASK_TRANSITION_INVALID,
      `Invalid or unknown event: "${event}"`,
      { event },
    );
  }

  if (!idempotency_key || typeof idempotency_key !== "string") {
    throw new TaskTransitionError(
      ERROR_CODES.TASK_TRANSITION_INVALID,
      "idempotency_key is required and must be a string",
    );
  }

  // --- expected_statuses normalization ---

  if (expected_statuses !== undefined && expected_statuses !== null) {
    if (!Array.isArray(expected_statuses)) {
      expected_statuses = [String(expected_statuses)];
    }
    expected_statuses = expected_statuses.filter(Boolean);
  } else {
    expected_statuses = [];
  }

  // --- payload validation ---

  const cleanPayload = payload && typeof payload === "object"
    ? { ...payload }
    : {};

  // Validate payload JSON serializability
  try {
    JSON.stringify(cleanPayload);
  } catch {
    throw new TaskTransitionError(
      ERROR_CODES.TASK_TRANSITION_INVALID,
      "payload must be JSON-serializable",
    );
  }

  // canonical_decision_applied requires unified_decision in payload
  if (event === TASK_EVENTS.CANONICAL_DECISION_APPLIED && !cleanPayload.unified_decision) {
    throw missingCanonicalDecisionError({ taskId: task_id, event });
  }

  // --- source ---

  const cleanSource = source && isKnownTaskEventSource(source) ? source : "operator";

  // --- actor ---

  const cleanActor = actor && typeof actor === "object"
    ? { type: actor.type || "system", id: actor.id || cleanSource }
    : { type: "system", id: cleanSource };

  // --- timestamps ---

  const cleanOccurredAt = occurred_at && typeof occurred_at === "string"
    ? occurred_at
    : new Date().toISOString();

  // --- Build canonical command ---

  const command = {
    task_id,
    event,
    expected_statuses,
    payload: cleanPayload,
    reason: reason || `transition via ${event}`,
    source: cleanSource,
    actor: cleanActor,
    idempotency_key,
    occurred_at: cleanOccurredAt,
  };

  // Immutable freeze
  Object.freeze(command);

  return command;
}

/**
 * Check which fields are permitted for direct mutation during a transition.
 * These are the ONLY task fields the transition service may modify directly.
 *
 * @returns {Set<string>}
 */
export function getPermittedTaskPatchFields() {
  return new Set([
    "status",
    "updated_at",
    "result",
    "completed_at",
    "failed_at",
    "cancelled_at",
    "logs",
  ]);
}

/**
 * Apply a permitted patch to a task object during transition.
 * Only specific metadata fields may be mutated.
 *
 * @param {object} task - Task object (mutated in-place)
 * @param {object} command - The normalized transition command
 */
export function applyPermittedTaskPatch(task, command) {
  const { payload } = command;

  // Only 'result' field may be set from payload.task_result_patch
  if (payload.task_result_patch && typeof payload.task_result_patch === "object") {
    task.result = {
      ...(task.result || {}),
      ...payload.task_result_patch,
    };
  }

  // Set timestamp fields based on new status
  if (task.status === "cancelled") {
    task.cancelled_at = task.cancelled_at || command.occurred_at;
  }
}
