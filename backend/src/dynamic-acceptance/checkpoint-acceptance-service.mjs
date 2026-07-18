/**
 * checkpoint-acceptance-service.mjs — Checkpoint acceptance orchestration.
 *
 * The core engine that runs the dynamic checkpoint acceptance loop:
 * 1. Check trigger conditions
 * 2. Collect evidence
 * 3. Evaluate evidence vs acceptance criteria
 * 4. Create verdict
 * 5. Execute action (correct, resume, takeover, etc.)
 * 6. Record history
 *
 * @module checkpoint-acceptance-service
 */

import { createCheckpointVerdict } from "./checkpoint-verdict-schema.mjs";

/**
 * Create the checkpoint acceptance service.
 *
 * @param {object} deps
 * @param {object} deps.triggerPolicy - Checkpoint trigger policy
 * @param {object} deps.evidenceCollector - Evidence collector
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.checkpointStore - Supervisor checkpoint store
 * @param {object} deps.historyStore - Checkpoint history store
 * @param {object} [deps.correctionBuilder] - Correction builder
 * @param {object} [deps.supervisorPolicyEngine] - For deciding next action
 * @returns {object} Acceptance service API
 */
export function createCheckpointAcceptanceService(deps) {
  if (!deps.runStore) throw new Error("runStore is required");
  if (!deps.checkpointStore) throw new Error("checkpointStore is required");
  if (!deps.triggerPolicy) throw new Error("triggerPolicy is required");
  if (!deps.evidenceCollector) throw new Error("evidenceCollector is required");
  if (!deps.historyStore) throw new Error("historyStore is required");

  /**
   * Run one checkpoint evaluation cycle.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} [options.sessionId]
   * @param {object} [options.progress]
   * @param {boolean} [options.hasGitDiff]
   * @param {boolean} [options.testJustCompleted]
   * @returns {Promise<{ triggered: boolean, verdict: object|null, action: string|null }>}
   */
  async function evaluateCheckpoint({ runId, sessionId = null, progress = null, hasGitDiff = false, testJustCompleted = false } = {}) {
    const run = await deps.runStore.readRun(runId);

    // Only evaluate if run is in an active state
    if (!["running", "collecting", "evaluating", "waiting_for_repair"].includes(run.state)) {
      return { triggered: false, verdict: null, action: null };
    }

    // Step 1: Check trigger conditions
    const lastCheckpointId = run.checkpoint_ids?.[run.checkpoint_ids.length - 1] || null;
    let lastCheckpointAt = null;
    if (lastCheckpointId) {
      try {
        const lastCp = await deps.checkpointStore.readCheckpoint(lastCheckpointId);
        lastCheckpointAt = lastCp.created_at;
      } catch {
        // Ignore if checkpoint not found
      }
    }

    const triggerResult = deps.triggerPolicy.evaluate({
      run,
      lastCheckpointAt,
      progress,
      hasGitDiff,
      testJustCompleted,
    });

    if (!triggerResult.shouldTrigger) {
      return { triggered: false, verdict: null, action: null };
    }

    // Step 2: Collect evidence
    const evidence = await deps.evidenceCollector.collect({
      runId,
      sessionId,
      progressSnapshot: progress,
    });

    // Step 3: Create checkpoint in store
    const checkpoint = await deps.checkpointStore.createCheckpoint({
      run_id: runId,
      run_version: run.version,
      trigger_source: triggerResult.triggerSource,
      evidence_snapshot: evidence,
    });

    // Step 4: Decide action based on trigger and evidence
    const decision = await decideAction({
      triggerSource: triggerResult.triggerSource,
      run,
      evidence,
      checkpoint,
    });

    // Step 5: Create verdict
    const verdict = createCheckpointVerdict({
      checkpoint_id: checkpoint.id,
      run_id: runId,
      trigger_source: triggerResult.triggerSource,
      verdict: decision.verdict,
      reason: decision.reason,
      evidence_snapshot: evidence,
      correction: decision.correction || null,
    });

    // Step 6: Record history
    await deps.historyStore.recordVerdict(verdict);

    // Step 7: If checkpoint ids on run need updating, do it
    if (checkpoint.id && !run.checkpoint_ids?.includes(checkpoint.id)) {
      try {
        await deps.runStore.updateRun(runId, {
          active_checkpoint_id: checkpoint.id,
          checkpoint_ids: [...(run.checkpoint_ids || []), checkpoint.id],
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      triggered: true,
      verdict: {
        id: verdict.id,
        verdict: verdict.verdict,
        reason: verdict.reason,
        trigger_source: verdict.trigger_source,
      },
      action: verdict.verdict,
    };
  }

  /**
   * Internal: decide the action based on trigger and evidence.
   * Maps triggers to appropriate actions.
   */
  /**
   * Project a decision from an existing checkpoint and evidence without
   * re-collecting evidence or creating a new checkpoint.
   *
   * This is the "deterministic acceptance projection" that should be used
   * when the caller (e.g. checkpoint-supervisor-loop) has already collected
   * evidence and created the checkpoint. It only:
   * 1. Decides action based on trigger and evidence
   * 2. Creates verdict
   * 3. Records history
   * 4. Updates run checkpoint ids
   *
   * @param {object} options
   * @param {object} options.run - The ExecutionRun
   * @param {object} options.checkpoint - Already-created checkpoint
   * @param {object} options.evidence - Already-collected evidence
   * @param {object} options.triggerResult - Result from triggerPolicy.evaluate
   * @returns {Promise<{ verdict: object|null, action: string|null }>}
   */
  async function projectCheckpoint({ run, checkpoint, evidence, triggerResult } = {}) {
    // Decide action based on trigger and evidence
    const decision = await decideAction({
      triggerSource: triggerResult.triggerSource,
      run,
      evidence,
      checkpoint,
    });

    // Create verdict
    const verdict = createCheckpointVerdict({
      checkpoint_id: checkpoint.id,
      run_id: run.id,
      trigger_source: triggerResult.triggerSource,
      verdict: decision.verdict,
      reason: decision.reason,
      evidence_snapshot: evidence,
      correction: decision.correction || null,
    });

    // Record history
    await deps.historyStore.recordVerdict(verdict);

    // Update run checkpoint ids if needed
    if (checkpoint.id && !run.checkpoint_ids?.includes(checkpoint.id)) {
      try {
        await deps.runStore.updateRun(run.id, {
          active_checkpoint_id: checkpoint.id,
          checkpoint_ids: [...(run.checkpoint_ids || []), checkpoint.id],
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      triggered: true,
      verdict: {
        id: verdict.id,
        verdict: verdict.verdict,
        reason: verdict.reason,
        trigger_source: verdict.trigger_source,
      },
      action: verdict.verdict,
    };
  }

  async function decideAction({ triggerSource, run, evidence, checkpoint }) {
    const supervision = run.supervision || {};
    const correctionCycles = supervision.correction_cycles || 0;
    const sameFailureRetries = supervision.same_failure_retries || 0;

    switch (triggerSource) {
      case "no_progress":
      case "tui_idle":
        if (correctionCycles >= 5) {
          return { verdict: "chatgpt_takeover", reason: `TUI idle after ${correctionCycles} correction cycles` };
        }
        if (sameFailureRetries >= 3) {
          return { verdict: "wait_for_chatgpt", reason: `Same failure repeated ${sameFailureRetries} times` };
        }
        return { verdict: "send_correction", reason: `No progress detected (correction ${correctionCycles + 1})` };

      case "git_diff":
        return { verdict: "continue_codex", reason: "Git diff detected, let codex continue" };

      case "test_completed":
        return { verdict: "continue_codex", reason: "Test completed, continue executing" };

      case "interval":
        return { verdict: "continue_codex", reason: "Routine checkpoint, no issues detected" };

      default:
        return { verdict: "continue_codex", reason: `Checkpoint triggered by ${triggerSource}` };
    }
  }

  return { evaluateCheckpoint, projectCheckpoint };
}
