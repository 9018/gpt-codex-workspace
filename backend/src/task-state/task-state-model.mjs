/**
 * task-state-model.mjs — Canonical task state classification,
 * allowed transitions, and event-based status resolution.
 *
 * This module defines:
 *   - TASK_PHASES:  high-level phase classification
 *   - TASK_TRANSITION_MATRIX:  allowed(currentStatus → event → nextStatus)
 *   - resolveTaskTransition():  compute next status given current status + event
 *   - canTransitionTask():      boolean gate
 *
 * @module task-state-model
 */

import { TASK_EVENTS } from "./task-transition-events.mjs";
import { TASK_STATUSES } from "../task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Task phase classification
// ---------------------------------------------------------------------------

/**
 * High-level phase classification for the canonical lifecycle.
 *
 * A task moves through: PENDING → ACTIVE → COLLECTING → DECIDING → TERMINAL
 * with repair, integration, and review sub-states branching off DECIDING.
 */
export const TASK_PHASES = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  COLLECTING: "collecting",
  DECIDING: "deciding",
  INTEGRATING: "integrating",
  TERMINAL: "terminal",
});

/**
 * Map from concrete task status to its phase.
 */
const STATUS_TO_PHASE = Object.freeze(
  new Map([
    [TASK_STATUSES.ASSIGNED, TASK_PHASES.PENDING],
    [TASK_STATUSES.QUEUED, TASK_PHASES.PENDING],
    [TASK_STATUSES.STARTING, TASK_PHASES.ACTIVE],
    [TASK_STATUSES.RUNNING, TASK_PHASES.ACTIVE],
    [TASK_STATUSES.COLLECTING, TASK_PHASES.COLLECTING],
    [TASK_STATUSES.ACCEPTING, TASK_PHASES.DECIDING],
    [TASK_STATUSES.WAITING_FOR_REVIEW, TASK_PHASES.DECIDING],
    [TASK_STATUSES.WAITING_FOR_REPAIR, TASK_PHASES.DECIDING],
    [TASK_STATUSES.WAITING_FOR_INTEGRATION, TASK_PHASES.DECIDING],
    [TASK_STATUSES.INTEGRATING, TASK_PHASES.INTEGRATING],
    [TASK_STATUSES.COMPLETED, TASK_PHASES.TERMINAL],
    [TASK_STATUSES.FAILED, TASK_PHASES.TERMINAL],
    [TASK_STATUSES.TIMED_OUT, TASK_PHASES.TERMINAL],
    [TASK_STATUSES.BLOCKED, TASK_PHASES.TERMINAL],
    [TASK_STATUSES.CANCELLED, TASK_PHASES.TERMINAL],
  ]),
);

export function getTaskPhase(status) {
  return STATUS_TO_PHASE.get(status) ?? TASK_PHASES.PENDING;
}

export function isTerminalPhase(status) {
  return getTaskPhase(status) === TASK_PHASES.TERMINAL;
}

// ---------------------------------------------------------------------------
// Terminal status helpers (re-exported from taxonomy)
// ---------------------------------------------------------------------------

import { isTerminalStatus, isFailedTerminalStatus } from "../task-status-taxonomy.mjs";
export { isTerminalStatus, isFailedTerminalStatus };

// ---------------------------------------------------------------------------
// Transition matrix
// ---------------------------------------------------------------------------

/**
 * Allowed transitions: MATRIX[currentStatus][event] → nextStatus
 *
 * When the value is a string, it is used directly.
 * When it is a function, it receives ({ payload, task }) and must return a string.
 * Terminal statuses are not listed — they reject all events by default,
 * except reconciliation_correction which must carry administrative audit info.
 */
const MATRIX = {
  ["draft"]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? "draft",
  },
  [TASK_STATUSES.ASSIGNED]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_CLAIMED]: TASK_STATUSES.STARTING,
    [TASK_EVENTS.EXECUTION_STARTED]: TASK_STATUSES.RUNNING,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: TASK_STATUSES.ASSIGNED,
  },
  [TASK_STATUSES.QUEUED]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_CLAIMED]: TASK_STATUSES.STARTING,
    [TASK_EVENTS.EXECUTION_STARTED]: TASK_STATUSES.RUNNING,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: TASK_STATUSES.QUEUED,
  },
  [TASK_STATUSES.STARTING]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_STARTED]: TASK_STATUSES.RUNNING,
    [TASK_EVENTS.EXECUTION_EVIDENCE_FAILED]: TASK_STATUSES.FAILED,
    [TASK_EVENTS.RUNTIME_LOST]: TASK_STATUSES.WAITING_FOR_REPAIR,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: TASK_STATUSES.STARTING,
  },
  [TASK_STATUSES.RUNNING]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_SESSION_STOPPED]: TASK_STATUSES.COLLECTING,
    [TASK_EVENTS.EXECUTION_EVIDENCE_COLLECTION_STARTED]: TASK_STATUSES.COLLECTING,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.RUNTIME_LOST]: TASK_STATUSES.WAITING_FOR_REPAIR,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: TASK_STATUSES.RUNNING,
  },
  [TASK_STATUSES.COLLECTING]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_EVIDENCE_READY]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.EXECUTION_EVIDENCE_FAILED]: ({ payload }) =>
      payload?.repairable ? TASK_STATUSES.WAITING_FOR_REPAIR : TASK_STATUSES.FAILED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: () => TASK_STATUSES.COLLECTING,
  },
  [TASK_STATUSES.WAITING_FOR_REVIEW]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REVIEW,
  },
  [TASK_STATUSES.WAITING_FOR_REPAIR]: {
    [TASK_EVENTS.REPAIR_SCHEDULED]: TASK_STATUSES.ASSIGNED,
    [TASK_EVENTS.CANCEL_REQUESTED]: TASK_STATUSES.CANCELLED,
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REPAIR,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_REPAIR,
  },
  [TASK_STATUSES.WAITING_FOR_INTEGRATION]: {
    [TASK_EVENTS.INTEGRATION_STARTED]: TASK_STATUSES.INTEGRATING,
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_INTEGRATION,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.WAITING_FOR_INTEGRATION,
  },
  [TASK_STATUSES.INTEGRATING]: {
    [TASK_EVENTS.INTEGRATION_COMPLETED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.COMPLETED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.INTEGRATING,
  },
  [TASK_STATUSES.ACCEPTING]: {
    [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.COMPLETED,
    [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
      payload?.canonical_status ?? TASK_STATUSES.ACCEPTING,
  },
};

// ---------------------------------------------------------------------------
// Extended review statuses (dynamic — computed from review taxonomy)
// ---------------------------------------------------------------------------

import { REVIEW_STATES } from "../task-review-status-taxonomy.mjs";

// Typed review states that represent specific blocking conditions
const TYPED_REVIEW_TRANSITIONS = Object.freeze({
  // All typed review states behave the same for canonical_decision_applied
  ...Object.fromEntries(
    Object.values(REVIEW_STATES).map((rs) => [
      rs,
      {
        [TASK_EVENTS.CANONICAL_DECISION_APPLIED]: ({ payload }) =>
          payload?.canonical_status ?? rs,
        [TASK_EVENTS.RECONCILIATION_CORRECTION]: ({ payload }) =>
          payload?.canonical_status ?? rs,
      },
    ]),
  ),
});

// Typed review states also allow repair scheduling and cancellation
for (const rs of Object.values(REVIEW_STATES)) {
  TYPED_REVIEW_TRANSITIONS[rs][TASK_EVENTS.REPAIR_SCHEDULED] = TASK_STATUSES.ASSIGNED;
  TYPED_REVIEW_TRANSITIONS[rs][TASK_EVENTS.CANCEL_REQUESTED] = TASK_STATUSES.CANCELLED;
}

// ---------------------------------------------------------------------------
// Resolve & gate functions
// ---------------------------------------------------------------------------

/**
 * Compute the next status for a given (currentStatus, event, payload) tuple.
 *
 * @param {object} params
 * @param {string} params.currentStatus  - The task's current status
 * @param {string} params.event          - A TASK_EVENT value
 * @param {object} [params.payload={}]   - Event payload (used by dynamic resolvers)
 * @param {object} [params.task={}]      - The full task object (for context)
 * @returns {{ nextStatus: string|null, allowed: boolean, terminal: boolean, reason: string }}
 */
export function resolveTaskTransition({ currentStatus, event, payload = {}, task = {} }) {
  // Reconciliation is the only audited path allowed to correct an active task
  // directly to a canonical status recovered from durable evidence.
  if (event === TASK_EVENTS.RECONCILIATION_CORRECTION && payload?.canonical_status) {
    return {
      nextStatus: payload.canonical_status,
      allowed: true,
      terminal: isTerminalStatus(payload.canonical_status),
      reason: "reconciliation_correction_to_canonical_status",
    };
  }

  if (!currentStatus || !event) {
    return { nextStatus: null, allowed: false, terminal: false, reason: "missing_status_or_event" };
  }

  // Check terminal statuses — only reconciliation_correction allowed
  if (isTerminalStatus(currentStatus)) {
    if (event === TASK_EVENTS.RECONCILIATION_CORRECTION) {
      const canonical = payload?.canonical_status;
      if (canonical && !isTerminalStatus(canonical)) {
        return {
          nextStatus: canonical,
          allowed: true,
          terminal: false,
          reason: "reconciliation_correction_from_terminal",
        };
      }
      return {
        nextStatus: currentStatus,
        allowed: true,
        terminal: true,
        reason: "reconciliation_correction_same_terminal",
      };
    }
    return { nextStatus: null, allowed: false, terminal: true, reason: "terminal_status_no_transition" };
  }

  // Look up matrix for this status
  const statusRow = MATRIX[currentStatus] || TYPED_REVIEW_TRANSITIONS[currentStatus];
  if (!statusRow) {
    return { nextStatus: null, allowed: false, terminal: false, reason: "unknown_current_status" };
  }

  const transition = statusRow[event];
  if (transition === undefined) {
    return { nextStatus: null, allowed: false, terminal: false, reason: "event_not_allowed_for_status" };
  }

  // Resolve dynamic transitions
  let nextStatus;
  if (typeof transition === "function") {
    try {
      nextStatus = transition({ payload, task });
    } catch (err) {
      return { nextStatus: null, allowed: false, terminal: false, reason: `dynamic_resolver_error: ${err.message}` };
    }
  } else {
    nextStatus = transition;
  }

  if (!nextStatus || typeof nextStatus !== "string") {
    return { nextStatus: null, allowed: false, terminal: false, reason: "resolver_returned_invalid" };
  }

  return {
    nextStatus,
    allowed: true,
    terminal: isTerminalStatus(nextStatus),
    reason: "ok",
  };
}

/**
 * Boolean gate — can the task transition from currentStatus via event?
 *
 * @param {object} params
 * @param {string} params.currentStatus
 * @param {string} params.event
 * @param {object} [params.payload={}]
 * @param {object} [params.task={}]
 * @returns {boolean}
 */
export function canTransitionTask({ currentStatus, event, payload = {}, task = {} }) {
  const result = resolveTaskTransition({ currentStatus, event, payload, task });
  return result.allowed;
}
