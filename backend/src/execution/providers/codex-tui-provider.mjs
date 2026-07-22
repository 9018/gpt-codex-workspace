import {
  getCodexTuiSessionStatus,
  sendCodexTuiSessionInput,
  startCodexTuiGoalSession,
  stopCodexTuiSession,
} from "../../codex-tui-session-manager.mjs";
import { collectCodexTuiCompletion } from "../../codex-tui-completion-collector.mjs";

function sessionId(handle) {
  return handle?.session_id || handle?.id || null;
}

function evidenceFromCompletion(completion = {}) {
  const result = completion.result_json || {};
  const findings = Array.isArray(completion.findings) ? completion.findings : [];
  const hasBlockingFinding = findings.some((finding) => finding?.severity === "blocker");
  const repositoryClean = completion.worktree_clean !== false;
  const verification = result.verification && typeof result.verification === "object"
    ? structuredClone(result.verification)
    : {
      passed: completion.ready_for_review === true,
      commands: [],
      findings: [],
    };
  verification.findings = [
    ...(Array.isArray(verification.findings) ? verification.findings : []),
    ...findings,
  ];
  if (!repositoryClean || hasBlockingFinding) verification.passed = false;
  const claimedStatus = ["completed", "failed", "timed_out"].includes(result.status)
    ? result.status
    : completion.ready_for_review ? "completed" : "failed";
  const status = claimedStatus === "completed" && verification.passed === false ? "failed" : claimedStatus;
  return {
    ...result,
    status,
    summary: result.summary || "",
    changed_files: Array.isArray(result.changed_files) ? result.changed_files : (completion.changed_files || []),
    tests: result.tests ?? completion.tests ?? [],
    commit: result.commit || completion.commit || null,
    remote_head: result.remote_head || null,
    verification,
  };
}

export function createCodexTuiProvider({
  startCodexTuiGoalSessionFn = startCodexTuiGoalSession,
  getCodexTuiSessionStatusFn = getCodexTuiSessionStatus,
  sendCodexTuiSessionInputFn = sendCodexTuiSessionInput,
  stopCodexTuiSessionFn = stopCodexTuiSession,
  collectCodexTuiCompletionFn = collectCodexTuiCompletion,
  runCodexTuiEvidenceCycleFn = null,
  availableFn = null,
} = {}) {
  async function start(attempt, context = {}) {
    const checkpoint = context.checkpoint || null;
    const cwd = context.executionCwd || checkpoint?.execution_cwd || attempt.path_context?.execution_cwd;
    const config = context.config || {};
    const session = await startCodexTuiGoalSessionFn({
      ...context,
      cwd,
      executionId: context.executionId || attempt.id,
      checkpoint,
      tuiAutopilotEnabled: config.tuiAutopilotEnabled,
      tuiAutopilotMaxActions: config.tuiAutopilotMaxActions,
      tuiAutopilotMaxRepairs: config.tuiAutopilotMaxRepairs,
      tuiFrameStableMs: config.tuiFrameStableMs,
      tuiNoProgressSeconds: config.tuiNoProgressSeconds,
      tuiClassifierEnabled: config.tuiClassifierEnabled,
    });
    return {
      session_id: session.id || session.session_id,
      native_session_id: session.native_session_id || checkpoint?.native_session_id || null,
      cwd: session.cwd || cwd,
      completion: null,
    };
  }

  return {
    name: "codex_tui",
    revision: "tui-adapter-v1",
    async availability(context = {}) {
      if (typeof availableFn === "function") return Boolean(await availableFn(context));
      return context.tuiAvailable !== false;
    },
    start,
    async resume(attempt, checkpoint, context = {}) {
      const controlSessionId = checkpoint?.control_session_id || null;
      const nativeSessionId = checkpoint?.native_session_id || null;

      // Resume priority:
      // 1. Active tmux pane — just return the running session as-is
      // 2. Known native session ID — try native codex resume
      // 3. Checkpointed TUI attempt — send /resume to control session
      // 4. Still failed — waiting_for_supervisor (signaled via returning empty to caller)

      if (controlSessionId) {
        try {
          const status = await getCodexTuiSessionStatusFn(controlSessionId, {
            workspaceRoot: context.workspaceRoot,
            candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
          });

          // Priority 1: session is already running — no resume needed
          if (status.status === "running") {
            return {
              session_id: controlSessionId,
              native_session_id: status.native_session_id || nativeSessionId || null,
              cwd: status.cwd || checkpoint?.execution_cwd || context.executionCwd,
              completion: null,
            };
          }

          // Priority 2: known native session ID — try native codex resume
          if (nativeSessionId) {
            try {
              await sendCodexTuiSessionInputFn(controlSessionId, `/resume ${nativeSessionId}\r`, {
                workspaceRoot: context.workspaceRoot,
                candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
              });
              return {
                session_id: controlSessionId,
                native_session_id: nativeSessionId,
                cwd: status.cwd || checkpoint?.execution_cwd || context.executionCwd,
                completion: null,
              };
            } catch {
              // Fall through to checkpointed resume
            }
          }

          // Priority 3: session is paused/checkpointed — send /resume
          if (["created", "paused", "checkpointed"].includes(status.status)) {
            await sendCodexTuiSessionInputFn(controlSessionId, "/resume\r", {
              workspaceRoot: context.workspaceRoot,
              candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
            });
            return {
              session_id: controlSessionId,
              native_session_id: status.native_session_id || nativeSessionId || null,
              cwd: status.cwd || checkpoint?.execution_cwd || context.executionCwd,
              completion: null,
            };
          }

          // Session is in a terminal state (completed, failed, stopped)
          // Fall through to start a new session
        } catch {
          // Session status check threw — fall through to start new session
        }
      }

      // Priority 4: no viable recovery via existing session — start new
      return start(attempt, {
        ...context,
        checkpoint,
        executionCwd: checkpoint?.execution_cwd || context.executionCwd,
        resumeNativeSessionId: nativeSessionId,
      });
    },
    async observe(handle, context = {}) {
      if (typeof runCodexTuiEvidenceCycleFn === "function") {
        const cycle = await runCodexTuiEvidenceCycleFn({
          task: context.task,
          goal: context.goal,
          sessionId: sessionId(handle),
          workspaceRoot: context.workspaceRoot,
          maxWaitMs: context.codexTuiEvidenceWaitMs,
          getSessionStatusFn: async (id) => getCodexTuiSessionStatusFn(id, {
            workspaceRoot: context.workspaceRoot,
            candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
          }),
          sendInputFn: (id, input) => sendCodexTuiSessionInputFn(id, input, {
            workspaceRoot: context.workspaceRoot,
            candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
          }),
        });
        if (cycle?.evidence_ready) {
          handle.completion = cycle.collected || cycle.completion || cycle;
          return { state: "evidence_ready", native_session_id: handle?.native_session_id || null };
        }
        // Partial progress while session is still writing durable evidence.
        if (cycle?.continue_waiting === true || cycle?.status === "running") {
          return {
            state: "running",
            native_session_id: handle?.native_session_id || null,
            checkpoint: {
              phase: "awaiting_result_json",
              reason: cycle?.reason || "tui_result_partial_session_active",
              session_status: cycle?.session_status || null,
            },
          };
        }
        const state = cycle?.status === "timed_out" ? "timed_out" : "failed";
        return {
          state,
          failure: {
            code: state === "timed_out" ? "execution_timeout" : (cycle?.finding?.code || "tui_result_missing"),
            failure_class: state === "timed_out" ? "result_missing" : "result_missing",
            detail: cycle?.reason || null,
            cycle,
          },
          native_session_id: handle?.native_session_id || null,
        };
      }
      const status = await getCodexTuiSessionStatusFn(sessionId(handle), {
        workspaceRoot: context.workspaceRoot,
        candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
      });
      if (["completed", "stopped"].includes(status.status)) {
        return { state: "evidence_ready", native_session_id: handle?.native_session_id || null };
      }
      if (status.status === "waiting_for_supervisor") {
        return {
          state: "waiting_for_supervisor",
          checkpoint: status.checkpoint || null,
          native_session_id: status.native_session_id || handle?.native_session_id || null,
        };
      }
      if (status.status === "timed_out") {
        return { state: "timed_out", failure: { code: "execution_timeout" }, native_session_id: handle?.native_session_id || null };
      }
      if (status.status === "detached") {
        return {
          state: "failed",
          failure: { code: "pty_unavailable", detail: status.detach_reason || null },
          native_session_id: handle?.native_session_id || null,
        };
      }
      if (status.status === "failed") {
        return {
          state: "failed",
          failure: { code: status.error_code || "tui_execution_failed", detail: status.error || null },
          native_session_id: handle?.native_session_id || null,
        };
      }
      return { state: "running", native_session_id: handle?.native_session_id || null };
    },
    async send(handle, input, context = {}) {
      return sendCodexTuiSessionInputFn(sessionId(handle), input, {
        workspaceRoot: context.workspaceRoot,
        candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
      });
    },
    async interrupt(handle, context = {}) {
      return stopCodexTuiSessionFn(sessionId(handle), {
        reason: context.interruptReason || "execution_provider_interrupt",
        workspaceRoot: context.workspaceRoot,
        candidateWorkspaceRoots: context.candidateWorkspaceRoots || [],
      });
    },
    async collect(handle, context = {}) {
      const completion = handle?.completion || await collectCodexTuiCompletionFn({
        sessionId: sessionId(handle),
        workspaceRoot: context.workspaceRoot,
      });
      return evidenceFromCompletion(completion);
    },
    async dispose() {},
  };
}
