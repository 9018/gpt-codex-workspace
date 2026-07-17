/**
 * execution-state-machine.mjs — ExecutionRun state transition rules.
 *
 * Defines which transitions are allowed between EXECUTION_RUN_STATES.
 * Transition table is explicitly enumerated so it can be audited and
 * extended without side-effect logic.
 *
 * @module execution-state-machine
 */

import {
  EXECUTION_RUN_STATES,
  ACTIVE_RUN_STATES,
  WAITING_RUN_STATES,
  TERMINAL_RUN_STATES,
} from "./execution-run-schema.mjs";

/**
 * Map of allowed transitions: currentState -> Set of allowed next states.
 */
const TRANSITIONS = (() => {
  const map = new Map();

  // Helper: add a single allowed transition
  function allow(from, to) {
    if (!map.has(from)) map.set(from, new Set());
    map.get(from).add(to);
  }

  // Helper: add multiple allowed transitions from one state
  function allowMany(from, toStates) {
    for (const to of toStates) allow(from, to);
  }

  // --- from "created" ---
  allowMany("created", ["planning", "cancelled"]);

  // --- from "planning" ---
  allowMany("planning", ["ready", "failed", "cancelled"]);

  // --- from "ready" ---
  allowMany("ready", ["running", "cancelled"]);

  // --- from "running" ---
  allowMany("running", [
    "collecting",
    "evaluating",
    "waiting_for_repair",
    "waiting_for_review",
    "waiting_for_supervisor",
    "checkpointing",
    "failed",
    "cancelled",
  ]);

  // --- from "collecting" ---
  allowMany("collecting", [
    "evaluating",
    "waiting_for_repair",
    "waiting_for_supervisor",
    "failed",
    "cancelled",
  ]);

  // --- from "evaluating" ---
  allowMany("evaluating", [
    "completed",
    "waiting_for_integration",
    "waiting_for_repair",
    "waiting_for_review",
    "waiting_for_supervisor",
    "failed",
    "cancelled",
  ]);

  // --- from "waiting_for_repair" ---
  allowMany("waiting_for_repair", ["ready", "running", "failed", "cancelled"]);

  // --- from "checkpointing" ---
  allowMany("checkpointing", [
    "ready",
    "running",
    "correcting",
    "resuming",
    "waiting_for_supervisor",
    "failed",
    "cancelled",
  ]);

  // --- from "correcting" ---
  allowMany("correcting", ["running", "collecting", "failed", "cancelled"]);

  // --- from "resuming" ---
  allowMany("resuming", ["running", "collecting", "failed", "cancelled"]);

  // --- from "waiting_for_review" ---
  allowMany("waiting_for_review", ["ready", "running", "completed", "failed", "cancelled"]);

  // --- from "waiting_for_supervisor" ---
  allowMany("waiting_for_supervisor", [
    "ready",
    "running",
    "chatgpt_direct",
    "waiting_for_supervisor_direct",
    "failed",
    "cancelled",
  ]);

  // --- from "waiting_for_supervisor_direct" ---
  allowMany("waiting_for_supervisor_direct", ["chatgpt_direct", "ready", "running", "failed", "cancelled"]);

  // --- from "chatgpt_direct" ---
  allowMany("chatgpt_direct", ["running", "ready", "failed", "cancelled"]);

  // --- from "waiting_for_integration" ---
  allowMany("waiting_for_integration", ["ready", "running", "completed", "failed", "cancelled"]);

  // --- terminal states: no outgoing transitions ---
  // "completed", "failed", "cancelled" have no allowed transitions

  return map;
})();

/**
 * Check whether a transition from `currentState` to `nextState` is allowed.
 *
 * @param {string} currentState
 * @param {string} nextState
 * @returns {boolean}
 */
export function isAllowedTransition(currentState, nextState) {
  const allowed = TRANSITIONS.get(currentState);
  return allowed ? allowed.has(nextState) : false;
}

/**
 * Return the set of allowed next states from `currentState`.
 *
 * @param {string} currentState
 * @returns {ReadonlySet<string> | null} Set of allowed states, or null if terminal
 */
export function getAllowedTransitions(currentState) {
  return TRANSITIONS.get(currentState) || new Set();
}

/**
 * Validate a state transition and return the next state if allowed.
 *
 * @param {object} options
 * @param {string} options.from - Current state
 * @param {string} options.to - Desired next state
 * @param {object} [options.metadata] - Optional context for error message
 * @returns {string} The validated next state
 * @throws {Error} If the transition is not allowed (including terminal state violations)
 */
export function assertAllowedTransition({ from, to, metadata = {} }) {
  if (TERMINAL_RUN_STATES.has(from)) {
    throw new Error(
      `Cannot transition from terminal state "${from}" to "${to}"` +
        (metadata.runId ? ` for run ${metadata.runId}` : "")
    );
  }

  if (!isAllowedTransition(from, to)) {
    throw new Error(
      `Transition from "${from}" to "${to}" is not allowed` +
        (metadata.runId ? ` for run ${metadata.runId}` : "") +
        (metadata.reason ? ` (${metadata.reason})` : "")
    );
  }

  return to;
}
