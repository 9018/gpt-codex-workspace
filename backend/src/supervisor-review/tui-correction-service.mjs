/**
 * tui-correction-service.mjs — Send structured corrections to TUI sessions.
 *
 * Priority:
 *   active control session (writable) → send correction directly
 *   native session (resumable)       → resume then send correction
 *   otherwise                        → TuiSessionUnavailableError
 *
 * Prevents duplicate sends for the same command and tracks
 * awaiting_progress_after_correction state on the run.
 *
 * @module supervisor-review/tui-correction-service
 */

/**
 * Error thrown when no applicable TUI session is available.
 */
export class TuiSessionUnavailableError extends Error {
  constructor(details = {}) {
    super("No active or resumable TUI session available");
    this.name = "TuiSessionUnavailableError";
    this.details = details;
  }
}

/**
 * Render a human-readable correction instruction from command payload.
 *
 * @param {object} payload - Command payload with correction fields
 * @returns {string} Rendered instruction
 */
function renderCorrection(payload) {
  const lines = [
    `架构纠偏目标：${payload.objective}`,
    "",
    "发现的方向偏离：",
    ...(payload.observed_drift || []).map((x) => `- ${x}`),
    "",
    "必须完成：",
    ...(payload.required_changes || []).map((x) => `- ${x}`),
    "",
  ];

  if (payload.forbidden_changes?.length) {
    lines.push("禁止：");
    lines.push(...payload.forbidden_changes.map((x) => `- ${x}`));
    lines.push("");
  }

  lines.push(
    `允许修改文件：${payload.allowed_files?.join(", ") || "仅限完成目标所需最小范围"}`
  );
  lines.push("");

  if (payload.required_commands?.length) {
    lines.push("完成前必须运行：");
    lines.push(...payload.required_commands.map((x) => `- ${x}`));
    lines.push("");
  }

  lines.push(
    "不要创建新 Goal、Task、worktree 或第二套状态模型。继续当前 session。"
  );

  return lines.join("\n");
}

/**
 * Create the TUI correction service.
 *
 * @param {object} deps
 * @param {object} deps.sessionResolver - { resolve(run) => session }
 * @param {object} deps.sessionGuard - { assertBoundToRun, assertSameWorktree }
 * @param {object} deps.tuiDeltaSender - { preview, send }
 * @param {object} deps.runStore - { updateRun, readRun }
 * @param {object} [deps.nativeResumeService] - { resume }
 * @returns {object} { apply }
 */
export function createTuiCorrectionService(deps) {
  async function apply(command, run) {
    // Prevent sending if already awaiting progress
    if (run.supervision?.awaiting_progress_after_correction) {
      throw new Error(
        "Already awaiting progress after correction: " +
        (run.supervision.last_correction_id || "unknown")
      );
    }

    const correction = renderCorrection(command.payload);
    const session = await deps.sessionResolver.resolve(run);

    // Priority 1: active writable session
    if (session?.active && session?.writable) {
      return sendToActive({ command, run, session, correction });
    }

    // Priority 2: resumable native session
    if (session?.native_session_id && session?.resumable && deps.nativeResumeService) {
      const resumed = await deps.nativeResumeService.resume({
        run,
        nativeSessionId: session.native_session_id,
        worktreePath: run.workspace_ref?.worktree_path,
      });
      return sendToActive({
        command,
        run,
        session: resumed,
        correction,
      });
    }

    // Priority 3: no available session
    throw new TuiSessionUnavailableError({
      runId: run.id,
      controlSessionId: session?.session_id || null,
      nativeSessionId: session?.native_session_id || null,
    });
  }

  async function sendToActive({ command, run, session, correction }) {
    // Validate bindings
    await deps.sessionGuard.assertBoundToRun({ session, run });
    await deps.sessionGuard.assertSameWorktree({ session, run });

    // Build structured delta
    const delta = {
      schema_version: 1,
      type: "architecture_correction",
      command_id: command.id,
      review_revision_id: command.review_revision_id,
      instruction: correction,
      expected_ack: {
        command_id: command.id,
        revision_id: command.review_revision_id,
      },
    };

    // Preview and send
    await deps.tuiDeltaSender.preview({ sessionId: session.id, delta });
    const sent = await deps.tuiDeltaSender.send({ sessionId: session.id, delta });

    // Update run supervision
    const update = {
      last_correction_id: command.id,
      last_correction_revision: command.review_revision_id,
      correction_cycles: (run.supervision?.correction_cycles || 0) + 1,
      awaiting_progress_after_correction: true,
      correction_sent_at: sent.sent_at || new Date().toISOString(),
    };
    await deps.runStore.updateRun(run.id, {
      supervision: { ...run.supervision, ...update },
    });

    return {
      session_id: session.id,
      native_session_id: session.native_session_id || null,
      delta_id: sent.delta_id,
      sent_at: sent.sent_at,
    };
  }

  return { apply };
}
