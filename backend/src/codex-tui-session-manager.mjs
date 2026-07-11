import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";
import { createCodexTuiPtyAdapter } from "./codex-tui-pty-adapter.mjs";
import { buildCodexTuiGoalObjective } from "./codex-tui-goal-prompt.mjs";

const activeSessions = new Map();
const sessionStores = new Map();
const pendingSessionStarts = new Map();

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
  throw new Error(`codex TUI session is not active: ${sessionId}`);
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
  throw new Error(`codex TUI session is unknown: ${sessionId}`);
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

function waitForTuiOutput(store, sessionId, readyTimeoutMs = 5_000) {
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

async function startCodexTuiGoalSessionImpl({
  task,
  goal,
  cwd,
  workspaceRoot = null,
  candidateWorkspaceRoots = [],
  repoLockId = null,
  ptyAdapter = null,
  command = "codex",
  evidenceWaitMs = null,
  requireSuperpowers = true,
} = {}) {
  if (!cwd) throw new Error("cwd is required");
  if (!goal?.id) throw new Error("goal.id is required");
  const sessionStoreRoot = workspaceRoot || candidateWorkspaceRoots[0] || cwd;
  const deprecatedCwdSessionRoot = !workspaceRoot && candidateWorkspaceRoots.length === 0;
  const store = createCodexTuiSessionStore({ workspaceRoot: sessionStoreRoot });
  const adapter = ptyAdapter || createCodexTuiPtyAdapter({ command });
  const sessionId = sessionIdFor(task, goal);
  sessionStores.set(sessionId, store);

  let existing = null;
  try { existing = await store.readSession(sessionId, { maxChars: 0 }); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  if (existing && ["created", "running"].includes(existing.status)) {
    if (existing.cwd !== cwd) {
      const err = new Error(`codex TUI session ${sessionId} already exists in a different cwd`);
      err.code = "codex_tui_session_conflict";
      throw err;
    }
    if (activeSessions.has(sessionId) || (existing.pty_pid && isProcessAlive(existing.pty_pid))) return existing;
    await store.updateSession(sessionId, {
      status: "failed",
      error: "stale session record found during restart",
      error_code: "codex_tui_stale_start",
      failed_at: new Date().toISOString(),
    });
  }

  let record = await store.createSession({
    sessionId,
    taskId: task?.id || null,
    goalId: goal.id,
    cwd,
    repoLockId,
    metadata: {
      workspace_root: sessionStoreRoot,
      session_store_root: sessionStoreRoot,
      command,
      evidence_wait_ms: Number.isFinite(Number(evidenceWaitMs)) ? Number(evidenceWaitMs) : null,
      require_superpowers_for_tui: requireSuperpowers !== false,
      deprecation_warnings: deprecatedCwdSessionRoot ? ["startCodexTuiGoalSession without workspaceRoot stores sessions under cwd; pass workspaceRoot explicitly"] : [],
    },
  });

  // Launch the interactive Codex TUI with its supported initial PROMPT argv.
  // This is deterministic across node-pty and script(1), and avoids synthetic
  // keystrokes racing the terminal's initialization/input editor.
  const initialPrompt = buildCodexTuiGoalObjective({
    goalId: goal.id,
    taskTitle: task?.title || goal?.title || task?.id,
  });
  let ptySession;
  try {
    ptySession = await adapter.spawn({
      cwd,
      command,
      args: [initialPrompt],
      onData: (chunk) => {
        store.appendSessionLog(sessionId, chunk).catch(() => {});
      },
    });
  } catch (err) {
    await store.updateSession(sessionId, {
      status: "failed",
      error: err?.message || String(err),
      error_code: err?.code || null,
      failed_at: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }

  activeSessions.set(sessionId, { store, ptySession });

  // The initial prompt is submitted by Codex itself during startup. First PTY
  // output is retained as observability evidence, not as an input-readiness gate.
  const bootstrapSentAt = new Date().toISOString();
  const firstOutputAt = await waitForTuiOutput(store, sessionId, 5_000);

  record = await store.updateSession(sessionId, {
    status: "running",
    pty_pid: ptySession.pid ?? null,
    started_at: bootstrapSentAt,
    bootstrap_sent_at: bootstrapSentAt,
    bootstrap_method: "argv_prompt",
    first_output_at: firstOutputAt,
    submitted: true,
  });
  return {
    ...record,
    bootstrap_sent_at: bootstrapSentAt,
    first_output_at: firstOutputAt,
    bootstrap_method: "argv_prompt",
    workspace_root: sessionStoreRoot,
    session_store_root: sessionStoreRoot,
    deprecated_cwd_session_root: deprecatedCwdSessionRoot,
  };
}

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

export async function readCodexTuiSession(sessionId, { maxChars, workspaceRoot = null, candidateWorkspaceRoots = [] } = {}) {
  const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots });
  await normalizeRecoveredSessionRecord(store, sessionId);
  return store.readSession(sessionId, { maxChars });
}

export async function sendCodexTuiSessionInput(sessionId, text, options = {}) {
  await storeForSession(sessionId, options);
  const { store, ptySession } = activeManagerForSession(sessionId);
  ptySession.write(text);
  await store.appendSessionLog(sessionId, `[input] ${String(text ?? "")}`);
  return store.readSession(sessionId);
}

export async function stopCodexTuiSession(sessionId, { reason = "stopped", workspaceRoot = null, candidateWorkspaceRoots = [], releaseLockFn = null } = {}) {
  const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots });
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
}

export async function getCodexTuiSessionStatus(sessionId, { workspaceRoot = null, candidateWorkspaceRoots = [] } = {}) {
  const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots });
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
}

export function resetCodexTuiSessionManagerForTests() {
  for (const { ptySession } of activeSessions.values()) {
    try { ptySession.stop("test reset"); } catch { /* non-fatal */ }
  }
  activeSessions.clear();
  sessionStores.clear();
  pendingSessionStarts.clear();
}
