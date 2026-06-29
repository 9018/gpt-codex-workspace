import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";
import { createCodexTuiPtyAdapter } from "./codex-tui-pty-adapter.mjs";
import { buildCodexTuiBootstrapMessages } from "./codex-tui-goal-prompt.mjs";

const activeSessions = new Map();
const sessionStores = new Map();

function sessionIdFor(task, goal) {
  const taskId = String(task?.id || "task").replace(/[^A-Za-z0-9_-]/g, "_");
  const goalId = String(goal?.id || "goal").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${goalId}_${taskId}`;
}

function activeManagerForSession(sessionId) {
  const active = activeSessions.get(sessionId);
  if (active) return active;
  throw new Error(`codex TUI session is not active: ${sessionId}`);
}

function storeForSession(sessionId) {
  const store = sessionStores.get(sessionId);
  if (store) return store;
  throw new Error(`codex TUI session is unknown: ${sessionId}`);
}

export async function startCodexTuiGoalSession({ task, goal, cwd, repoLockId = null, ptyAdapter = null } = {}) {
  if (!cwd) throw new Error("cwd is required");
  if (!goal?.id) throw new Error("goal.id is required");
  const store = createCodexTuiSessionStore({ workspaceRoot: cwd });
  const adapter = ptyAdapter || createCodexTuiPtyAdapter();
  const sessionId = sessionIdFor(task, goal);
  sessionStores.set(sessionId, store);

  let record = await store.createSession({
    sessionId,
    taskId: task?.id || null,
    goalId: goal.id,
    cwd,
    repoLockId,
  });

  const ptySession = await adapter.spawn({
    cwd,
    onData: (chunk) => {
      store.appendSessionLog(sessionId, chunk).catch(() => {});
    },
  });

  activeSessions.set(sessionId, { store, ptySession });

  const messages = buildCodexTuiBootstrapMessages({ goalId: goal.id, taskTitle: task?.title || goal?.title || task?.id });
  for (const message of messages) ptySession.write(message);

  record = await store.updateSession(sessionId, {
    status: "running",
    pty_pid: ptySession.pid ?? null,
    started_at: new Date().toISOString(),
  });
  return record;
}

export async function readCodexTuiSession(sessionId, { maxChars } = {}) {
  const store = storeForSession(sessionId);
  return store.readSession(sessionId, { maxChars });
}

export async function sendCodexTuiSessionInput(sessionId, text) {
  const { store, ptySession } = activeManagerForSession(sessionId);
  ptySession.write(text);
  await store.appendSessionLog(sessionId, `[input] ${String(text ?? "")}`);
  return store.readSession(sessionId);
}

export async function stopCodexTuiSession(sessionId, { reason = "stopped" } = {}) {
  const active = activeManagerForSession(sessionId);
  active.ptySession.stop();
  activeSessions.delete(sessionId);
  return active.store.updateSession(sessionId, {
    status: "stopped",
    stop_reason: reason,
    stopped_at: new Date().toISOString(),
  });
}

export async function getCodexTuiSessionStatus(sessionId) {
  const store = storeForSession(sessionId);
  const active = activeSessions.get(sessionId);
  const record = await store.readSession(sessionId, { maxChars: 0 });
  return {
    id: record.id,
    status: record.status,
    task_id: record.task_id,
    goal_id: record.goal_id,
    pid: active?.ptySession?.pid ?? record.pty_pid ?? null,
    updated_at: record.updated_at,
  };
}

export function resetCodexTuiSessionManagerForTests() {
  for (const { ptySession } of activeSessions.values()) {
    try { ptySession.stop("test reset"); } catch { /* non-fatal */ }
  }
  activeSessions.clear();
  sessionStores.clear();
}
