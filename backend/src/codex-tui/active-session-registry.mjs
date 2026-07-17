/**
 * active-session-registry.mjs — Runtime registry of active TUI sessions.
 *
 * Stores the in-memory state of active (running) TUI sessions and their
 * associated PTY sessions, stores, and lifecycle callbacks.
 *
 * @module active-session-registry
 */

/** @type {Map<string, { store: object, ptySession: object, releaseLockFn: Function|null, onTerminalized: Function|null }>} */
export const activeSessions = new Map();

/** @type {Map<string, object>} Session store instances (cached per session ID). */
export const sessionStores = new Map();

/** @type {Map<string, { cwd: string, promise: Promise<object> }>} */
export const pendingSessionStarts = new Map();

/** @type {Map<string, Promise<object>>} */
export const pendingTerminalizations = new Map();

/**
 * Get the active manager entry for a session ID.
 * @param {string} sessionId
 * @returns {object} active session entry
 * @throws {Error} If session is not active
 */
export function activeManagerForSession(sessionId) {
  const active = activeSessions.get(sessionId);
  if (active) return active;
  throw new Error(`codex TUI session is not active: ${sessionId}`);
}

/**
 * Clear all in-memory state (used in tests).
 */
export function resetCodexTuiSessionRegistryForTests() {
  for (const { ptySession } of activeSessions.values()) {
    try { ptySession.stop("test reset"); } catch { /* non-fatal */ }
  }
  activeSessions.clear();
  sessionStores.clear();
  pendingSessionStarts.clear();
  pendingTerminalizations.clear();
}
