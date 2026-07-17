/**
 * codex-quiescence-service.mjs — Quiesce a running Codex before ChatGPT takeover.
 *
 * Protocol:
 *   1. Acquire lease (codex_active -> codex_quiescing)
 *   2. Capture repository snapshot (before)
 *   3. Interrupt Codex provider with checkpoint_and_pause
 *   4. Wait for no active writer (process probe, 30s timeout)
 *   5. Capture two stable snapshots (must match)
 *   6. Create takeover checkpoint
 *   7. Transition lease (codex_quiescing -> chatgpt_supervising)
 *
 * @module supervisor-review/codex-quiescence-service
 */

/**
 * Error thrown when the worktree is still changing after interruption.
 */
export class WorktreeStillChangingError extends Error {
  constructor(runId) {
    super(`Worktree still changing after interrupt for run ${runId}`);
    this.name = "WorktreeStillChangingError";
    this.runId = runId;
  }
}

/**
 * Create the quiescence service.
 *
 * @param {object} deps
 * @param {object} deps.leaseStore - { compareAndSetOwner }
 * @param {object} deps.repositorySnapshot - { capture(run) => { diff_digest, head_sha } }
 * @param {object} deps.provider - { interrupt({ attemptId, mode, reason }) }
 * @param {object} deps.processProbe - { waitForNoWriter({ runId, worktreePath, timeoutMs }) }
 * @param {object} deps.clock - { sleep(ms) }
 * @param {object} deps.checkpointService - { createTakeoverCheckpoint({ run, command, before, stable }) }
 * @returns {object} { quiesce }
 */
export function createCodexQuiescenceService(deps) {
  async function quiesce({ run, command }) {
    // 1. Acquire quiescing lease
    const lease = await deps.leaseStore.compareAndSetOwner({
      runId: run.id,
      expectedOwner: "codex_active",
      nextOwner: "codex_quiescing",
    });

    // 2. Before snapshot
    const before = await deps.repositorySnapshot.capture(run);

    // 3. Interrupt provider
    await deps.provider.interrupt({
      attemptId: run.active_attempt_id,
      mode: "checkpoint_and_pause",
      reason: command.payload?.reason || "ChatGPT takeover",
    });

    // 4. Wait for no writer
    await deps.processProbe.waitForNoWriter({
      runId: run.id,
      worktreePath: run.workspace_ref?.worktree_path,
      timeoutMs: 30_000,
    });

    // 5. Two stable snapshots
    const stable1 = await deps.repositorySnapshot.capture(run);
    await deps.clock.sleep(1_500);
    const stable2 = await deps.repositorySnapshot.capture(run);

    if (
      stable1.diff_digest !== stable2.diff_digest ||
      stable1.head_sha !== stable2.head_sha
    ) {
      throw new WorktreeStillChangingError(run.id);
    }

    // 6. Create checkpoint
    await deps.checkpointService.createTakeoverCheckpoint({
      run,
      command,
      before,
      stable: stable2,
    });

    // 7. Transition to chatgpt_supervising
    return deps.leaseStore.compareAndSetOwner({
      runId: run.id,
      expectedOwner: "codex_quiescing",
      expectedEpoch: lease.epoch,
      nextOwner: "chatgpt_supervising",
    });
  }

  return { quiesce };
}
