/**
 * session-recovery.mjs — Session recovery and re-attachment.
 *
 * Handles detecting detached/stale sessions and normalizing recovered
 * session records from the persistent store.
 *
 * @module session-recovery
 */

import { isProcessAlive } from "./session-process-cleanup.mjs";
import { activeSessions } from "./active-session-registry.mjs";

/**
 * Check whether a session's PTY process is still alive and normalize
 * the record if it has detached.
 *
 * Active sessions (tracked in-memory) are returned as-is without PID
 * check, since the PTY is managed by the active session entry.
 *
 * @param {object} store
 * @param {string} sessionId
 * @param {object|null} [record]
 * @returns {Promise<object>} The (possibly updated) record
 */
export async function normalizeRecoveredSessionRecord(store, sessionId, record = null) {
  const current = record || await store.readSession(sessionId, { maxChars: 0 });
  // Active sessions tracked in-memory are known to be alive
  if (activeSessions.has(sessionId)) return current;
  if (current.status === "running" && current.pty_pid && !isProcessAlive(current.pty_pid)) {
    return store.updateSession(sessionId, {
      status: "detached",
      detach_reason: "pty_process_not_alive",
      detached_at: new Date().toISOString(),
    });
  }
  return current;
}

/**
 * Wait for a TUI session to produce its first output.
 *
 * @param {object} store
 * @param {string} sessionId
 * @param {number} [readyTimeoutMs=5000]
 * @returns {Promise<string|null>} ISO timestamp of first output, or null if timeout
 */
export function waitForTuiOutput(store, sessionId, readyTimeoutMs = 5_000) {
  const start = Date.now();
  const deadline = start + readyTimeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (Date.now() >= deadline) { resolve(null); return; }
      store.readSession(sessionId, { maxChars: 200 }).then((rec) => {
        if (rec.log && rec.log.length > 10) {
          resolve(new Date().toISOString());
        } else {
          setTimeout(poll, 300);
        }
      }).catch(() => setTimeout(poll, 300));
    };
    poll();
  });
}
