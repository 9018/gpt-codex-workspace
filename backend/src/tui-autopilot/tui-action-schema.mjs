/**
 * tui-action-schema.mjs — Action types for keyboard and slash-command interactions.
 *
 * Defines the shapes for bootstrap actions, keyboard input, and
 * slash-command interactions used by the tui-goal-command-driver.
 *
 * @module tui-action-schema
 */

/**
 * Allowed bootstrap methods for goal submission, ordered by preference.
 * The first available method is attempted; each fallback is tried on failure.
 */
export const GOAL_BOOTSTRAP_METHODS = Object.freeze([
  "goal_slash_command",  // Two-phase /goal interaction
  "argv_prompt",          // Pass goal as command-line arg
  "plain_prompt",         // Just prompt the user in the TUI
]);

/**
 * Create a bootstrap action for submitting a goal to the TUI.
 *
 * @param {object} options
 * @param {string} options.method - Bootstrap method (from GOAL_BOOTSTRAP_METHODS)
 * @param {string} options.goalText - The goal text to submit
 * @param {string} [options.idempotencyKey] - Idempotency key for dedup
 * @param {number} [options.timeoutMs] - Max time to wait for each phase
 * @returns {{ type: string, method: string, goal_text: string, idempotency_key: string|null, timeout_ms: number }}
 */
export function createGoalBootstrapAction({
  method,
  goalText,
  idempotencyKey = null,
  timeoutMs = 30_000,
} = {}) {
  if (!method || !GOAL_BOOTSTRAP_METHODS.includes(method)) {
    throw new Error(`Invalid bootstrap method: ${method}. Must be one of: ${GOAL_BOOTSTRAP_METHODS.join(", ")}`);
  }
  if (!goalText) throw new Error("goalText is required");

  return {
    type: "goal_bootstrap",
    method,
    goal_text: goalText,
    idempotency_key: idempotencyKey,
    timeout_ms: timeoutMs,
  };
}

/**
 * Create a slash command action.
 *
 * @param {object} options
 * @param {string} options.command - The slash command (e.g., "/goal")
 * @param {string} [options.argument] - Optional argument after the command
 * @param {number} [options.waitAfterMs] - Time to wait after sending the command
 * @returns {{ type: string, command: string, argument: string|null, wait_after_ms: number }}
 */
export function createSlashCommandAction({
  command,
  argument = null,
  waitAfterMs = 500,
} = {}) {
  if (!command || !command.startsWith("/")) {
    throw new Error(`Invalid slash command: ${command}. Must start with "/"`);
  }
  return {
    type: "slash_command",
    command,
    argument,
    wait_after_ms: waitAfterMs,
    command_text: argument ? `${command} ${argument}\r` : `${command}\r`,
  };
}
