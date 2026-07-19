/**
 * session-terminalizer.mjs — TUI session terminalization (result collection).
 *
 * Handles reading terminal results, writing result.json, and the
 * terminalize lifecycle for a Codex TUI session.
 *
 * @module session-terminalizer
 */

import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { codexTuiGoalArtifactCandidates, firstMatchingJsonArtifact } from "./result-locator.mjs";
import { randomUUID } from "node:crypto";
import { releaseLockForTask } from "../repo-lock.mjs";
import { cleanupIsolatedWorktreeProcesses } from "./session-process-cleanup.mjs";
import { pruneBoundNativeSession, updateBoundCodexSessionStatus } from "../codex-session/codex-session-lifecycle-manager.mjs";
import {
  activeSessions,
  pendingTerminalizations,
} from "./active-session-registry.mjs";

/** Terminal result statuses recognized by the contract. */
export const TERMINAL_RESULT_STATUSES = new Set(["completed", "failed", "timed_out", "stopped", "cancelled", "detached"]);

/**
 * Normalize a PTY terminal event to a canonical shape.
 * @param {object} [event={}]
 * @returns {{ source: string, exit_code: number|null, signal: string|null, error: string|null, error_code: string|null }}
 */
export function normalizeTerminalEvent(event = {}) {
  return {
    source: String(event.source || "pty-exit"),
    exit_code: Number.isInteger(event.exit_code) ? event.exit_code : null,
    signal: event.signal ?? null,
    error: event.error ? String(event.error) : null,
    error_code: event.error_code ? String(event.error_code) : null,
  };
}

/**
 * Validate a terminal result against the result.json contract.
 * @param {object} result
 * @returns {boolean}
 */
export function isContractValidTerminalResult(result) {
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

/**
 * Read a terminal result file.
 * @param {string} resultPath
 * @returns {Promise<object|null>}
 */

export function normalizeTerminalResultCandidate(result) {
  if (isContractValidTerminalResult(result)) return result;
  if (!result || typeof result !== "object") return null;
  if (!TERMINAL_RESULT_STATUSES.has(result.status)) return null;
  if (typeof result.summary !== "string" || !Array.isArray(result.changed_files)) return null;
  if (typeof result.verification?.passed !== "boolean") return null;
  const commands = Array.isArray(result.verification.commands)
    ? result.verification.commands
    : (Array.isArray(result.verification.steps) ? result.verification.steps : []);
  return {
    ...result,
    tests: Object.hasOwn(result, "tests") ? result.tests : "none",
    commit: Object.hasOwn(result, "commit") ? result.commit : "none",
    remote_head: Object.hasOwn(result, "remote_head") ? result.remote_head : "none",
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    followups: Array.isArray(result.followups) ? result.followups : [],
    verification: { ...result.verification, commands },
  };
}

export async function readTerminalResult(resultPath) {
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8"));
    return normalizeTerminalResultCandidate(parsed);
  } catch {
    return null;
  }
}

/**
 * Read a terminal result with retry until the deadline.
 * @param {string} resultPath
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function readTerminalResultWithRetry(resultPath, {
  waitMs = 0,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let result = await readTerminalResult(resultPath);
  while (!result && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleepFn(Math.min(50, Math.max(1, remaining)));
    result = await readTerminalResult(resultPath);
  }
  return result;
}

/**
 * Atomically write a JSON value to a file path.
 * @param {string} path
 * @param {object} value
 */
export async function writeJsonAtomic(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * Build a fail-closed result object when no valid result.json exists.
 * @param {object} event
 * @returns {object}
 */
export function failClosedResult(event) {
  if (event.source === "native-detach") {
    return {
      status: "detached",
      summary: "Native Codex session control channel detached; Goal lifecycle is unchanged.",
      changed_files: [],
      tests: "none",
      commit: "none",
      remote_head: "none",
      warnings: [],
      followups: [],
      verification: { commands: [], passed: true },
      terminal_event: event,
    };
  }
  const timedOut = event.source === "evidence_timeout" || event.source === "timeout";
  const explicitlyStopped = event.source === "explicit-stop" || event.error === "manual_stop";
  const detail = event.error
    || (event.exit_code !== null ? `PTY exited with code ${event.exit_code}` : null)
    || (event.signal ? `PTY exited from signal ${event.signal}` : null)
    || `PTY terminal event: ${event.source}`;
  return {
    status: explicitlyStopped ? "stopped" : (timedOut ? "timed_out" : "failed"),
    summary: explicitlyStopped
      ? `Codex TUI was stopped by the supervisor: ${detail}`
      : `Codex TUI terminated without contract-valid result evidence: ${detail}`,
    changed_files: [],
    tests: "none",
    commit: "none",
    remote_head: "none",
    warnings: [],
    followups: [],
    verification: { commands: [], passed: explicitlyStopped },
    terminal_event: event,
  };
}

/**
 * Process a terminal event for a session: read result, write result.json,
 * clean up worktree processes, release locks, and update the session record.
 *
 * Idempotent: if the session has already been terminalized, returns the
 * cached result.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {object} options.store
 * @param {object} [options.event]
 * @param {Function|null} [options.releaseLockFn]
 * @param {Function|null} [options.onTerminalized]
 * @returns {Promise<object>} Updated session record
 */
export async function terminalizeCodexTuiSession({ sessionId, store, event = {}, releaseLockFn = null, onTerminalized = null }) {
  const pending = pendingTerminalizations.get(sessionId);
  if (pending) return pending;

  const promise = (async () => {
    const current = await store.readSession(sessionId, { maxChars: 0 });
    if (Number(current.terminal_event_count || 0) >= 1) return current;

    const terminalEvent = normalizeTerminalEvent(event);
    const workspaceRoot = current.metadata?.session_store_root || current.metadata?.workspace_root;
    const resultPath = join(workspaceRoot, ".gptwork", "goals", current.goal_id, "result.json");
    const resultCandidates = codexTuiGoalArtifactCandidates({
      workspaceRoot,
      cwd: current.cwd,
      goalId: current.goal_id,
      filename: "result.json",
    });
    const configuredWaitMs = Number(current.metadata?.evidence_wait_ms);
    const evidenceWaitMs = terminalEvent.exit_code === 0
      ? (Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0 ? configuredWaitMs : 1_500)
      : 0;
    let located = await firstMatchingJsonArtifact(resultCandidates, (value) => Boolean(normalizeTerminalResultCandidate(value)));
    let result = normalizeTerminalResultCandidate(located?.value) || null;
    if (!result && evidenceWaitMs > 0) {
      const deadline = Date.now() + evidenceWaitMs;
      while (!result && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        located = await firstMatchingJsonArtifact(resultCandidates, (value) => Boolean(normalizeTerminalResultCandidate(value)));
        result = normalizeTerminalResultCandidate(located?.value) || null;
      }
    }
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
      ...(["stopped", "cancelled"].includes(status) ? { stopped_at: terminalizedAt } : {}),
      ...(status === "failed" ? {
        failed_at: terminalizedAt,
        error: terminalEvent.error || result.summary,
        error_code: terminalEvent.error_code,
      } : {}),
    };

    activeSessions.delete(sessionId);
    const updated = await store.updateSession(sessionId, patch);
    await updateBoundCodexSessionStatus({
      projectRoot: current.metadata?.project_root || null,
      controlSessionId: sessionId,
      status,
      terminalizedAt,
      patch: { terminal_event: terminalEvent, result_status: status },
    }).catch(() => null);
    await pruneBoundNativeSession({
      controlSessionId: sessionId,
      workspaceRoot,
      projectRoot: current.metadata?.project_root || null,
      nativeSessionsRoot: current.metadata?.native_sessions_root || null,
    }).catch(() => null);
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
