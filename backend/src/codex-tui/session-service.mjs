/**
 * session-service.mjs — Public API for Codex TUI session management.
 *
 * Orchestrates session lifecycle: start, read, stop, status.
 * Intended to be < 300 lines.
 *
 * @module session-service
 */

import { join } from "node:path";
import {
  activeSessions,
  pendingSessionStarts,
} from "./active-session-registry.mjs";
import {
  startCodexTuiGoalSessionImpl,
  sessionIdFor,
  findStoreForSession,
} from "./session-bootstrap.mjs";
import { normalizeRecoveredSessionRecord } from "./session-recovery.mjs";
import {
  terminalizeCodexTuiSession,
  normalizeTerminalResultCandidate,
} from "./session-terminalizer.mjs";
import { codexTuiGoalArtifactCandidates, firstMatchingJsonArtifact } from "./result-locator.mjs";
import { isProcessAlive, candidateWorkspaceRoots } from "./session-process-cleanup.mjs";

/**
 * Start a Codex TUI goal session.  Idempotent by sessionId: if a session
 * is already starting or running, returns the existing promise.
 *
 * @param {object} args
 * @returns {Promise<object>} Session record
 */
export async function startCodexTuiGoalSession(args = {}) {
  const sessionId = sessionIdFor(args.task, args.goal);
  const pending = pendingSessionStarts.get(sessionId);
  if (pending) {
    if (pending.cwd !== args.cwd) {
      const err = new Error(`codex TUI session ${sessionId} is already starting in a different cwd`);
      err.code = "codex_tui_session_conflict";
      throw err;
    }
    return pending.promise;
  }

  const promise = startCodexTuiGoalSessionImpl(args).finally(() => {
    if (pendingSessionStarts.get(sessionId)?.promise === promise) pendingSessionStarts.delete(sessionId);
  });
  pendingSessionStarts.set(sessionId, { cwd: args.cwd, promise });
  return promise;
}

/**
 * Read a session record (with recovery check).
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function readCodexTuiSession(sessionId, { maxChars, workspaceRoot = null, candidateWorkspaceRoots: candidateRoots = [] } = {}) {
  const store = await findStoreForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: candidateRoots });
  await normalizeRecoveredSessionRecord(store, sessionId);
  return store.readSession(sessionId, { maxChars });
}

/**
 * Stop and terminalize a Codex TUI session.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @returns {Promise<object>} Terminalized session record
 */
export async function stopCodexTuiSession(sessionId, { reason = "stopped", workspaceRoot = null, candidateWorkspaceRoots: candidateRoots = [], releaseLockFn = null } = {}) {
  const store = await findStoreForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: candidateRoots });
  const active = activeSessions.get(sessionId);
  const terminalized = await terminalizeCodexTuiSession({
    sessionId,
    store,
    releaseLockFn: releaseLockFn || active?.releaseLockFn || null,
    onTerminalized: active?.onTerminalized || null,
    event: {
      source: reason === "evidence_timeout" ? "evidence_timeout" : "explicit-stop",
      exit_code: null,
      signal: "SIGTERM",
      error: reason,
      error_code: null,
    },
  });
  if (active?.ptySession) {
    active.ptySession.stop();
    activeSessions.delete(sessionId);
  } else {
    await normalizeRecoveredSessionRecord(store, sessionId);
  }
  return terminalized;
}

/**
 * Get the current status of a Codex TUI session.
 * Checks for result.json evidence even for running sessions.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @returns {Promise<object>} Status descriptor
 */
export async function getCodexTuiSessionStatus(sessionId, { workspaceRoot = null, candidateWorkspaceRoots: candidateRoots = [] } = {}) {
  const store = await findStoreForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: candidateRoots });
  let active = activeSessions.get(sessionId);
  let record = await normalizeRecoveredSessionRecord(store, sessionId);

  if (["created", "running"].includes(record.status)) {
    const root = record.metadata?.session_store_root || record.metadata?.workspace_root;
    const resultCandidates = root && record.goal_id
      ? codexTuiGoalArtifactCandidates({ workspaceRoot: root, cwd: record.cwd, goalId: record.goal_id, filename: "result.json" })
      : [];
    const locatedTerminalResult = await firstMatchingJsonArtifact(resultCandidates, (value) => Boolean(normalizeTerminalResultCandidate(value)));
    const terminalResult = normalizeTerminalResultCandidate(locatedTerminalResult?.value);
    if (terminalResult) {
      record = await terminalizeCodexTuiSession({
        sessionId, store,
        releaseLockFn: active?.releaseLockFn || null,
        onTerminalized: active?.onTerminalized || null,
        event: { source: "result-evidence", error: terminalResult.summary },
      });
      if (active?.ptySession) {
        try { active.ptySession.stop(); } catch { /* terminal state already durable */ }
      }
      activeSessions.delete(sessionId);
      active = null;
    }
  }

  const pid = active?.ptySession?.pid ?? record.pty_pid ?? null;
  return {
    id: record.id,
    status: record.status,
    task_id: record.task_id,
    goal_id: record.goal_id,
    pid,
    pid_alive: active ? true : isProcessAlive(pid),
    detached: record.status === "detached",
    detach_reason: record.detach_reason || null,
    updated_at: record.updated_at,
  };
}
