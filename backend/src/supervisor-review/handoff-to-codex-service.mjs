/**
 * handoff-to-codex-service.mjs — Handoff from ChatGPT back to Codex.
 *
 * After ChatGPT finishes modifying the worktree, this service:
 *   1. Verifies the ChatGPTWorkReceipt
 *   2. Transitions lease (chatgpt_direct -> handoff_to_codex)
 *   3. Creates a checkpoint with receipt as evidence
 *   4. Resumes or starts a Codex session
 *   5. Transitions run state (chatgpt_direct -> running)
 *   6. Updates controller_owner to codex_active
 *
 * @module supervisor-review/handoff-to-codex-service
 */

/**
 * Create the handoff service.
 *
 * @param {object} deps
 * @param {object} deps.runStore - { readRun, compareAndSetState }
 * @param {object} deps.receiptVerifier - { verify({ run, receipt }) }
 * @param {object} deps.leaseStore - { compareAndSetOwner }
 * @param {object} deps.checkpointStore - { createCheckpoint }
 * @param {object} deps.sessionResumeOrStart - { resolve({ run, nativeSessionId, worktreePath }) }
 * @returns {object} { handoff }
 */
export function createHandoffToCodexService(deps) {
  async function handoff({ runId, receipt }) {
    let run = await deps.runStore.readRun(runId);

    // Validate state
    if (run.state !== "chatgpt_direct") {
      throw new Error(
        `Cannot handoff: run ${runId} is in state "${run.state}", expected "chatgpt_direct"`
      );
    }

    // Validate epoch
    if (receipt.controller_epoch !== run.supervision?.controller_epoch) {
      throw new Error(
        `Controller epoch mismatch: receipt has ${receipt.controller_epoch}, run has ${run.supervision?.controller_epoch}`
      );
    }

    // Verify receipt
    await deps.receiptVerifier.verify({ run, receipt });

    // Transition lease
    const lease = await deps.leaseStore.compareAndSetOwner({
      runId,
      expectedOwner: "chatgpt_direct",
      nextOwner: "handoff_to_codex",
    });

    // Create checkpoint
    const checkpoint = await deps.checkpointStore.createCheckpoint({
      run_id: runId,
      trigger_source: "chatgpt_handoff",
      evidence_snapshot: receipt,
    });

    // Resolve session
    const session = await deps.sessionResumeOrStart.resolve({
      run,
      nativeSessionId: run.native_session_id,
      worktreePath: run.workspace_ref?.worktree_path,
      handoffInstruction: renderHandoffInstruction(receipt),
    });

    // Transition run state
    run = await deps.runStore.compareAndSetState({
      runId,
      expectedState: "chatgpt_direct",
      nextState: "running",
      patch: {
        active_checkpoint_id: checkpoint.id,
        supervision: {
          ...run.supervision,
          controller_owner: "codex_active",
          controller_epoch: lease.epoch + 1,
          awaiting_progress_after_correction: false,
          last_handoff_receipt_id: receipt.id,
        },
      },
    });

    return { run, session };
  }

  return { handoff };
}

function renderHandoffInstruction(receipt) {
  return [
    "ChatGPT 已完成修改并交还控制权。以下是变更摘要：",
    "",
    `变更文件：${(receipt.changed_files || []).join(", ") || "无"}`,
    `最终 HEAD：${receipt.final_head_sha || "未知"}`,
    "",
    "已执行的命令：",
    ...(receipt.commands || []).map(
      (cmd) => `  - ${cmd.command} (exit code: ${cmd.exit_code})`
    ),
    "",
    ...(receipt.unresolved_findings?.length
      ? [`未解决的问题：`, ...receipt.unresolved_findings.map((f) => `  - ${f}`), ""]
      : []),
    "继续当前范围。" +
    "不要创建新 Goal、Task 或 worktree。",
  ].join("\n");
}
