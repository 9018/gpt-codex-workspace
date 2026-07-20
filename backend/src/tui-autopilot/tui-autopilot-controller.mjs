import { parseTuiScreen } from "./tui-screen-parser.mjs";
import { classifyTuiState } from "./tui-state-classifier.mjs";
import { decideTuiAction } from "./tui-action-policy.mjs";
import { executeTuiAction } from "./tui-action-executor.mjs";
import { createTuiTranscriptWindow } from "./tui-transcript-window.mjs";
import { createTuiProgressTracker } from "./tui-progress-tracker.mjs";
import { decideTuiRecovery } from "./tui-recovery-policy.mjs";

function recoveryAction(recoveryAttempt) {
  const recovery = decideTuiRecovery({ recoveryAttempt });
  if (recovery.type === "probe") {
    return { type: "send_input", input: "Report the current concrete progress and continue the task autonomously.\r", reason_code: recovery.reason_code };
  }
  if (recovery.type === "correct") {
    return { type: "send_input", input: "No meaningful progress was detected. Re-read the goal, correct the current approach, run the required verification, and continue.\r", reason_code: recovery.reason_code };
  }
  return recovery;
}

export function createTuiAutopilotController({
  sessionId,
  allowedRoots = [],
  maxActions = 100,
  maxRepairs = 3,
  noProgressMs = 120_000,
  now = Date.now,
  active: initiallyActive = true,
  writeInput,
  interrupt,
  resume,
  persist = async () => {},
  remainingAcceptance = [],
} = {}) {
  const transcript = createTuiTranscriptWindow();
  const progressTracker = createTuiProgressTracker({ noProgressMs, now });
  let sequence = 0;
  let actionAttempts = 0;
  let repairAttempts = 0;
  let lastSideEffectSignature = null;
  let active = initiallyActive !== false;
  return {
    activate() { active = true; },
    resetForExternalInput() {
      active = true;
      actionAttempts = 0;
      repairAttempts = 0;
      progressTracker.reset?.();
      lastSideEffectSignature = null;
    },
    async ingest(chunk, context = {}) {
      transcript.append(chunk);
      const frame = parseTuiScreen(transcript.snapshot().text, { sequence: ++sequence });
      transcript.addFrame(frame);
      const classification = classifyTuiState(frame, context);
      const progress = progressTracker.observe({
        ...frame,
        content_digest: JSON.stringify({
          state: classification.state,
          prompt_markers: frame.prompt_markers,
          selectable_options: frame.selectable_options,
          confirmation_markers: frame.confirmation_markers,
          error_markers: frame.error_markers,
          progress_markers: frame.progress_markers,
          terminal_markers: frame.terminal_markers,
        }),
      }, { at: now() });
      let action;
      const streamDisconnected = /stream disconnected before completion|stream truncated before any output was produced/i.test(String(chunk || ""));
      if (!active) {
        action = { type: "observe", reason_code: "autopilot_not_activated" };
      } else if (streamDisconnected) {
        action = repairAttempts >= maxRepairs
          ? { type: "checkpoint_supervisor", reason_code: "stream_disconnect_recovery_budget_exhausted" }
          : { type: "resume", reason_code: "stream_disconnected_goal_resume" };
        if (action.type === "resume") repairAttempts += 1;
      } else if (progress.no_progress) {
        action = repairAttempts >= maxRepairs
          ? { type: "checkpoint_supervisor", reason_code: "autopilot_recovery_budget_exhausted" }
          : recoveryAction(repairAttempts);
        if (action.type !== "checkpoint_supervisor") repairAttempts += 1;
      } else {
        action = decideTuiAction({
          state: classification.state,
          frame,
          allowedRoots,
          remainingAcceptance: context.remainingAcceptance || remainingAcceptance,
          actionAttempts,
          maxActions,
        });
      }
      if (action.type === "send_input") {
        const sideEffectSignature = JSON.stringify({
          state: classification.state,
          type: action.type,
          input: action.input,
          reason_code: action.reason_code,
        });
        if (sideEffectSignature === lastSideEffectSignature) {
          action = { type: "observe", reason_code: "duplicate_action_suppressed" };
        } else {
          lastSideEffectSignature = sideEffectSignature;
          actionAttempts += 1;
        }
      } else if (action.type !== "observe") {
        lastSideEffectSignature = null;
      }
      if (action.type === "checkpoint_supervisor") {
        await persist({
          status: "waiting_for_supervisor",
          autopilot_state: classification.state,
          last_frame_digest: frame.content_digest,
          last_action: action,
          action_attempts: actionAttempts,
          repair_attempts: repairAttempts,
          checkpoint: {
            version: 1,
            session_id: sessionId,
            reason_code: action.reason_code,
            frame_digest: frame.content_digest,
            remaining_acceptance: context.remainingAcceptance || remainingAcceptance,
          },
        });
      } else {
        await executeTuiAction(action, { writeInput, interrupt, resume });
        await persist({
          autopilot_state: classification.state,
          last_frame_digest: frame.content_digest,
          last_action: action,
          action_attempts: actionAttempts,
          repair_attempts: repairAttempts,
        });
      }
      return { state: classification.state, classification, action, frame, progress };
    },
    snapshot: () => ({ active, action_attempts: actionAttempts, repair_attempts: repairAttempts, sequence, transcript: transcript.snapshot() }),
  };
}
