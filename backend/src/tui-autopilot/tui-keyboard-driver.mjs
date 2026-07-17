/**
 * tui-keyboard-driver.mjs — Safe keyboard input driver for TUI sessions.
 *
 * Provides a controlled interface for sending keyboard input to a TUI
 * session with proper timing, optional waiting for screen changes, and
 * error handling.
 *
 * @module tui-keyboard-driver
 */

/**
 * Create a keyboard driver.
 *
 * @param {object} deps
 * @param {Function} deps.writeInput - Function to write text to the TUI (async)
 * @param {Function} [deps.waitForScreen] - Optional: wait for screen state (async)
 * @param {number} [deps.defaultWaitMs=300] - Default post-send wait
 * @returns {object} Keyboard driver API
 */
export function createTuiKeyboardDriver({ writeInput, waitForScreen = null, defaultWaitMs = 300 } = {}) {
  if (!writeInput) throw new Error("writeInput is required");

  /**
   * Send text to the TUI and optionally wait.
   *
   * @param {string} text - Text to send
   * @param {object} [options]
   * @param {number} [options.waitMs] - Post-send wait duration
   * @param {boolean} [options.waitForResponse] - Whether to wait for screen update
   * @returns {Promise<void>}
   */
  async function send(text, { waitMs, waitForResponse = false } = {}) {
    const delay = waitMs ?? defaultWaitMs;
    const input = String(text ?? "");
    // Send input via the provided write function
    await Promise.resolve(writeInput(input));
    // Wait for the specified delay
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // Optionally wait for screen change
    if (waitForResponse && typeof waitForScreen === "function") {
      await waitForScreen();
    }
  }

  /**
   * Send a single key press (like Enter, Ctrl+C, etc.).
   *
   * @param {string} key - Key sequence to send
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async function press(key, options = {}) {
    return send(key, { waitMs: 200, ...options });
  }

  /**
   * Type text character by character with inter-character delay.
   * Useful for slower terminals or typed input.
   *
   * @param {string} text - Text to type
   * @param {object} [options]
   * @param {number} [options.charDelayMs=50] - Delay between characters
   * @param {number} [options.finalWaitMs=300] - Wait after typing
   * @returns {Promise<void>}
   */
  async function type(text, { charDelayMs = 50, finalWaitMs = 300 } = {}) {
    for (const char of String(text ?? "")) {
      await Promise.resolve(writeInput(char));
      if (charDelayMs > 0) await new Promise((r) => setTimeout(r, charDelayMs));
    }
    if (finalWaitMs > 0) await new Promise((r) => setTimeout(r, finalWaitMs));
  }

  return { send, press, type };
}
