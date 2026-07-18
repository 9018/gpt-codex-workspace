/**
 * supervisor-runtime.mjs — Supervisor module singleton wiring.
 *
 * Creates shared singleton instances of supervisor stores, services,
 * and tools for use by the main tool registry and worker loop.
 *
 * Stores are lazily initialized on first access and reuse the same
 * in-memory/stateStore-backed instances across composition cycles.
 *
 * @module supervisor-review/supervisor-runtime
 */

import { createCommandStore } from "./supervisor-command-store.mjs";
import { createDecisionStore } from "./supervisor-decision-store.mjs";
import { createReviewRequestStore } from "./supervisor-review-request-store.mjs";
import { createControllerLease } from "./supervisor-controller-lease.mjs";
import { createSupervisorCheckpointStore } from "../supervisor/supervisor-checkpoint-store.mjs";
import { createSupervisorPlanStore } from "../supervisor/supervisor-plan-store.mjs";
import { createSupervisorReviewPacketBuilder } from "./supervisor-review-packet-builder.mjs";
import { createReviewCoordinator } from "./review-coordinator.mjs";
import { createActionGuard } from "./supervisor-action-guard.mjs";
import { createSupervisorCommandExecutor } from "./supervisor-command-executor.mjs";
import { createReviewWorker } from "./supervisor-review-worker.mjs";
import { createExecutionRunStore } from "../execution-core/execution-run-store.mjs";

import { createSupervisorReviewTools } from "../tool-groups/supervisor-review/supervisor-review-tools.mjs";
import { createSupervisorDecisionTools } from "../tool-groups/supervisor-review/supervisor-decision-tools.mjs";

// ---------------------------------------------------------------------------
// Module-level lazy singletons
// ---------------------------------------------------------------------------

let _initialized = false;

// Stores
let _runStore = null;
let _commandStore = null;
let _decisionStore = null;
let _reviewRequestStore = null;
let _checkpointStore = null;
let _planStore = null;
let _leaseManager = null;

// Services
let _actionGuard = null;
let _reviewPacketBuilder = null;
let _reviewCoordinator = null;
let _commandExecutor = null;
let _reviewWorker = null;

let _reviewTools = null;
let _decisionTools = null;

/**
 * Ensure all supervisor stores are initialized with the shared state store.
 * Only the first call creates the instances; subsequent calls are no-ops.
 *
 * @param {object} stateStore - The shared state store (e.g., from server-tools.mjs)
 */
export function ensureSupervisorRuntime(stateStore) {
  if (_initialized) return;

  // Create execution run store
  _runStore = createExecutionRunStore({ stateStore });

  // Create supervisor stores
  _commandStore = createCommandStore({ stateStore });
  _decisionStore = createDecisionStore({ stateStore });
  _reviewRequestStore = createReviewRequestStore({ stateStore });
  _checkpointStore = createSupervisorCheckpointStore({ stateStore });
  _planStore = createSupervisorPlanStore({ stateStore });
  _leaseManager = createControllerLease();

  // Create services
  _actionGuard = createActionGuard();
  _reviewPacketBuilder = createSupervisorReviewPacketBuilder({
    runStore: _runStore,
    checkpointReader: {
      latest: async (runId) => {
        const run = await _runStore.readRun(runId);
        if (!run.checkpoint_ids?.length) return null;
        const lastCpId = run.checkpoint_ids[run.checkpoint_ids.length - 1];
        try {
          return await _checkpointStore.readCheckpoint(lastCpId);
        } catch {
          return null;
        }
      },
    },
    planReader: {
      readForRun: async (run) => {
        if (!run.supervisor_plan_id) return null;
        try {
          return await _planStore.readPlan(run.supervisor_plan_id);
        } catch {
          return null;
        }
      },
    },
    repositoryEvidence: {
      collect: async () => ({
        worktree_path: null, base_sha: null, head_sha: null,
        changed_files: [], diff_summary: "", focused_diff: "",
        new_symbols: [], deleted_symbols: [], diff_digest: null, dirty_paths: [],
      }),
    },
    tuiProgressReader: { read: async () => null },
    tuiSessionReader: { read: async () => null },
    decisionStore: _decisionStore,
    contextReader: { read: async () => ({ digest: null }) },
    objectiveReader: { read: async () => ({}) },
    architectureBaselineReader: { read: async () => ({}) },
  });

  _reviewCoordinator = createReviewCoordinator({
    reviewPacketBuilder: _reviewPacketBuilder,
    reviewRequestStore: _reviewRequestStore,
  });

  // Revision reader shared between command executor and review worker
  const revisionReader = {
    current: async (runId) => {
      const run = await _runStore.readRun(runId);
      return {
        id: run.checkpoint_ids?.length
          ? `${run.id}:${run.version}:${run.checkpoint_ids.length}`
          : `${run.id}:${run.version}:0`,
      };
    },
  };

  _commandExecutor = createSupervisorCommandExecutor({
    runStore: _runStore,
    revisionReader,
    actionGuard: _actionGuard,
    leaseStore: _leaseManager,
    planStore: _planStore,
    commandStore: _commandStore,
    failureClassifier: {
      classify: (error) => ({
        retryable: error.message?.includes("timeout") || error.message?.includes("connection"),
        message: error.message,
      }),
    },
  });

  _reviewWorker = createReviewWorker({
    commandStore: _commandStore,
    commandExecutor: _commandExecutor,
    revisionReader,
  });

  // Create tools
  _reviewTools = createSupervisorReviewTools({
    runStore: _runStore,
    commandStore: _commandStore,
    leaseManager: _leaseManager,
    reviewPacketBuilder: _reviewPacketBuilder,
  });

  _decisionTools = createSupervisorDecisionTools({
    runStore: _runStore,
    decisionStore: _decisionStore,
    commandStore: _commandStore,
    reviewRequestStore: _reviewRequestStore,
  });

  _initialized = true;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getRunStore() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _runStore;
}

export function getCommandStore() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _commandStore;
}

export function getReviewWorker() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _reviewWorker;
}

export function getReviewCoordinator() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _reviewCoordinator;
}

export function getReviewTools() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _reviewTools;
}

export function getDecisionTools() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _decisionTools;
}

export function getCheckpointStore() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _checkpointStore;
}

export function getLeaseManager() {
  if (!_initialized) throw new Error("Supervisor runtime not initialized");
  return _leaseManager;
}

// ---------------------------------------------------------------------------
// Review Worker scheduling
// ---------------------------------------------------------------------------

let _workerTimer = null;

/**
 * Start the review worker as a background polling loop.
 * Call once during server initialization.
 *
 * @param {number} [intervalMs=10000] - Polling interval in milliseconds
 */
export function startReviewWorker(intervalMs = 10000) {
  if (_workerTimer) return; // Already running
  if (!_initialized) throw new Error("Supervisor runtime not initialized");

  const pollMs = Math.max(2000, intervalMs);

  async function tick() {
    try {
      const result = await _reviewWorker.tick();
      if (result.errors.length > 0) {
        console.error("[supervisor-review-worker] tick errors:", result.errors);
      }
    } catch (err) {
      console.error("[supervisor-review-worker] tick failed:", err.message);
    }
  }

  _workerTimer = setInterval(tick, pollMs);
  // Run first tick immediately
  tick().catch(() => {});

  console.log(`[supervisor-review-worker] started with interval ${pollMs}ms`);
}

/**
 * Stop the review worker background loop.
 */
export function stopReviewWorker() {
  if (_workerTimer) {
    clearInterval(_workerTimer);
    _workerTimer = null;
    console.log("[supervisor-review-worker] stopped");
  }
}
