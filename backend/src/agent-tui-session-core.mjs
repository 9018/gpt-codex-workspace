/**
 * agent-tui-session-core.mjs — Shared session management for agent TUI providers.
 *
 * Both codex_tui_goal and claude_tui_goal use this core, parameterized by:
 *   - createPtyAdapter: function that returns a PTY adapter
 *   - buildBootstrapMessages: function that builds initial prompt messages
 *   - providerName: string used for error messages and logging
 *
 * Session store and active session state are shared across all providers
 * so that the same session ID registry works regardless of provider.
 */

import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";

// ---------------------------------------------------------------------------
// Shared state (global to all agent TUI providers)
// ---------------------------------------------------------------------------

const activeSessions = new Map();
const sessionStores = new Map();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function candidateWorkspaceRoots({ workspaceRoot = null, candidateWorkspaceRoots = [] } = {}) {
  return uniqueStrings([workspaceRoot, ...candidateWorkspaceRoots, process.cwd()]);
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionIdFor(task, goal) {
  const taskId = String(task?.id || "task").replace(/[^A-Za-z0-9_-]/g, "_");
  const goalId = String(goal?.id || "goal").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${goalId}_${taskId}`;
}

function activeManagerForSession(sessionId) {
  const active = activeSessions.get(sessionId);
  if (active) return active;
  throw new Error(`TUI session is not active: ${sessionId}`);
}

async function storeForSession(sessionId, options = {}) {
  const store = sessionStores.get(sessionId);
  if (store) return store;

  for (const root of candidateWorkspaceRoots(options)) {
    const candidate = createCodexTuiSessionStore({ workspaceRoot: root });
    try {
      await candidate.readSession(sessionId, { maxChars: 0 });
      sessionStores.set(sessionId, candidate);
      return candidate;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`TUI session is unknown: ${sessionId}`);
}

async function normalizeRecoveredSessionRecord(store, sessionId, record = null) {
  const current = record || await store.readSession(sessionId, { maxChars: 0 });
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
 * Wait briefly for the TUI process to produce output (indicating it is ready).
 * Returns the ISO timestamp of first detected output, or null if timed out.
 */
async function waitForTuiOutput(sessionId, store, readyTimeoutMs = 5_000) {
  const start = Date.now();
  const deadline = start + readyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = await store.readSession(sessionId, { maxChars: 200 });
      if (record.log && record.log.length > 10) {
        return new Date().toISOString();
      }
    } catch { /* session may not have log yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a set of session management functions for an agent TUI provider.
 *
 * @param {object} options
 * @param {string} options.providerName - Provider name for labels/errors (e.g. "codex", "claude")
 * @param {Function} options.createPtyAdapter - Factory returning a PTY adapter with .spawn()
 * @param {Function} options.buildBootstrapMessages - Function ({ goalId, taskTitle }) => string[]
 * @returns {object} { startGoalSession, resumeSession, readSession, sendSessionInput, stopSession, getSessionStatus, resetForTests }
 */
export function createAgentTuiSessionManager({
  providerName = "agent",
  createPtyAdapter,
  buildBootstrapMessages,
} = {}) {
  if (!createPtyAdapter) throw new Error("createPtyAdapter is required");
  if (!buildBootstrapMessages) throw new Error("buildBootstrapMessages is required");

  const startGoalSession = async ({ task, goal, cwd, repoLockId = null, ptyAdapter = null, releaseLockFn = null } = {}) => {
    if (!cwd) throw new Error("cwd is required");
    if (!goal?.id) throw new Error("goal.id is required");
    const store = createCodexTuiSessionStore({ workspaceRoot: cwd });
    const adapter = ptyAdapter || createPtyAdapter();
    const sessionId = sessionIdFor(task, goal);
    sessionStores.set(sessionId, store);

    let record = await store.createSession({
      sessionId,
      taskId: task?.id || null,
      goalId: goal.id,
      cwd,
      repoLockId,
      metadata: { provider: providerName },
    });

    // Launch codex bare — no argv prompt.
    // Prompt is submitted via stdin after TUI is ready.
    const ptySession = await adapter.spawn({
      cwd,
      onData: (chunk) => {
        store.appendSessionLog(sessionId, chunk).catch(() => {});
      },
    });

    activeSessions.set(sessionId, { store, ptySession });

    // Phase 1: wait for TUI ready (first output on PTY)
    const firstOutputAt = await waitForTuiOutput(sessionId, store, 5_000);

    // Phase 2: submit prompt via stdin (messages already include \n)
    const messages = buildBootstrapMessages({ goalId: goal.id, taskTitle: task?.title || goal?.title || task?.id });
    const bootstrapSentAt = new Date().toISOString();
    for (const message of messages) {
      ptySession.write(message);
    }

    record = await store.updateSession(sessionId, {
      status: "running",
      pty_pid: ptySession.pid ?? null,
      started_at: bootstrapSentAt,
      bootstrap_sent_at: bootstrapSentAt,
      bootstrap_method: "stdin_enter",
      first_output_at: firstOutputAt,
      submitted: true,
    });
    return { ...record, bootstrap_sent_at: bootstrapSentAt, first_output_at: firstOutputAt, bootstrap_method: "stdin_enter" };
  };

  const resumeSession = async (sessionId, { workspaceRoot = null, candidateWorkspaceRoots: extraRoots = [], ptyAdapter = null, taskTitle = null } = {}) => {
    const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: extraRoots });
    const record = await normalizeRecoveredSessionRecord(store, sessionId);
    const active = activeSessions.get(sessionId);
    if (active?.ptySession) return store.readSession(sessionId, { maxChars: 0 });
    if (!record.cwd) throw new Error(`TUI session has no cwd: ${sessionId}`);
    if (!record.goal_id) throw new Error(`TUI session has no goal_id: ${sessionId}`);

    const adapter = ptyAdapter || createPtyAdapter();
    const ptySession = await adapter.spawn({
      cwd: record.cwd,
      onData: (chunk) => {
        store.appendSessionLog(sessionId, chunk).catch(() => {});
      },
    });

    activeSessions.set(sessionId, { store, ptySession });
    await store.appendSessionLog(sessionId, `[system] Resuming ${providerName} TUI session with a new PTY for goal_id=${record.goal_id}`);

    const messages = buildBootstrapMessages({
      goalId: record.goal_id,
      taskTitle: taskTitle || record.metadata?.task_title || record.task_id || record.goal_id,
    });
    for (const message of messages) ptySession.write(message);

    const restartCount = Number(record.restart_count || 0) + 1;
    return store.updateSession(sessionId, {
      status: "running",
      pty_pid: ptySession.pid ?? null,
      restarted_at: new Date().toISOString(),
      restart_count: restartCount,
      detach_reason: null,
      detached_at: null,
    });
  };

  const readSession = async (sessionId, { maxChars, workspaceRoot = null, candidateWorkspaceRoots: extraRoots = [] } = {}) => {
    const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: extraRoots });
    await normalizeRecoveredSessionRecord(store, sessionId);
    return store.readSession(sessionId, { maxChars });
  };

  const sendSessionInput = async (sessionId, text, options = {}) => {
    await storeForSession(sessionId, options);
    const { store, ptySession } = activeManagerForSession(sessionId);
    ptySession.write(text);
    await store.appendSessionLog(sessionId, `[input] ${String(text ?? "")}`);
    return store.readSession(sessionId);
  };

  const stopSession = async (sessionId, { reason = "stopped", workspaceRoot = null, candidateWorkspaceRoots: extraRoots = [], releaseLockFn = null } = {}) => {
    const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: extraRoots });
    const active = activeSessions.get(sessionId);
    if (active?.ptySession) {
      active.ptySession.stop();
      activeSessions.delete(sessionId);
    } else {
      await normalizeRecoveredSessionRecord(store, sessionId);
    }
    // Release repo lock if a release function was provided
    if (typeof releaseLockFn === "function") {
      try { await releaseLockFn(); } catch { /* non-fatal */ }
    }
    return store.updateSession(sessionId, {
      status: "stopped",
      stop_reason: reason,
      stopped_at: new Date().toISOString(),
    });
  };

  const getSessionStatus = async (sessionId, { workspaceRoot = null, candidateWorkspaceRoots: extraRoots = [] } = {}) => {
    const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots: extraRoots });
    const active = activeSessions.get(sessionId);
    const record = await normalizeRecoveredSessionRecord(store, sessionId);
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
  };

  const resetForTests = () => {
    for (const { ptySession } of activeSessions.values()) {
      try { ptySession.stop("test reset"); } catch { /* non-fatal */ }
    }
    activeSessions.clear();
    sessionStores.clear();
  };

  return {
    startGoalSession,
    resumeSession,
    readSession,
    sendSessionInput,
    stopSession,
    getSessionStatus,
    resetForTests,
  };
}
