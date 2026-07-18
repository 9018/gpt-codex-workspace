/**
 * session-bootstrap.mjs — TUI session bootstrap and lifecycle management.
 *
 * Contains the core bootstrapping logic for starting a Codex TUI session
 * including PTY spawning, argv prompt submission, autopilot integration,
 * and native session binding.
 *
 * @module session-bootstrap
 */

import { join } from "node:path";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createCodexTuiSessionStore } from "../codex-tui-session-store.mjs";
import { createCodexTuiPtyAdapter } from "../codex-tui-pty-adapter.mjs";
import { buildCodexTuiGoalObjective } from "../codex-tui-goal-prompt.mjs";
import { detectMeaningfulOutput } from "../codex-tui-progress-utils.mjs";
import { createTaskContextStore } from "../context-contract/task-context-store.mjs";
import { buildCodexProcessEnvironment } from "../path-context/codex-process-environment.mjs";
import { snapshotNativeSessions } from "../codex-session/codex-session-inventory.mjs";
import { resolveNativeSessionBinding } from "../codex-session/codex-session-resolver.mjs";
import { createCodexSessionManifestStore } from "../codex-session/codex-session-manifest-store.mjs";
import { createTuiAutopilotController } from "../tui-autopilot/tui-autopilot-controller.mjs";
import { releaseLockForTask } from "../repo-lock.mjs";
import {
  activeSessions, sessionStores,
  pendingSessionStarts, pendingTerminalizations,
} from "./active-session-registry.mjs";
import { waitForTuiOutput } from "./session-recovery.mjs";
import { terminalizeCodexTuiSession } from "./session-terminalizer.mjs";
import { uniqueStrings, candidateWorkspaceRoots } from "./session-process-cleanup.mjs";

/**
 * Build a deterministic session ID from a task and goal.
 * @param {object} [task]
 * @param {object} [goal]
 * @returns {string}
 */
export function sessionIdFor(task, goal) {
  const taskId = String(task?.id || "task").replace(/[^A-Za-z0-9_-]/g, "_");
  const goalId = String(goal?.id || "goal").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${goalId}_${taskId}`;
}

/**
 * Find an existing session store for a given session ID, probing
 * candidate workspace roots.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @returns {Promise<object>} The session store
 */
export async function findStoreForSession(sessionId, options = {}) {
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

/**
 * Core implementation: bootstrap a new Codex TUI session.
 *
 * This is the main bootstrapping loop that:
 * 1. Creates/validates the session record
 * 2. Sets up runtime symlinks
 * 3. Spawns the PTY
 * 4. Handles argv prompt submission
 * 5. Binds native session
 * 6. Activates autopilot
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function startCodexTuiGoalSessionImpl({
  task,
  goal,
  cwd,
  workspaceRoot = null,
  candidateWorkspaceRoots: candidateRoots = [],
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
  pathContext = null,
  requireSuperpowers = true,
  tuiAutopilotEnabled = true,
  tuiAutopilotMaxActions = 100,
  tuiAutopilotMaxRepairs = 3,
  tuiFrameStableMs = 500,
  tuiNoProgressSeconds = 120,
  tuiClassifierEnabled = true,
  resumeNativeSessionId = null,
  releaseLockFn = null,
  onTerminalized = null,
} = {}) {
  if (!cwd) throw new Error("cwd is required");
  if (!goal?.id) throw new Error("goal.id is required");

  const sessionStoreRoot = workspaceRoot || candidateRoots[0] || cwd;
  const deprecatedCwdSessionRoot = !workspaceRoot && candidateRoots.length === 0;
  const store = createCodexTuiSessionStore({ workspaceRoot: sessionStoreRoot });
  const adapter = ptyAdapter || createCodexTuiPtyAdapter({ command });
  const sessionId = sessionIdFor(task, goal);
  sessionStores.set(sessionId, store);

  if (pathContext?.codexHome) {
    await mkdir(pathContext.codexHome, { recursive: true });
    if (pathContext.nativeSessionsRoot) await mkdir(pathContext.nativeSessionsRoot, { recursive: true });
  }

  const nativeSessionsBefore = pathContext
    ? await snapshotNativeSessions(pathContext.nativeSessionsRoot).catch(() => [])
    : [];

  const processEnv = pathContext
    ? buildCodexProcessEnvironment(pathContext, {
      taskId: task?.id,
      goalId: goal?.id,
      executionId,
      controlSessionId: sessionId,
    })
    : undefined;

  // Check for existing session
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
      tui_autopilot_enabled: tuiAutopilotEnabled !== false,
      tui_autopilot_max_actions: Number(tuiAutopilotMaxActions || 100),
      tui_autopilot_max_repairs: Number(tuiAutopilotMaxRepairs || 3),
      tui_frame_stable_ms: Number(tuiFrameStableMs || 500),
      tui_no_progress_seconds: Number(tuiNoProgressSeconds || 120),
      tui_classifier_enabled: tuiClassifierEnabled !== false,
      resume_native_session_id: resumeNativeSessionId || null,
      codex_home: pathContext?.codexHome || null,
      deprecation_warnings: deprecatedCwdSessionRoot ? ["startCodexTuiGoalSession without workspaceRoot stores sessions under cwd; pass workspaceRoot explicitly"] : [],
    },
  });

  // Runtime goal directory symlink
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
  const pendingAutopilotInputs = [];
  const writeAutopilotInput = async (input) => {
    const text = String(input ?? "");
    if (ptySession) ptySession.write(text);
    else pendingAutopilotInputs.push(text);
    await store.appendSessionLog(sessionId, `[autopilot-input] ${text}`);
  };
  const autopilot = tuiAutopilotEnabled === false ? null : createTuiAutopilotController({
    sessionId,
    active: false,
    allowedRoots: [cwd],
    maxActions: Number(tuiAutopilotMaxActions || 100),
    maxRepairs: Number(tuiAutopilotMaxRepairs || 3),
    noProgressMs: Number(tuiNoProgressSeconds || 120) * 1_000,
    writeInput: writeAutopilotInput,
    interrupt: () => writeAutopilotInput("\x03"),
    resume: () => writeAutopilotInput("/resume\r"),
    persist: (patch) => store.updateSession(sessionId, patch),
  });

  try {
    ptySession = await adapter.spawn({
      cwd,
      env: processEnv,
      command,
      args: resumeNativeSessionId
        ? ["resume", String(resumeNativeSessionId)]
        : [],
      onData: (chunk) => {
        const text = String(chunk ?? "");
        bootstrapOutput = (bootstrapOutput + text).slice(-32_000);
        store.appendSessionLog(sessionId, text).catch(() => {});
        store.updateSession(sessionId, { last_output_at: new Date().toISOString() }).catch(() => {});
        const progress = detectMeaningfulOutput(text);
        if (progress.meaningful) {
          store.updateSession(sessionId, {
            last_meaningful_progress_at: new Date().toISOString(),
          }).catch(() => {});
        }
        autopilot?.ingest(text).catch((err) => {
          store.updateSession(sessionId, {
            autopilot_error: String(err?.message || err),
            autopilot_error_at: new Date().toISOString(),
          }).catch(() => {});
        });
      },
      onExit: (event) => {
        earlyTerminalization = terminalizeCodexTuiSession({ sessionId, store, event, releaseLockFn, onTerminalized });
        earlyTerminalization.catch(() => {});
      },
    });
  } catch (err) {
    await terminalizeCodexTuiSession({
      sessionId, store, releaseLockFn, onTerminalized,
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
    try { ptySession.stop(); } catch { /* already terminal */ }
    return earlyTerminalization;
  }

  for (const input of pendingAutopilotInputs.splice(0)) ptySession.write(input);
  activeSessions.set(sessionId, { store, ptySession, autopilot, releaseLockFn, onTerminalized });

  // Wait for the interactive TUI, then dispatch the real slash command through PTY.
  const firstOutputAt = await waitForTuiOutput(store, sessionId, 5_000);
  const afterBootstrapWait = await store.readSession(sessionId, { maxChars: 0 });
  if (Number(afterBootstrapWait.terminal_event_count || 0) >= 1) return afterBootstrapWait;

  const bootstrapSentAt = new Date().toISOString();
  const goalCommand = `/goal ${initialPrompt}`;
  ptySession.write(`${goalCommand}\r`);
  await store.appendSessionLog(sessionId, `[bootstrap-input] /goal dispatched\n`).catch(() => {});
  const bootstrapMethod = "pty_goal_slash_command";

  // Fail closed unless the TUI emits post-dispatch activity.
  const outputBeforeDispatch = bootstrapOutput;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const ackReceived = bootstrapOutput !== outputBeforeDispatch
    || /(?:\bWorking\b|esc to interrupt|ctrl\+c to interrupt|goal)/iu.test(bootstrapOutput);
  const goalDispatchEvidence = {
    command_type: "slash_command",
    command: "/goal",
    dispatched_at: bootstrapSentAt,
    ack_received: ackReceived,
    ack_status: ackReceived ? "active" : "no_ack",
    ack_at: ackReceived ? new Date().toISOString() : null,
    method: bootstrapMethod,
    error: ackReceived ? null : "TUI did not acknowledge /goal command",
  };
  autopilot?.activate();

  const nativeSessionsAfter = pathContext
    ? await snapshotNativeSessions(pathContext.nativeSessionsRoot).catch(() => [])
    : [];
  const nativeBinding = pathContext
    ? resolveNativeSessionBinding({
      output: bootstrapOutput,
      before: nativeSessionsBefore,
      after: nativeSessionsAfter,
      cwd,
      pid: ptySession.pid ?? null,
    })
    : null;

  record = await store.updateSession(sessionId, {
    status: "running",
    autonomous: tuiAutopilotEnabled !== false,
    pty_pid: ptySession.pid ?? null,
    started_at: bootstrapSentAt,
    bootstrap_sent_at: bootstrapSentAt,
    bootstrap_method: bootstrapMethod,
    first_output_at: firstOutputAt,
    submitted: true,
    goal_mode_active: ackReceived,
    goal_dispatch_evidence: goalDispatchEvidence,
    native_session_id: nativeBinding?.nativeSessionId || null,
    native_session_binding_source: nativeBinding?.source || null,
    native_session_binding_reason: nativeBinding?.reason || null,
    resume_native_session_id: resumeNativeSessionId || null,
  });

  if (pathContext) {
    try {
      await createCodexSessionManifestStore({ projectRoot: pathContext.projectRoot }).write({
        control_session_id: sessionId,
        native_session_id: nativeBinding?.nativeSessionId || null,
        native_session_binding_source: nativeBinding?.source || null,
        native_session_binding_reason: nativeBinding?.reason || null,
        task_id: task?.id || null,
        goal_id: goal?.id || null,
        execution_id: executionId || null,
        cwd,
        codex_home: pathContext.codexHome,
        provider: "codex_tui_goal",
        status: "running",
      });
    } catch {
      // Session attribution must not make live TUI unavailable
    }
  }

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
