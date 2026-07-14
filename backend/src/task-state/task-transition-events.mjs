/**
 * task-transition-events.mjs — Standard domain event definitions
 * for the canonical task transition kernel.
 *
 * Every task transition generates exactly one event record.  Consumers
 * (projections, reconcilers, observability) read events, never raw
 * task state mutations.
 *
 * @module task-transition-events
 */

/** Finite set of transition event types */
export const TASK_EVENTS = Object.freeze({
  EXECUTION_CLAIMED: "execution_claimed",
  EXECUTION_STARTED: "execution_started",
  EXECUTION_STOP_REQUESTED: "execution_stop_requested",
  EXECUTION_SESSION_STOPPED: "execution_session_stopped",
  EXECUTION_EVIDENCE_COLLECTION_STARTED: "execution_evidence_collection_started",
  EXECUTION_EVIDENCE_READY: "execution_evidence_ready",
  EXECUTION_EVIDENCE_FAILED: "execution_evidence_failed",
  CANONICAL_DECISION_APPLIED: "canonical_decision_applied",
  REPAIR_SCHEDULED: "repair_scheduled",
  INTEGRATION_STARTED: "integration_started",
  INTEGRATION_COMPLETED: "integration_completed",
  CANCEL_REQUESTED: "cancel_requested",
  RUNTIME_LOST: "runtime_lost",
  RECONCILIATION_CORRECTION: "reconciliation_correction",
});

/** Stable enum of known event source strings */
export const TASK_EVENT_SOURCES = Object.freeze([
  "codex_exec",
  "codex_tui",
  "finalizer",
  "workflow",
  "reconciler",
  "operator",
]);

/** Set of events that produce a canonical outcome suitable for projection */
export const CANONICAL_OUTCOME_EVENTS = Object.freeze(
  new Set([
    TASK_EVENTS.CANONICAL_DECISION_APPLIED,
    TASK_EVENTS.RECONCILIATION_CORRECTION,
  ]),
);

/** Events that may advance a task toward terminal */
export const TERMINAL_ADVANCING_EVENTS = Object.freeze(
  new Set([
    TASK_EVENTS.CANONICAL_DECISION_APPLIED,
    TASK_EVENTS.INTEGRATION_COMPLETED,
    TASK_EVENTS.CANCEL_REQUESTED,
    TASK_EVENTS.RECONCILIATION_CORRECTION,
  ]),
);

/**
 * Check whether a given event name is a known TASK_EVENT.
 * @param {string} event
 * @returns {boolean}
 */
export function isKnownTaskEvent(event) {
  return Object.values(TASK_EVENTS).includes(event);
}

/**
 * Check whether a source string is in the stable allowlist.
 * @param {string} source
 * @returns {boolean}
 */
export function isKnownTaskEventSource(source) {
  return TASK_EVENT_SOURCES.includes(source);
}

/**
 * Check whether an event can produce a canonical outcome for projections.
 * @param {string} event
 * @returns {boolean}
 */
export function eventProducesCanonicalOutcome(event) {
  return CANONICAL_OUTCOME_EVENTS.has(event);
}
