/**
 * tui-goal-command-driver.mjs — Two-phase /goal command driver.
 *
 * Implements the two-phase /goal interaction protocol:
 * Phase 1: Send "/goal\r" and wait for the goal input prompt
 * Phase 2: Send the goal text and wait for execution state
 *
 * Fallback order per plan: /goal -> argv prompt -> plain prompt
 * Idempotency key: goal-bootstrap:<run-id>:<plan-revision>
 *
 * @module tui-goal-command-driver
 */

import { createGoalBootstrapAction, GOAL_BOOTSTRAP_METHODS } from "./tui-action-schema.mjs";

/**
 * Create the /goal command driver.
 *
 * @param {object} deps
 * @param {Function} deps.writeInput - Write text to the TUI
 * @param {Function} [deps.classifyScreen] - Classify current screen state
 * @param {Function} [deps.waitForState] - Wait for screen to reach a state
 * @param {Function} [deps.isGoalSubmitted] - Check if goal was already submitted (idempotency)
 * @param {number} [deps.phaseTimeoutMs=30000] - Max time per phase
 * @returns {object} Goal command driver API
 */
export function createTuiGoalCommandDriver({
  writeInput,
  classifyScreen = null,
  waitForState = null,
  isGoalSubmitted = null,
  phaseTimeoutMs = 30_000,
} = {}) {
  if (!writeInput) throw new Error("writeInput is required");

  /**
   * Submit a goal via the two-phase /goal protocol.
   *
   * Phase 1: Send "/goal\r", wait for goal_input prompt
   * Phase 2: Send goal text, wait for working/executing state
   *
   * @param {object} options
   * @param {string} options.goalText - The goal text to submit
   * @param {string} [options.idempotencyKey] - For dedup
   * @param {number} [options.timeoutMs] - Per-phase timeout
   * @returns {Promise<{ submitted: boolean, method: string, ok: boolean, error: string|null }>}
   */
  async function submitGoal({ goalText, idempotencyKey = null, timeoutMs = phaseTimeoutMs } = {}) {
    if (!goalText) throw new Error("goalText is required");

    // Check idempotency: if this key was already submitted, skip
    if (idempotencyKey && typeof isGoalSubmitted === "function") {
      const alreadySubmitted = await isGoalSubmitted(idempotencyKey);
      if (alreadySubmitted) {
        return { submitted: false, method: "goal_slash_command", ok: true, error: null, idempotent: true };
      }
    }

    // Build bootstrap action metadata
    const action = createGoalBootstrapAction({
      method: "goal_slash_command",
      goalText,
      idempotencyKey,
      timeoutMs,
    });

    try {
      // --- Phase 1: Send /goal, wait for goal_input ---
      await new Promise((resolve) => {
        writeInput("/goal\r");
        setTimeout(resolve, 500);
      });

      if (typeof waitForState === "function" && typeof classifyScreen === "function") {
        const phase1Result = await waitForState("goal_input", { timeoutMs: timeoutMs * 0.4 });
        if (!phase1Result) {
          // Phase 1 failed — /goal didn't produce goal_input
          // This might mean /goal is not available, return fallback signal
          return {
            submitted: false,
            method: "goal_slash_command",
            ok: false,
            error: "TUI did not respond to /goal command; suggest argv fallback",
            fallback: true,
          };
        }
      } else {
        // No screen classifier — best-effort delay
        await new Promise((r) => setTimeout(r, 2000));
      }

      // --- Phase 2: Send goal text, wait for execution ---
      const goalInput = `${goalText}\r`;
      await new Promise((resolve) => {
        writeInput(goalInput);
        setTimeout(resolve, 500);
      });

      if (typeof waitForState === "function") {
        const phase2Result = await waitForState("executing", { timeoutMs: timeoutMs * 0.6 });
        if (!phase2Result) {
          return {
            submitted: false,
            method: "goal_slash_command",
            ok: false,
            error: "TUI did not start executing after goal input",
            fallback: true,
          };
        }
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }

      return { submitted: true, method: "goal_slash_command", ok: true, error: null };
    } catch (err) {
      return {
        submitted: false,
        method: "goal_slash_command",
        ok: false,
        error: `Goal submission failed: ${err.message}`,
        fallback: true,
      };
    }
  }

  /**
   * Check which bootstrap method is available for this session.
   * Returns the best available method.
   *
   * @returns {Promise<string>} GOAL_BOOTSTRAP_METHODS entry
   */
  async function detectMethod() {
    if (typeof classifyScreen === "function") {
      try {
        const state = await classifyScreen();
        // If screen shows ready_for_input, /goal command is likely
        if (state === "ready_for_input" || state === "ready_for_instruction") {
          return "goal_slash_command";
        }
      } catch {
        // Fall through to default
      }
    }
    // Default: try /goal first, fall back to argv
    return "goal_slash_command";
  }

  return { submitGoal, detectMethod };
}

/**
 * Attempt to submit a goal to a running TUI session using the best
 * available method, with fallback chain: /goal -> argv prompt -> plain prompt.
 *
 * @param {object} options
 * @param {Function} options.writeInput - Function to send text to the TUI
 * @param {string} options.goalText - The goal text to submit
 * @param {string} [options.idempotencyKey] - For dedup
 * @param {Function} [options.classifyScreen]
 * @param {Function} [options.waitForState]
 * @param {Function} [options.isGoalSubmitted]
 * @param {object} [options.bootstrapState] - Shared state tracker
 * @returns {Promise<{ submitted: boolean, method: string, ok: boolean, error: string|null, fallback?: boolean }>}
 */
export async function bootstrapGoalWithFallback({
  writeInput,
  goalText,
  idempotencyKey = null,
  classifyScreen = null,
  waitForState = null,
  isGoalSubmitted = null,
  bootstrapState = null,
} = {}) {
  if (!writeInput) throw new Error("writeInput is required");
  if (!goalText) throw new Error("goalText is required");

  const state = bootstrapState || {};

  // Attempt 1: /goal slash command
  if (!state.skipGoalSlash) {
    const driver = createTuiGoalCommandDriver({
      writeInput,
      classifyScreen,
      waitForState,
      isGoalSubmitted,
    });
    const result = await driver.submitGoal({ goalText, idempotencyKey });
    if (result.ok || result.idempotent) return result;
    state.skipGoalSlash = true;
  }

  // Attempt 2: argv prompt (send ENTER to trigger the argv-passed goal)
  if (!state.skipArgv) {
    try {
      await new Promise((resolve) => {
        writeInput("\r");
        setTimeout(resolve, 1000);
      });
      state.skipArgv = true;
      return { submitted: true, method: "argv_prompt", ok: true, error: null };
    } catch (err) {
      state.skipArgv = true;
    }
  }

  // Attempt 3: plain prompt
  if (!state.skipPlain) {
    try {
      await new Promise((resolve) => {
        writeInput(`${goalText}\r`);
        setTimeout(resolve, 1000);
      });
      state.skipPlain = true;
      return { submitted: true, method: "plain_prompt", ok: true, error: null };
    } catch (err) {
      state.skipPlain = true;
      return { submitted: false, method: "plain_prompt", ok: false, error: `All bootstrap methods failed: ${err.message}` };
    }
  }

  return { submitted: false, method: "plain_prompt", ok: false, error: "All bootstrap methods exhausted" };
}
