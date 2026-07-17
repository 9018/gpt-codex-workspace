/**
 * supervisor-review-worker.mjs — Polling worker for SupervisorCommands.
 *
 * On each tick:
 *   1. Reclaim expired command claims
 *   2. Claim the next pending command (up to maxCommands)
 *   3. If stale revision → supersede, skip execution
 *   4. Execute via command executor
 *   5. Handle errors (logged, not fatal to the worker)
 *
 * @module supervisor-review/supervisor-review-worker
 */

const DEFAULT_MAX_COMMANDS_PER_TICK = 10;

/**
 * Create the review worker.
 *
 * @param {object} deps
 * @param {object} deps.commandStore - { claimNext, reclaimExpired, markSuperseded }
 * @param {object} deps.commandExecutor - { execute(command) }
 * @param {object} deps.revisionReader - { current(runId) => revision }
 * @param {number} [deps.maxCommandsPerTick=10] - Max commands to process per tick
 * @returns {object} { tick }
 */
export function createReviewWorker(deps) {
  const maxCommands = deps.maxCommandsPerTick ?? DEFAULT_MAX_COMMANDS_PER_TICK;

  /**
   * Run one worker tick.
   *
   * @returns {Promise<{ executed: number, superseded: number, reclaimed: number, errors: string[] }>}
   */
  async function tick() {
    const result = {
      executed: 0,
      superseded: 0,
      reclaimed: 0,
      errors: [],
    };

    // 1. Reclaim expired claims
    try {
      const reclaimed = await deps.commandStore.reclaimExpired();
      result.reclaimed = reclaimed.length;
    } catch (err) {
      result.errors.push(`reclaimExpired error: ${err.message}`);
    }

    // 2-5. Process commands up to maxCommands
    let processed = 0;
    while (processed < maxCommands) {
      let command;
      try {
        command = await deps.commandStore.claimNext({ workerId: "review_worker" });
      } catch (err) {
        result.errors.push(`claimNext error: ${err.message}`);
        break;
      }

      if (!command) break; // No more pending commands
      processed++;

      try {
        // Check for stale revision
        const currentRevision = await deps.revisionReader.current(command.run_id);
        if (command.review_revision_id !== currentRevision.id) {
          await deps.commandStore.markSuperseded(
            command.id,
            `Stale revision: ${command.review_revision_id} !== ${currentRevision.id}`
          );
          result.superseded++;
          continue;
        }

        // Execute
        await deps.commandExecutor.execute(command);
        result.executed++;
      } catch (err) {
        result.errors.push(`Command ${command.id}: ${err.message}`);
      }
    }

    return result;
  }

  return { tick };
}
