/**
 * execution-run-store.mjs — In-memory ExecutionRun store with CAS and idempotency.
 *
 * Provides an in-memory (but transition-safe) store for ExecutionRuns.
 * The key invariant is `compareAndSetState`: a write that depends on a
 * specific current state will atomically check, reject if the state has
 * changed (StateConflictError), and apply otherwise.
 *
 * Supports idempotency: same request_id or idempotency_key returns the
 * same run without creating a duplicate.
 *
 * @module execution-run-store
 */

import { createExecutionRun } from "./execution-run-schema.mjs";

/**
 * Error thrown when a CAS operation fails because the expected state
 * does not match the current state.
 */
export class StateConflictError extends Error {
  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.expectedState
   * @param {string} options.actualState
   */
  constructor({ runId, expectedState, actualState }) {
    super(
      `State conflict for run ${runId}: expected "${expectedState}", actual "${actualState}"`
    );
    this.name = "StateConflictError";
    this.runId = runId;
    this.expectedState = expectedState;
    this.actualState = actualState;
  }
}

/**
 * Create an in-memory ExecutionRun store with idempotency support.
 *
 * @param {object} [options]
 * @param {Function} [options.now] - Timestamp generator
 * @param {object} [options.stateStore] - Optional durable state-store for persistence
 * @returns {object} Store API
 */
export function createExecutionRunStore({ now, stateStore } = {}) {
  const _now = now || (() => new Date().toISOString());

  /** Internal map: runId -> run */
  const _runs = new Map();
  /** Index: request_id -> runId */
  const _requestIndex = new Map();
  /** Index: idempotency_key -> runId */
  const _idempotencyIndex = new Map();

  /**
   * Load persisted state from stateStore if available.
   */
  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.execution_runs) {
      for (const [id, run] of Object.entries(state.execution_runs)) {
        _runs.set(id, run);
        if (run.request_id) _requestIndex.set(run.request_id, id);
        if (run.idempotency_key) _idempotencyIndex.set(run.idempotency_key, id);
      }
    }
  }

  /**
   * Persist current state to stateStore if available.
   */
  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.execution_runs = Object.fromEntries(_runs);
      state.execution_request_index = Object.fromEntries(_requestIndex);
      state.execution_run_idempotency_index = Object.fromEntries(_idempotencyIndex);
    });
  }

  /**
   * Perform an atomic mutation via stateStore transaction.
   * Falls back to in-memory Map if stateStore is not configured.
   *
   * The mutator receives the run object and should mutate it in place.
   * After the transaction succeeds, the in-memory cache is refreshed.
   *
   * @param {string} runId
   * @param {Function} mutator - (run) => void
   * @returns {Promise<object>} Updated run (cloned)
   */
  async function _transactionalMutate(runId, mutator) {
    if (stateStore) {
      return stateStore.mutate((state) => {
        if (!state.execution_runs) state.execution_runs = {};
        const run = state.execution_runs[runId];
        if (!run) {
          throw new Error(`ExecutionRun not found: ${runId}`);
        }
        mutator(run);
        // Update in-memory cache from transaction state
        _runs.set(runId, structuredClone(run));
        // Sync indexes
        if (run.request_id) _requestIndex.set(run.request_id, runId);
        if (run.idempotency_key) _idempotencyIndex.set(run.idempotency_key, runId);
        return structuredClone(run);
      });
    } else {
      const run = _runs.get(runId);
      if (!run) {
        throw new Error(`ExecutionRun not found: ${runId}`);
      }
      mutator(run);
      _runs.set(runId, run);
      return structuredClone(run);
    }
  }

  // Load persisted state on creation
  /** Promise that resolves when initial load completes */
  const _initPromise = _loadPersisted().catch(() => {});

  /** Await initial load before any operation */
  async function _ensureLoaded() {
    await _initPromise.catch(() => {});
  }

  /**
   * Find a run by its idempotency key.
   */
  async function findRunByIdempotencyKey(key) {
    await _ensureLoaded();
    const runId = _idempotencyIndex.get(key);
    if (!runId) return null;
    const run = _runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  /**
   * Find a run by its request_id.
   */
  async function findRunByRequestId(requestId) {
    await _ensureLoaded();
    const runId = _requestIndex.get(requestId);
    if (!runId) return null;
    const run = _runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  /**
   * Create a new ExecutionRun and add it to the store.
   *
   * @param {object} input - Fields for createExecutionRun
   * @returns {object} The newly created run (cloned)
   */
  async function createRun(input) {
    await _ensureLoaded();
    const ts = _now();
    const run = createExecutionRun({ ...input, created_at: ts, updated_at: ts });
    
    if (stateStore) {
      // Create within transaction for idempotency
      return stateStore.mutate((state) => {
        if (run.request_id && state.execution_run_request_index?.[run.request_id]) {
          // Idempotency: return existing run
          const existingId = state.execution_run_request_index[run.request_id];
          return structuredClone(state.execution_runs?.[existingId] || _runs.get(existingId));
        }
        if (!state.execution_runs) state.execution_runs = {};
        if (!state.execution_run_request_index) state.execution_run_request_index = {};
        if (!state.execution_run_idempotency_index) state.execution_run_idempotency_index = {};
        
        state.execution_runs[run.id] = run;
        if (run.request_id) state.execution_run_request_index[run.request_id] = run.id;
        if (run.idempotency_key) state.execution_run_idempotency_index[run.idempotency_key] = run.id;
        
        // Update in-memory cache
        _runs.set(run.id, structuredClone(run));
        if (run.request_id) _requestIndex.set(run.request_id, run.id);
        if (run.idempotency_key) _idempotencyIndex.set(run.idempotency_key, run.id);
        
        return structuredClone(run);
      });
    }

    // Without stateStore, use Map directly
    _runs.set(run.id, structuredClone(run));
    if (run.request_id) _requestIndex.set(run.request_id, run.id);
    if (run.idempotency_key) _idempotencyIndex.set(run.idempotency_key, run.id);
    await _persist();
    return structuredClone(run);
  }


  /**
   * Read a run by ID.
   *
   * @param {string} runId
   * @returns {Promise<object>} A clone of the run
   * @throws {Error} If the run is not found
   */
  async function readRun(runId) {
    await _ensureLoaded();
    const run = _runs.get(runId);
    if (!run) {
      throw new Error(`ExecutionRun not found: ${runId}`);
    }
    return structuredClone(run);
  }

  /**
   * Update a run's fields non-destructively.  Does NOT change state;
   * use `compareAndSetState` for state transitions.
   *
   * @param {string} runId
   * @param {object} patch - Fields to merge into the run
   * @returns {Promise<object>} Updated run (cloned)
   * @throws {Error} If run not found
   */
  async function updateRun(runId, patch) {
    await _ensureLoaded();
    const run = _runs.get(runId);
    if (!run) {
      throw new Error(`ExecutionRun not found: ${runId}`);
    }

    // Don't allow overwriting immutable fields or state
    const { id, intent_id, created_at, state, ...safePatch } = patch;

    // If stateStore is available, do full transaction with CAS
    if (stateStore) {
      return _transactionalMutate(runId, (r) => {
        Object.assign(r, safePatch, {
          version: r.version + 1,
          updated_at: _now(),
        });
      });
    }

    // Without stateStore, use in-memory Map directly
    Object.assign(run, safePatch, {
      version: run.version + 1,
      updated_at: _now(),
    });

    _runs.set(runId, run);
    await _persist();
    return structuredClone(run);
  }


  /**
   * Append an attempt ID to a run's attempt_ids list.
   * Idempotent: if the attempt ID already exists, version is not bumped.
   *
   * @param {string} runId
   * @param {string} attemptId
   * @returns {Promise<object>} Updated run
   */
  async function appendAttempt(runId, attemptId) {
    await _ensureLoaded();
    
    return _transactionalMutate(runId, (run) => {
      if (!run.attempt_ids.includes(attemptId)) {
        run.attempt_ids = [...run.attempt_ids, attemptId];
        run.version += 1;
        run.updated_at = _now();
      }
    });
  }


  /**
   * Compare-and-set state transition.
   *
   * Atomically transitions a run from `expectedState` to `nextState`.
   * If the run's current state does not match `expectedState`, throws
   * a `StateConflictError`.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.expectedState
   * @param {string} options.nextState
   * @param {object} [options.patch={}] - Additional fields to set
   * @returns {Promise<object>} Updated run (cloned)
   * @throws {StateConflictError} If current state doesn't match expected
   * @throws {Error} If run not found
   */
  async function compareAndSetState({ runId, expectedState, nextState, patch = {} }) {
    await _ensureLoaded();

    // If stateStore is available, do CAS within the transaction
    if (stateStore) {
      return stateStore.mutate((state) => {
        if (!state.execution_runs) state.execution_runs = {};
        const run = state.execution_runs[runId];
        if (!run) {
          throw new Error(`ExecutionRun not found: ${runId}`);
        }
        if (run.state !== expectedState) {
          throw new StateConflictError({
            runId,
            expectedState,
            actualState: run.state,
          });
        }
        // Apply transition
        Object.assign(run, patch, {
          state: nextState,
          version: run.version + 1,
          updated_at: _now(),
        });
        // Update in-memory cache
        _runs.set(runId, structuredClone(run));
        return structuredClone(run);
      });
    }

    // Without stateStore, use in-memory Map CAS
    const run = _runs.get(runId);
    if (!run) {
      throw new Error(`ExecutionRun not found: ${runId}`);
    }
    if (run.state !== expectedState) {
      throw new StateConflictError({
        runId,
        expectedState,
        actualState: run.state,
      });
    }
    Object.assign(run, patch, {
      state: nextState,
      version: run.version + 1,
      updated_at: _now(),
    });
    _runs.set(runId, run);
    await _persist();
    return structuredClone(run);
  }


  /**
   * List all runs, optionally filtered by state or other predicates.
   *
   * @param {object} [filters]
   * @param {string|string[]} [filters.state] - Filter by state(s)
   * @param {string} [filters.intent_id]
   * @param {string} [filters.goal_id]
   * @param {string} [filters.task_id]
   * @returns {Promise<object[]>} Array of run clones
   */
  async function listRuns(filters = {}) {
    await _ensureLoaded();
    let results = [..._runs.values()];

    if (filters.state) {
      const states = Array.isArray(filters.state) ? filters.state : [filters.state];
      results = results.filter((r) => states.includes(r.state));
    }
    if (filters.intent_id) {
      results = results.filter((r) => r.intent_id === filters.intent_id);
    }
    if (filters.goal_id) {
      results = results.filter((r) => r.goal_id === filters.goal_id);
    }
    if (filters.task_id) {
      results = results.filter((r) => r.task_id === filters.task_id);
    }
    if (filters.request_id) {
      results = results.filter((r) => r.request_id === filters.request_id);
    }

    return results.map((r) => structuredClone(r));
  }

  /**
   * Return the total number of runs in the store.
   * @returns {number}
   */
  async function count() {
    await _ensureLoaded();
    return _runs.size;
  }

  return {
    createRun,
    readRun,
    updateRun,
    appendAttempt,
    compareAndSetState,
    listRuns,
    count,
    findRunByIdempotencyKey,
    findRunByRequestId,
  };
}
