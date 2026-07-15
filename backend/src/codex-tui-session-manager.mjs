import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";
import { createCodexTuiPtyAdapter } from "./codex-tui-pty-adapter.mjs";
import { buildCodexTuiGoalObjective } from "./codex-tui-goal-prompt.mjs";
import { join } from "node:path";
import { detectMeaningfulOutput } from "./codex-tui-progress-utils.mjs";
import { mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { validateTaskDelta, renderDeltaInstruction } from "./codex-tui-task-delta.mjs";
import { createTaskContextStore } from "./context-contract/task-context-store.mjs";
import { releaseLockForTask } from "./repo-lock.mjs";

const activeSessions = new Map();
const sessionStores = new Map();
const pendingSessionStarts = new Map();
const pendingTerminalizations = new Map();
const TERMINAL_RESULT_STATUSES = new Set(["completed", "failed", "timed_out"]);

export async function cleanupIsolatedWorktreeProcesses({
  cwd,
  currentPid = process.pid,
  procRoot = "/proc",
  readdirFn = readdir,
  readlinkFn = readlink,
  killFn = process.kill.bind(process),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = 500,
} = {}) {
  const target = String(cwd || "").trim();
  const guarded = process.platform === "linux" && target.includes("/.gptwork/worktrees/");
  if (!guarded) {
    return { attempted: false, target_cwd: target || null, terminated: [], killed: [], surviving: [] };
  }

  const matchingPids = async () => {
    const entries = await readdirFn(procRoot, { withFileTypes: true }).catch(() => []);
    const matches = [];
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1 || pid === Number(currentPid)) continue;
      const processCwd = await readlinkFn(join(procRoot, name, "cwd")).catch(() => null);
      if (processCwd === target) matches.push(pid);
    }
    return matches;
  };

  const terminated = await matchingPids();
  for (const pid of terminated) {
    try { killFn(pid, "SIGTERM"); } catch { /* process may have exited */ }
  }
  if (terminated.length > 0 && graceMs > 0) await sleepFn(graceMs);
  const survivorsAfterTerm = await matchingPids();
  const killed = [];
  for (const pid of survivorsAfterTerm) {
    try { killFn(pid, "SIGKILL"); killed.push(pid); } catch { /* process may have exited */ }
  }
  if (killed.length > 0) await sleepFn(50);
  const surviving = await matchingPids();
  return { attempted: true, target_cwd: target, terminated, killed, surviving };
}

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

function normalizeTerminalEvent(event = {}) {
  return {
    source: String(event.source || "pty-exit"),
    exit_code: Number.isInteger(event.exit_code) ? event.exit_code : null,
    signal: event.signal ?? null,
    error: event.error ? String(event.error) : null,
    error_code: event.error_code ? String(event.error_code) : null,
  };
}

function isContractValidTerminalResult(result) {
  return Boolean(
    result
    && typeof result === "object"
    && TERMINAL_RESULT_STATUSES.has(result.status)
    && typeof result.summary === "string"
    && Array.isArray(result.changed_files)
    && Object.hasOwn(result, "tests")
    && Object.hasOwn(result, "commit")
    && Object.hasOwn(result, "remote_head")
    && Array.isArray(result.warnings)
    && Array.isArray(result.followups)
    && result.verification
    && typeof result.verification === "object"
    && Array.isArray(result.verification.commands)
    && typeof result.verification.passed === "boolean"
  );
}

async function readTerminalResult(resultPath) {
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8"));
    return isContractValidTerminalResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

function failClosedResult(event) {
  const timedOut = event.source === "evidence_timeout" || event.source === "timeout";
  const detail = event.error
    || (event.exit_code !== null ? `PTY exited with code ${event.exit_code}` : null)
    || (event.signal ? `PTY exited from signal ${event.signal}` : null)
    || `PTY terminal event: ${event.source}`;
  return {
    status: timedOut ? "timed_out" : "failed",
    summary: `Codex TUI terminated without contract-valid result evidence: ${detail}`,
    changed_files: [],
    tests: "none",
    commit: "none",
    remote_head: "none",
    warnings: [],
    followups: [],
    verification: { commands: [], passed: false },
    terminal_event: event,
  };
}

async function terminalizeCodexTuiSession({ sessionId, store, event, releaseLockFn = null, onTerminalized = null }) {
  const pending = pendingTerminalizations.get(sessionId);
  if (pending) return pending;

  const promise = (async () => {
    const current = await store.readSession(sessionId, { maxChars: 0 });
    if (Number(current.terminal_event_count || 0) >= 1) return current;

    const terminalEvent = normalizeTerminalEvent(event);
    const workspaceRoot = current.metadata?.session_store_root || current.metadata?.workspace_root;
    const resultPath = join(workspaceRoot, ".gptwork", "goals", current.goal_id, "result.json");
    let result = await readTerminalResult(resultPath);
    if (!result) {
      result = failClosedResult(terminalEvent);
      await writeJsonAtomic(resultPath, result);
    }

    const processCleanup = await cleanupIsolatedWorktreeProcesses({ cwd: current.cwd });
    result = { ...result, process_cleanup: processCleanup };
    await writeJsonAtomic(resultPath, result);

    const terminalizedAt = new Date().toISOString();
    const status = result.status;
    const patch = {
      status,
      active: false,
      terminal_event: terminalEvent,
      terminal_event_count: 1,
      terminalized_at: terminalizedAt,
      result_json_path: resultPath,
      result_status: status,
      process_cleanup: processCleanup,
      ...(status === "completed" ? { completed_at: terminalizedAt } : {}),
      ...(status === "timed_out" ? { timed_out_at: terminalizedAt } : {}),
      ...(status === "failed" ? {
        failed_at: terminalizedAt,
        error: terminalEvent.error || result.summary,
        error_code: terminalEvent.error_code,
      } : {}),
    };

    activeSessions.delete(sessionId);
    const updated = await store.updateSession(sessionId, patch);
    const release = typeof releaseLockFn === "function"
      ? releaseLockFn
      : (workspaceRoot && current.task_id ? () => releaseLockForTask(workspaceRoot, current.task_id) : null);
    if (release) {
      try { await release(); } catch { /* terminal evidence must survive lock-release diagnostics */ }
    }
    if (typeof onTerminalized === "function") {
      try { await onTerminalized(updated); } catch { /* durable terminal state must survive callback diagnostics */ }
    }
    return updated;
  })().finally(() => {
    if (pendingTerminalizations.get(sessionId) === promise) pendingTerminalizations.delete(sessionId);
  });
  pendingTerminalizations.set(sessionId, promise);
  return promise;
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
  workstreamId = null,
  executionId = null,
  worktreePath = null,
  branch = null,
  baseCommit = null,
  headCommit = null,
  taskContextDigest = null,
  taskContextRevision = null,
  workstreamContextDigest = null,
  workstreamContextRevision = null,
  activeDeltaRevision = 0,
  ptyAdapter = null,
  command = "codex",
  evidenceWaitMs = null,
  requireSuperpowers = true,
  releaseLockFn = null,
  onTerminalized = null,
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
    workstreamId,
    executionId,
    worktreePath: worktreePath || cwd,
    branch,
    baseCommit,
    headCommit,
    taskContextDigest,
    taskContextRevision,
    workstreamContextDigest,
    workstreamContextRevision,
    activeDeltaRevision,
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
  const canonicalGoalDir = join(sessionStoreRoot, ".gptwork", "goals", goal.id);
  const runtimeGoalRoot = join(cwd, ".gptwork", "runtime-goals");
  const runtimeGoalDir = join(runtimeGoalRoot, goal.id);
  await mkdir(runtimeGoalRoot, { recursive: true });
  await rm(runtimeGoalDir, { recursive: true, force: true });
  await symlink(canonicalGoalDir, runtimeGoalDir, "dir");
  const portableGoalDir = `.gptwork/runtime-goals/${goal.id}`;
  const initialPrompt = buildCodexTuiGoalObjective({
    goalId: goal.id,
    taskTitle: task?.title || goal?.title || task?.id,
    goalDir: portableGoalDir,
  });
  let ptySession;
  let earlyTerminalization = null;
  let bootstrapOutput = "";
  try {
    ptySession = await adapter.spawn({
      cwd,
      command,
      args: [initialPrompt],
      onData: (chunk) => {
        const text = String(chunk ?? "");
        bootstrapOutput = (bootstrapOutput + text).slice(-32_000);
        store.appendSessionLog(sessionId, text).catch(() => {});
        // Track heartbeat and meaningful progress
        store.updateSession(sessionId, {
          last_output_at: new Date().toISOString(),
        }).catch(() => {});
        const progress = detectMeaningfulOutput(text);
        if (progress.meaningful) {
          store.updateSession(sessionId, {
            last_meaningful_progress_at: new Date().toISOString(),
          }).catch(() => {});
        }
      },
      onExit: (event) => {
        earlyTerminalization = terminalizeCodexTuiSession({ sessionId, store, event, releaseLockFn, onTerminalized });
        earlyTerminalization.catch(() => {});
      },
    });
  } catch (err) {
    await terminalizeCodexTuiSession({
      sessionId,
      store,
      releaseLockFn,
      onTerminalized,
      event: {
        source: "spawn-error",
        exit_code: null,
        signal: null,
        error: err?.message || String(err),
        error_code: err?.code || null,
      },
    }).catch(() => {});
    throw err;
  }

  if (earlyTerminalization) {
    try { ptySession.stop(); } catch { /* process already reached a terminal path */ }
    return earlyTerminalization;
  }
  activeSessions.set(sessionId, { store, ptySession, releaseLockFn, onTerminalized });

  // Codex versions differ in how an argv prompt is handled: some submit it
  // immediately, while others only place it in the composer. Wait for the first
  // rendered frame, then send exactly one Enter only when the screen does not
  // already show an active run. This avoids both a permanently idle composer and
  // duplicate input on versions that auto-submit.
  const firstOutputAt = await waitForTuiOutput(store, sessionId, 5_000);
  const afterBootstrapWait = await store.readSession(sessionId, { maxChars: 0 });
  if (Number(afterBootstrapWait.terminal_event_count || 0) >= 1) return afterBootstrapWait;
  const alreadyRunning = /(?:\bWorking\b|esc to interrupt|ctrl\+c to interrupt)/iu.test(bootstrapOutput);
  let bootstrapMethod = "argv_prompt_auto_submitted";
  if (!alreadyRunning) {
    ptySession.write("\r");
    await store.appendSessionLog(sessionId, "[bootstrap-input] ENTER\n").catch(() => {});
    bootstrapMethod = "argv_prompt_enter";
  }
  const bootstrapSentAt = new Date().toISOString();

  record = await store.updateSession(sessionId, {
    status: "running",
    pty_pid: ptySession.pid ?? null,
    started_at: bootstrapSentAt,
    bootstrap_sent_at: bootstrapSentAt,
    bootstrap_method: bootstrapMethod,
    first_output_at: firstOutputAt,
    submitted: true,
  });
  return {
    ...record,
    bootstrap_sent_at: bootstrapSentAt,
    first_output_at: firstOutputAt,
    bootstrap_method: bootstrapMethod,
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


export async function sendCodexTuiTaskDelta(sessionId, delta, options = {}) {
  const store = await storeForSession(sessionId, options);
  const session = await store.readSession(sessionId, { maxChars: 0 });
  validateTaskDelta(delta, session);
  const instruction = renderDeltaInstruction(delta);
  const workspaceRoot = session.metadata?.workspace_root || options.workspaceRoot;
  if (!workspaceRoot) throw new Error("workspace root unavailable for task delta");
  const contextStore = createTaskContextStore({ workspaceRoot });
  await contextStore.appendDelta(`.gptwork/goals/${session.goal_id}`, delta);
  await sendCodexTuiSessionInput(sessionId, `${instruction}
`, options);
  return store.updateSession(sessionId, {
    active_delta_revision: delta.revision,
    last_delta_kind: delta.kind,
    last_delta_at: new Date().toISOString(),
  });
}

export async function stopCodexTuiSession(sessionId, { reason = "stopped", workspaceRoot = null, candidateWorkspaceRoots = [], releaseLockFn = null } = {}) {
  const store = await storeForSession(sessionId, { workspaceRoot, candidateWorkspaceRoots });
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
  pendingTerminalizations.clear();
}
