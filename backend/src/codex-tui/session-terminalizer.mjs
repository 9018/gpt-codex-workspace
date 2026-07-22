/**
 * session-terminalizer.mjs — TUI session terminalization (result collection).
 *
 * Handles reading terminal results, writing result.json, and the
 * terminalize lifecycle for a Codex TUI session.
 *
 * @module session-terminalizer
 */

import { join } from "node:path";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { codexTuiGoalArtifactCandidates, firstMatchingJsonArtifact } from "./result-locator.mjs";
import { randomUUID } from "node:crypto";
import { releaseLockForTask } from "../repo-lock.mjs";
import { cleanupIsolatedWorktreeProcesses } from "./session-process-cleanup.mjs";
import { cleanupTaskOwnedCodexSessions, pruneBoundNativeSession, updateBoundCodexSessionStatus } from "../codex-session/codex-session-lifecycle-manager.mjs";
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
  if (!result || typeof result !== "object") return null;
  const candidate = result.status === "finished"
    ? { ...result, status: "completed" }
    : result;
  if (isContractValidTerminalResult(candidate)) return candidate;
  if (!TERMINAL_RESULT_STATUSES.has(candidate.status)) return null;
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.changed_files)) return null;
  if (typeof candidate.verification?.passed !== "boolean") return null;
  const commands = Array.isArray(candidate.verification.commands)
    ? candidate.verification.commands
    : (Array.isArray(candidate.verification.steps) ? candidate.verification.steps : []);
  return {
    ...candidate,
    tests: Object.hasOwn(candidate, "tests") ? candidate.tests : "none",
    commit: Object.hasOwn(candidate, "commit") ? candidate.commit : "none",
    remote_head: Object.hasOwn(candidate, "remote_head") ? candidate.remote_head : "none",
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
    followups: Array.isArray(candidate.followups) ? candidate.followups : [],
    verification: { ...candidate.verification, commands },
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


async function fileExists(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function listMustHaveFiles(contract = null) {
  if (!contract || typeof contract !== "object") return [];
  const values = [
    ...(Array.isArray(contract.must_have_files) ? contract.must_have_files : []),
    ...(Array.isArray(contract.requirements?.must_have_files) ? contract.requirements.must_have_files : []),
    ...(Array.isArray(contract.acceptance?.must_have_files) ? contract.acceptance.must_have_files : []),
  ];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

async function loadAcceptanceContract({ workspaceRoot, cwd, goalId }) {
  const candidates = codexTuiGoalArtifactCandidates({
    workspaceRoot,
    cwd,
    goalId,
    filename: "acceptance.contract.json",
  });
  for (const path of candidates) {
    if (!await fileExists(path)) continue;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      // keep looking
    }
  }
  return null;
}

async function resolveExistingPaths({ workspaceRoot, cwd, relativePaths = [] }) {
  const found = [];
  for (const relative of relativePaths) {
    const rel = String(relative || "").replace(/^\.?\//, "");
    if (!rel) continue;
    const candidates = [
      workspaceRoot ? join(workspaceRoot, rel) : null,
      cwd ? join(cwd, rel) : null,
      workspaceRoot ? join(workspaceRoot, "gpt-codex-workspace", rel) : null,
    ].filter(Boolean);
    for (const absolute of candidates) {
      if (await fileExists(absolute)) {
        found.push(rel);
        break;
      }
    }
  }
  return found;
}

function normalizePartialCandidate(value) {
  if (!value || typeof value !== "object") return null;
  const statusRaw = String(value.status || "").toLowerCase();
  const phaseRaw = String(value.phase || "").toLowerCase();
  const finishedLike = ["completed", "finished", "done", "passed", "success"].includes(statusRaw)
    || ["finished", "done", "completed", "verified"].includes(phaseRaw);
  if (!finishedLike && value.verification?.passed !== true) return null;
  return normalizeTerminalResultCandidate({
    status: "completed",
    summary: value.summary || "Reconstructed completed result from durable partial TUI evidence.",
    changed_files: Array.isArray(value.changed_files) ? value.changed_files : [],
    tests: Object.hasOwn(value, "tests") ? value.tests : (value.known_command_results || "none"),
    commit: Object.hasOwn(value, "commit") ? value.commit : "none",
    remote_head: Object.hasOwn(value, "remote_head") ? value.remote_head : "none",
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    followups: Array.isArray(value.followups) ? value.followups : [],
    verification: value.verification && typeof value.verification === "object"
      ? value.verification
      : { commands: [], passed: true },
    reconstructed: true,
    evidence_source: "result.partial.json",
  });
}

/**
 * Prefer durable completion evidence over fail-closed PTY exit noise.
 * Canary-class marker tasks often leave partial + marker files without a
 * final rename to result.json before the session exits.
 */
export async function recoverTerminalResultFromEvidence({
  workspaceRoot,
  cwd = null,
  goalId,
  event = {},
} = {}) {
  if (!workspaceRoot || !goalId) return null;

  const resultCandidates = codexTuiGoalArtifactCandidates({
    workspaceRoot,
    cwd,
    goalId,
    filename: "result.json",
  });
  const existing = await firstMatchingJsonArtifact(resultCandidates, (value) => Boolean(normalizeTerminalResultCandidate(value)));
  const existingResult = normalizeTerminalResultCandidate(existing?.value) || null;
  if (existingResult?.status === "completed" && existingResult.verification?.passed === true) {
    return existingResult;
  }

  const partialCandidates = codexTuiGoalArtifactCandidates({
    workspaceRoot,
    cwd,
    goalId,
    filename: "result.partial.json",
  });
  // Prefer finished partials, but keep any partial as supporting evidence.
  const finishedPartial = await firstMatchingJsonArtifact(partialCandidates, (value) => Boolean(normalizePartialCandidate(value)));
  const anyPartial = finishedPartial || await firstMatchingJsonArtifact(partialCandidates, (value) => value && typeof value === "object");
  const fromPartial = normalizePartialCandidate(finishedPartial?.value || anyPartial?.value) || null;
  const partialValue = finishedPartial?.value || anyPartial?.value || null;

  const contract = await loadAcceptanceContract({ workspaceRoot, cwd, goalId });
  const mustHave = listMustHaveFiles(contract);
  const partialChanged = Array.isArray(partialValue?.changed_files) ? partialValue.changed_files : [];
  const candidateMarkers = [...new Set([
    ...mustHave,
    ...partialChanged.filter((item) => String(item || "").includes(".gptwork/tmp/")),
  ])];
  const presentMustHave = await resolveExistingPaths({ workspaceRoot, cwd, relativePaths: candidateMarkers });
  const markersSatisfied = (
    (mustHave.length > 0 && presentMustHave.filter((item) => mustHave.includes(item)).length === mustHave.length)
    || presentMustHave.some((item) => String(item).includes(".gptwork/tmp/"))
  );

  // Also scan common tmp roots for canary marker files named in partial summary.
  if (!markersSatisfied && partialValue) {
    const summaryText = `${partialValue.summary || ""} ${JSON.stringify(partialValue)}`;
    const matches = [...summaryText.matchAll(/tui-loop-canary[\w-]+/gi)].map((m) => m[0]);
    const guessed = matches.flatMap((name) => [
      `.gptwork/tmp/${name}.txt`,
      `.gptwork/tmp/${name}`,
    ]);
    const found = await resolveExistingPaths({ workspaceRoot, cwd, relativePaths: guessed });
    if (found.length) {
      presentMustHave.push(...found.filter((item) => !presentMustHave.includes(item)));
    }
  }
  const markersPresent = presentMustHave.length > 0;

  const resultMdCandidates = codexTuiGoalArtifactCandidates({
    workspaceRoot,
    cwd,
    goalId,
    filename: "result.md",
  });
  let resultMdPresent = false;
  for (const path of resultMdCandidates) {
    if (await fileExists(path)) {
      resultMdPresent = true;
      break;
    }
  }

  const partialPresent = Boolean(partialValue);
  if (!fromPartial && !markersPresent && !resultMdPresent && !partialPresent) {
    return existingResult;
  }

  // Only promote when partial is finished-like, or verification already passed.
  // A started/running partial + marker is progress, not completion.
  if (
    fromPartial?.verification?.passed === true
    || Boolean(fromPartial) // normalizePartialCandidate already filters finished-like
    || (markersPresent && resultMdPresent && Boolean(fromPartial))
  ) {
    const summary = fromPartial?.summary
      || partialValue?.summary
      || (markersPresent
        ? `Recovered completed TUI evidence from marker files: ${presentMustHave.join(", ")}`
        : "Recovered completed TUI evidence from partial/result.md artifacts.");
    return normalizeTerminalResultCandidate({
      status: "completed",
      summary,
      changed_files: fromPartial?.changed_files || partialChanged || presentMustHave,
      tests: fromPartial?.tests || partialValue?.tests || (markersPresent ? ["marker_file_verified"] : "none"),
      commit: fromPartial?.commit || partialValue?.commit || "none",
      remote_head: fromPartial?.remote_head || partialValue?.remote_head || "none",
      warnings: fromPartial?.warnings || [],
      followups: fromPartial?.followups || [],
      verification: {
        passed: true,
        commands: Array.isArray(fromPartial?.verification?.commands) && fromPartial.verification.commands.length
          ? fromPartial.verification.commands
          : (markersPresent
            ? presentMustHave.map((path) => ({ cmd: `test -f ${path}`, exit_code: 0, passed: true }))
            : [{ cmd: "tui_partial_result_recovery", exit_code: 0, passed: true }]),
      },
      reconstructed: true,
      evidence_source: markersPresent ? "marker_files" : (fromPartial ? "result.partial.json" : (partialPresent ? "result.partial.json" : "result.md")),
      recovered_from_terminal_event: event || null,
      marker_files: presentMustHave,
      noop: true,
      kind: "noop",
      operation_kind: "noop",
      integration_not_required: true,
      repo_mutated: false,
    });
  }

  return fromPartial || existingResult;
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
    if (!result || result.status !== "completed" || result.verification?.passed !== true) {
      const recovered = await recoverTerminalResultFromEvidence({
        workspaceRoot,
        cwd: current.cwd,
        goalId: current.goal_id,
        event: terminalEvent,
      });
      if (recovered) result = recovered;
    }
    if (!result) {
      result = failClosedResult(terminalEvent);
      await writeJsonAtomic(resultPath, result);
    } else if (result.reconstructed || !existsSync(resultPath)) {
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
    if (current.task_id) {
      await cleanupTaskOwnedCodexSessions({
        taskId: current.task_id,
        workspaceRoot,
        projectRoot: current.metadata?.project_root || null,
        nativeSessionsRoot: current.metadata?.native_sessions_root || null,
        startedAt: current.started_at || current.created_at || null,
        endedAt: terminalizedAt,
        preserveControlRecords: true,
      }).catch(() => null);
    } else {
      await pruneBoundNativeSession({
        controlSessionId: sessionId,
        workspaceRoot,
        projectRoot: current.metadata?.project_root || null,
        nativeSessionsRoot: current.metadata?.native_sessions_root || null,
      }).catch(() => null);
    }
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
