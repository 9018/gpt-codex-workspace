/**
 * execution-event-schema.mjs — Event schema for ExecutionRun life-cycle events.
 *
 * Events provide an audit trail for every state transition, external signal,
 * failure, and decision that affects a Run.  Downstream projections (Task,
 * Goal, Workstream) can consume events instead of polling Run state.
 *
 * @module execution-event-schema
 */

import { randomUUID } from "node:crypto";

/** Categories of events emitted during a Run lifecycle. */
export const EVENT_TYPES = Object.freeze([
  // --- Run lifecycle ---
  "run.created",
  "run.state_changed",
  "run.completed",
  "run.failed",
  "run.cancelled",

  // --- Attempt lifecycle ---
  "attempt.started",
  "attempt.evidence_ready",
  "attempt.failed",
  "attempt.failover",

  // --- Evidence ---
  "evidence.collected",
  "evidence.evaluated",
  "evidence.repair_required",

  // --- Acceptance ---
  "acceptance.decision",
  "acceptance.review_required",

  // --- Integration ---
  "integration.required",
  "integration.completed",
  "integration.conflict",

  // --- Recovery ---
  "recovery.action",
  "recovery.checkpoint_created",

  // --- External signals ---
  "signal.supervisor_input",
  "signal.cancel_requested",
  "signal.pause_requested",
]);

const EVENT_TYPES_SET = new Set(EVENT_TYPES);

/**
 * Create a new ExecutionEvent.
 *
 * @param {object} input
 * @param {string} [input.id] - Auto-generated if omitted
 * @param {string} input.run_id - Required: the Run this event belongs to
 * @param {string} [input.attempt_id] - Optional link to an Attempt
 * @param {string} input.type - One of EVENT_TYPES
 * @param {string} [input.severity="info"] - "info", "warning", "error"
 * @param {object} [input.data={}] - Structured payload
 * @param {string} [input.source="system"] - Who/what emitted the event
 * @param {string} [input.created_at] - Override default timestamp
 * @returns {object} Canonical event object
 * @throws {Error} If type is invalid or run_id missing
 */
export function createExecutionEvent(input = {}) {
  if (!input.run_id) {
    throw new Error("run_id is required");
  }

  if (!EVENT_TYPES_SET.has(input.type)) {
    throw new Error(
      `Invalid event type "${input.type}". Must be one of: ${EVENT_TYPES.join(", ")}`
    );
  }

  const validSeverities = ["info", "warning", "error"];
  const severity = input.severity || "info";
  if (!validSeverities.includes(severity)) {
    throw new Error(`Invalid severity "${severity}". Must be one of: ${validSeverities.join(", ")}`);
  }

  return {
    id: input.id || `evt_${randomUUID()}`,
    run_id: input.run_id,
    attempt_id: input.attempt_id || null,
    type: input.type,
    severity,
    data: input.data && typeof input.data === "object" ? structuredClone(input.data) : {},
    source: input.source || "system",
    created_at: input.created_at || new Date().toISOString(),
  };
}
