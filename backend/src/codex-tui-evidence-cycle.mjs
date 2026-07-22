import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { collectCodexTuiCompletion } from "./codex-tui-completion-collector.mjs";
import { recoverTerminalResultFromEvidence } from "./codex-tui/session-terminalizer.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_SESSION_STATUSES = new Set([
  "completed",
  "failed",
  "timed_out",
  "stopped",
  "detached",
  "cancelled",
  "canceled",
]);

async function waitForResult({
  resultJsonPath,
  now,
  sleepFn,
  maxWaitMs,
  pollMs,
  sessionId = null,
  getSessionStatusFn = null,
}) {
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    if (existsSync(resultJsonPath)) return { observed: true, session_status: null };
    let sessionStatus = null;
    if (typeof getSessionStatusFn === "function" && sessionId) {
      try {
        const status = await getSessionStatusFn(sessionId);
        sessionStatus = status?.status || null;
        // Session already terminal and still no result.json: stop early only when
        // there is also no partial progress file being written. Caller decides.
        if (sessionStatus && TERMINAL_SESSION_STATUSES.has(sessionStatus) && existsSync(resultJsonPath)) {
          return { observed: true, session_status: sessionStatus };
        }
      } catch {
        // status probes are best-effort
      }
    }
    await sleepFn(pollMs);
  }
  let sessionStatus = null;
  if (typeof getSessionStatusFn === "function" && sessionId) {
    try {
      const status = await getSessionStatusFn(sessionId);
      sessionStatus = status?.status || null;
    } catch {}
  }
  return { observed: existsSync(resultJsonPath), session_status: sessionStatus };
}

async function writeJsonAtomic(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Run the TUI evidence collection cycle.
 *
 * Policy:
 * - result.json is durable completion evidence.
 * - result.partial.json is progress only.
 * - If only partial evidence exists and the session is still active, keep waiting
 *   (return continue_waiting) instead of parking as human review.
 * - If evidence is still insufficient after wait and session is terminal/absent,
 *   route to human review without auto-repair/retry.
 */
export async function runCodexTuiEvidenceCycle({
  task,
  goal,
  sessionId,
  workspaceRoot,
  collectFn = collectCodexTuiCompletion,
  getSessionStatusFn = null,
  now = Date.now,
  sleepFn = sleep,
  // Retained for backwards-compatible callers. Intentionally never invoked.
  sendInputFn = null,
  maxWaitMs = 120_000,
  pollMs = 5_000,
  postTerminalGraceMs = 30_000,
} = {}) {
  if (!goal?.id) throw new Error("goal.id is required");
  if (!sessionId) throw new Error("sessionId is required");

  const goalDir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  const resultJsonPath = join(goalDir, "result.json");
  const partialResultJsonPath = join(goalDir, "result.partial.json");

  let wait = await waitForResult({
    resultJsonPath,
    now,
    sleepFn,
    maxWaitMs,
    pollMs,
    sessionId,
    getSessionStatusFn,
  });

  // Late writers: if partial exists and session is still active, extend wait once.
  const partialDuringWait = existsSync(partialResultJsonPath);
  const sessionStillActive = wait.session_status
    ? !TERMINAL_SESSION_STATUSES.has(wait.session_status)
    : false;
  if (!wait.observed && partialDuringWait && sessionStillActive && postTerminalGraceMs > 0) {
    wait = await waitForResult({
      resultJsonPath,
      now,
      sleepFn,
      maxWaitMs: postTerminalGraceMs,
      pollMs,
      sessionId,
      getSessionStatusFn,
    });
  }

  // One more grace after session becomes terminal but result.json lags briefly.
  if (!wait.observed && wait.session_status && TERMINAL_SESSION_STATUSES.has(wait.session_status) && postTerminalGraceMs > 0) {
    const graceDeadline = now() + Math.min(postTerminalGraceMs, 30_000);
    while (now() < graceDeadline) {
      if (existsSync(resultJsonPath)) {
        wait = { observed: true, session_status: wait.session_status };
        break;
      }
      await sleepFn(Math.min(pollMs, 1000));
    }
    if (!wait.observed) wait = { observed: existsSync(resultJsonPath), session_status: wait.session_status };
  }

  const resultJsonObserved = wait.observed || existsSync(resultJsonPath);
  const partialResultObserved = existsSync(partialResultJsonPath);
  let collected = await collectFn({ sessionId, workspaceRoot });
  // Last-chance recovery for canary-class marker/partial completion before parking review.
  if (!collected?.result_json || collected?.result_json?.status !== "completed" || collected?.result_json?.verification?.passed !== true) {
    try {
      const recovered = await recoverTerminalResultFromEvidence({
        workspaceRoot,
        cwd: collected?.cwd || null,
        goalId: goal.id,
      });
      if (recovered?.status === "completed" && recovered.verification?.passed === true) {
        await writeJsonAtomic(resultJsonPath, recovered);
        collected = {
          ...(collected || {}),
          result_json: recovered,
          result_json_present: true,
          result_json_valid: true,
          result_json_path: resultJsonPath,
          ready_for_review: true,
          reconstructed_result: recovered,
          findings: [],
        };
      }
    } catch {
      // best-effort recovery only
    }
  }
  const reconstructed = collected?.reconstructed_result || null;
  const resultJsonUsable = Boolean(collected?.result_json && collected?.result_json_valid !== false);
  const closureProvable = collected?.ready_for_review === true
    || (collected?.result_json?.status === "completed" && collected?.result_json?.verification?.passed === true);

  let latestSessionStatus = wait.session_status;
  if (typeof getSessionStatusFn === "function") {
    try {
      const status = await getSessionStatusFn(sessionId);
      latestSessionStatus = status?.status || latestSessionStatus;
    } catch {}
  }
  const sessionActive = latestSessionStatus
    ? !TERMINAL_SESSION_STATUSES.has(latestSessionStatus)
    : false;

  if (!resultJsonUsable) {
    // Active session + only partial progress => keep observing, do not park review yet.
    if (!closureProvable && partialResultObserved && sessionActive) {
      return {
        evidence_ready: false,
        continue_waiting: true,
        reason: "tui_result_partial_session_active",
        status: "running",
        requires_human_review: false,
        retry_original_task: false,
        create_followup: false,
        create_repair_task: false,
        repair_attempted: false,
        session_id: sessionId,
        goal_id: goal.id,
        task_id: task?.id || null,
        expected_result_json: resultJsonPath,
        observed_partial_result_json: partialResultJsonPath,
        expected_result_md: join(goalDir, "result.md"),
        session_status: latestSessionStatus,
        finding: {
          severity: "info",
          code: "tui_result_partial_session_active",
          message: "Only result.partial.json is present while the TUI session is still active; continue waiting for durable result.json.",
        },
        reconstructed_result: reconstructed,
        collected,
      };
    }

    if (closureProvable && reconstructed) {
      await writeJsonAtomic(resultJsonPath, reconstructed);
    }
    const code = resultJsonObserved
      ? "tui_result_json_invalid_reconstructed"
      : partialResultObserved
        ? "tui_result_partial_only_reconstructed"
        : "tui_result_json_missing_reconstructed";
    return {
      evidence_ready: closureProvable,
      continue_waiting: false,
      reason: code,
      status: closureProvable ? "ready" : "waiting_for_review",
      requires_human_review: !closureProvable,
      retry_original_task: false,
      create_followup: false,
      create_repair_task: false,
      repair_attempted: false,
      session_id: sessionId,
      goal_id: goal.id,
      task_id: task?.id || null,
      expected_result_json: resultJsonPath,
      observed_partial_result_json: partialResultObserved ? partialResultJsonPath : null,
      expected_result_md: join(goalDir, "result.md"),
      session_status: latestSessionStatus,
      finding: {
        severity: closureProvable ? "warning" : "blocker",
        code,
        message: closureProvable
          ? "The final result.json was unavailable, but existing TUI session, Git/worktree, command and result.md evidence was sufficient to reconstruct reviewable structured evidence."
          : partialResultObserved
            ? "Only result.partial.json was present after the session finished. It is progress evidence, not completion evidence; route to human review without retrying or creating repair/follow-up work."
            : "result.json was unavailable and existing evidence could not prove closure; route to human review without retrying or creating repair/follow-up work.",
      },
      reconstructed_result: reconstructed,
      collected,
    };
  }

  return {
    evidence_ready: true,
    continue_waiting: false,
    reason: "tui_result_json_collected",
    status: "ready",
    repair_attempted: false,
    retry_original_task: false,
    create_followup: false,
    create_repair_task: false,
    session_id: sessionId,
    goal_id: goal.id,
    task_id: task?.id || null,
    observed_partial_result_json: partialResultObserved ? partialResultJsonPath : null,
    session_status: latestSessionStatus,
    collected,
  };
}
