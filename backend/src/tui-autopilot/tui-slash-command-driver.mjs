/**
 * tui-slash-command-driver.mjs — Slash command driver for TUI sessions.
 *
 * Generic driver for sending slash commands (/goal, /task, etc.) and
 * waiting for the expected response states.
 *
 * @module tui-slash-command-driver
 */

import { createSlashCommandAction } from "./tui-action-schema.mjs";

/**
 * Create a slash command driver.
 *
 * @param {object} deps
 * @param {Function} deps.writeInput - Write text to the TUI
 * @param {Function} [deps.classifyScreen] - Classify current screen state
 * @param {Function} [deps.waitForState] - Wait for screen to reach a state
 * @returns {object} Slash command driver API
 */
export function createTuiSlashCommandDriver({ writeInput, classifyScreen = null, waitForState = null } = {}) {
  if (!writeInput) throw new Error("writeInput is required");

  /**
   * Execute a slash command and optionally wait for a response state.
   *
   * @param {object} options
   * @param {string} options.command - The slash command (e.g., "/goal")
   * @param {string} [options.argument] - Command argument
   * @param {number} [options.timeoutMs=30000] - Max time to wait for response
   * @returns {Promise<{ command: string, argument: string|null, ok: boolean, error: string|null }>}
   */
  async function execute({ command, argument = null, timeoutMs = 30_000 } = {}) {
    const action = createSlashCommandAction({ command, argument });
    const baseError = `slash command "${command}"`;

    try {
      // Send the slash command
      await new Promise((resolve) => {
        writeInput(action.command_text);
        setTimeout(resolve, action.wait_after_ms);
      });

      // If we have screen classification, wait for response
      if (typeof waitForState === "function" && typeof classifyScreen === "function") {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await classifyScreen().catch(() => null);
          if (state === "ready_for_input" || state === "goal_input" || state === "executing") {
            return { command, argument, ok: true, error: null };
          }
          if (state === "completed" || state === "failed") {
            return { command, argument, ok: true, error: null };
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        return { command, argument, ok: false, error: `${baseError}: timeout waiting for response` };
      }

      return { command, argument, ok: true, error: null };
    } catch (err) {
      return { command, argument, ok: false, error: `${baseError}: ${err.message}` };
    }
  }

  return { execute };
}
