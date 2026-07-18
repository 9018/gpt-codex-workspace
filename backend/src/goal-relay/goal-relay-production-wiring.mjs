/**
 * goal-relay-production-wiring.mjs — Production wiring for Goal Relay.
 *
 * Creates a fully-wired goal relay service with production dependencies
 * and integrates it into the supervisor runtime.
 *
 * @module goal-relay/production-wiring
 */

import { createGoalRelayService } from "./goal-relay-service.mjs";
import { createRepairArtifactWriter } from "./goal-relay-artifact-writer.mjs";
import { createGoalRelayTuiBridge } from "./goal-relay-tui-bridge.mjs";

export { createGoalRelayService } from "./goal-relay-service.mjs";
export { createRepairArtifactWriter } from "./goal-relay-artifact-writer.mjs";
export { createGoalRelayTuiBridge } from "./goal-relay-tui-bridge.mjs";

/**
 * Create a fully-wired goal relay service with production dependencies.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {Function} deps.createGoal - Goal creation function
 * @param {Function} deps.enqueueGoal - Goal enqueue function
 * @param {object} [deps.tuiGoalDriver] - TUI goal command driver
 * @param {Function} [deps.getActiveTuiSession] - Get active TUI session
 * @param {string} [deps.artifactBaseDir] - Base directory for repair artifacts
 * @param {boolean} [deps.dryRun] - If true, don't write files or submit goals
 * @returns {object} { goalRelayService, repairArtifactWriter, tuiBridge }
 */
export function createWiredGoalRelay({
  runStore,
  createGoal,
  enqueueGoal,
  tuiGoalDriver = null,
  getActiveTuiSession = null,
  artifactBaseDir = process.cwd(),
  dryRun = false,
} = {}) {
  if (!runStore) throw new Error("runStore is required");

  // Create idempotency store for goal cycles
  const cycleIdempotencyStore = createCycleIdempotencyStore({ runStore });

  // Create repair artifact writer
  const repairArtifactWriter = createRepairArtifactWriter({
    baseDir: artifactBaseDir,
    dryRun,
  });

  // Create TUI bridge for successor goal submission
  const tuiBridge = createGoalRelayTuiBridge({
    createGoal,
    enqueueGoal,
    tuiGoalDriver,
    getActiveTuiSession,
    idempotencyStore: cycleIdempotencyStore,
  });

  // Create the goal relay service with production deps
  const goalRelayService = createGoalRelayService({
    runStore,
    repairArtifactWriter,
    cycleIdempotencyStore,
    goalQueueService: {
      enqueueGoal,
    },
    tuiBridge,
  });

  return {
    goalRelayService,
    repairArtifactWriter,
    tuiBridge,
    cycleIdempotencyStore,
  };
}

/**
 * Create an idempotency store backed by the run store's supervision state.
 * This ensures idempotency keys survive process restart.
 *
 * @param {object} options
 * @param {object} options.runStore
 * @returns {object} { has(key), mark(key) }
 */
function createCycleIdempotencyStore({ runStore } = {}) {
  // In-memory set as fast path + run store as durable fallback
  const _completedCycles = new Set();
  let _loaded = false;

  async function _ensureLoaded() {
    if (_loaded || !runStore) return;
    try {
      const runs = await runStore.listRuns();
      for (const run of runs) {
        const relay = run.supervision?.goal_relay;
        if (!relay) continue;
        const prefix = `goal-cycle:${run.id}`;
        // Reconstruct idempotency keys from completed cycles
        for (let i = 0; i < relay.cycles_completed; i++) {
          const key = `${prefix}:${i + 1}`;
          _completedCycles.add(key);
        }
      }
    } catch {
      // Non-fatal
    }
    _loaded = true;
  }

  return {
    /**
     * Check if a cycle idempotency key has been marked.
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async has(key) {
      await _ensureLoaded();
      return _completedCycles.has(key);
    },

    /**
     * Mark a cycle idempotency key as completed.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async mark(key) {
      await _ensureLoaded();
      _completedCycles.add(key);
    },
  };
}

/**
 * Wire the goal relay service into the supervisor command executor deps.
 *
 * This is designed to be called from supervisor-runtime.mjs to extend
 * the command executor with goal relay support.
 *
 * @param {object} commandExecutorDeps - The existing command executor deps
 * @param {object} goalRelayService - The wired goal relay service
 */
export function wireGoalRelayIntoCommandExecutor(commandExecutorDeps, goalRelayService) {
  commandExecutorDeps.goalRelayService = goalRelayService;
}
