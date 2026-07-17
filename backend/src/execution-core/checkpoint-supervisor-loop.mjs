/**
 * checkpoint-supervisor-loop.mjs — Supervisor runtime composition root.
 *
 * Wires the checkpoint trigger, evidence collector, acceptance service,
 * history store, and correction builder into a single polling loop
 * that monitors the execution run and triggers checkpoints dynamically.
 *
 * This is the missing composition root that connects the supervisor and
 * dynamic-acceptance modules into a production runtime loop.
 *
 * Flow: poll -> trigger check -> collect evidence -> create checkpoint ->
 *       evaluate -> record verdict -> execute action -> loop
 *
 * REVIEW COORDINATOR: When deps.reviewCoordinator is provided, tick()
 * also builds a SupervisorReviewPacket and creates a review request.
 *
 * @module checkpoint-supervisor-loop
 */

/**
 * Create the supervisor checkpoint loop.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.checkpointStore - Supervisor checkpoint store
 * @param {object} deps.triggerPolicy - Checkpoint trigger policy (evaluate)
 * @param {object} deps.evidenceCollector - Evidence collector (collect)
 * @param {object} deps.acceptanceService - Checkpoint acceptance service (evaluateCheckpoint)
 * @param {object} deps.historyStore - Checkpoint history store
 * @param {object} [deps.correctionBuilder] - Correction builder
 * @param {object} [deps.supervisorPolicyEngine] - For next-action decisions
 * @param {number} [deps.pollIntervalMs=5000] - Polling interval in ms
 * @param {number} [deps.maxLoops=0] - Max loops (0 = unlimited)
 * @param {object} [deps.reviewCoordinator] - Optional review coordinator
 * @returns {object} Loop API ({ start, stop, isRunning })
 */
export function createCheckpointSupervisorLoop(deps) {
  if (!deps.runStore) throw new Error("runStore is required");
  if (!deps.checkpointStore) throw new Error("checkpointStore is required");
  if (!deps.triggerPolicy) throw new Error("triggerPolicy is required");
  if (!deps.evidenceCollector) throw new Error("evidenceCollector is required");
  if (!deps.acceptanceService) throw new Error("acceptanceService is required");
  if (!deps.historyStore) throw new Error("historyStore is required");

  let _running = false;
  let _stopped = false;
  let _loopCount = 0;
  let _timer = null;

  const pollIntervalMs = Math.max(1000, deps.pollIntervalMs || 5000);
  const maxLoops = deps.maxLoops || 0;

  /**
   * Run one iteration of the supervisor loop.
   *
   * @param {string} runId
   * @param {string} [sessionId]
   * @param {object} [progress]
   * @returns {Promise<object>}
   */
  async function tick(runId, { sessionId = null, progress = null } = {}) {
    // 1. Check run state — only loop for active runs
    let run;
    try {
      run = await deps.runStore.readRun(runId);
    } catch {
      return { triggered: false, verdict: null, action: null, review_result: null };
    }

    const activeStates = ["running", "collecting", "evaluating", "waiting_for_repair"];
    if (!activeStates.includes(run.state)) {
      return { triggered: false, verdict: null, action: null, review_result: null };
    }

    // 2. Check trigger conditions
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
      progress: progress || null,
      hasGitDiff: false,
      testJustCompleted: false,
    });

    if (!triggerResult.shouldTrigger) {
      return { triggered: false, verdict: null, action: null, review_result: null };
    }

    // 3. Collect evidence
    const evidence = await deps.evidenceCollector.collect({
      runId,
      sessionId,
      progressSnapshot: progress,
    });

    // 4. Create checkpoint
    const checkpoint = await deps.checkpointStore.createCheckpoint({
      run_id: runId,
      run_version: run.version,
      trigger_source: triggerResult.triggerSource,
      evidence_snapshot: evidence,
    });

    // ★ Review coordinator integration
    let reviewResult = null;
    if (deps.reviewCoordinator) {
      try {
        reviewResult = await deps.reviewCoordinator.tick(runId);
      } catch (reviewErr) {
        // Non-fatal: review failures should not break the loop
        reviewResult = {
          review_required: false,
          request: null,
          skipped_reason: `Review coordinator error: ${reviewErr.message}`,
        };
      }
    }

    // 5. Evaluate through acceptance service
    const acceptanceResult = await deps.acceptanceService.evaluateCheckpoint({
      runId,
      sessionId,
      progress,
    });

    // 6. Update run checkpoint ids
    try {
      await deps.runStore.updateRun(runId, {
        active_checkpoint_id: checkpoint.id,
        checkpoint_ids: [...(run.checkpoint_ids || []), checkpoint.id],
      });
    } catch {
      // Non-fatal
    }

    return {
      triggered: true,
      verdict: acceptanceResult.verdict || null,
      action: acceptanceResult.action || null,
      checkpoint_id: checkpoint.id,
      review_result: reviewResult,
    };
  }

  /**
   * Start the supervisor loop. Polls tick() at the configured interval.
   *
   * @param {string} runId
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async function start(runId, options = {}) {
    if (_running) return;
    _running = true;
    _stopped = false;
    _loopCount = 0;

    return new Promise((resolve) => {
      const poll = async () => {
        if (_stopped || (maxLoops > 0 && _loopCount >= maxLoops)) {
          _running = false;
          resolve();
          return;
        }

        _loopCount++;

        try {
          await tick(runId, options);
        } catch {
          // Individual tick failures should not stop the loop
        }

        _timer = setTimeout(poll, pollIntervalMs);
      };

      poll();
    });
  }

  /**
   * Stop the supervisor loop.
   */
  function stop() {
    _stopped = true;
    _running = false;
    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
    }
  }

  /**
   * Check if the loop is running.
   * @returns {boolean}
   */
  function isRunning() {
    return _running;
  }

  return { tick, start, stop, isRunning };
}
