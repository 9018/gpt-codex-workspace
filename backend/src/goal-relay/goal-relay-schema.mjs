/**
 * goal-relay-schema.mjs — Goal Relay state and action definitions.
 *
 * @module goal-relay/schema
 */

/**
 * Goal relay phases.
 */
export const GOAL_RELAY_PHASES = Object.freeze([
  "idle",
  "active_goal",
  "awaiting_repair",
  "repair_cycle",
  "terminal_evaluation",
  "relay_completed",
  "relay_failed",
]);

/**
 * Actions the goal relay can take when evaluating a completed goal.
 */
export const RELAY_DECISIONS = Object.freeze({
  TERMINAL: "terminal_evaluation",
  START_REPAIR_CYCLE: "start_repair_cycle",
  CONTINUE_CYCLE: "continue_cycle",
});

/**
 * Idempotency key prefix for goal cycles.
 */
export const GOAL_CYCLE_IDEMPOTENCY_PREFIX = "goal-cycle";

/**
 * Create the default goal relay state.
 *
 * @param {object} [options]
 * @param {string} [options.root_goal_id]
 * @param {number} [options.max_cycles=5]
 * @returns {object}
 */
export function createGoalRelayState(options = {}) {
  return {
    phase: "idle",
    current_goal_number: 0,
    root_goal_id: options.root_goal_id || null,
    active_goal_id: null,
    max_cycles: options.max_cycles || 5,
    cycles_completed: 0,
    repair_artifacts: [],
    completed_goal_ids: [],
    terminal_decision: null,
  };
}
