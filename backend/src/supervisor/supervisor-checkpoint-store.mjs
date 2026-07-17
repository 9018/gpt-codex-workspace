/**
 * supervisor-checkpoint-store.mjs — SupervisorCheckpoint store.
 *
 * @module supervisor-checkpoint-store
 */

import { createSupervisorCheckpoint } from "./supervisor-checkpoint-schema.mjs";
import { SupervisorCheckpointNotFoundError } from "./supervisor-errors.mjs";

/**
 * Create a SupervisorCheckpoint store.
 *
 * @param {object} [options]
 * @param {object} [options.stateStore] - Optional durable state store
 * @returns {object} Store API
 */
export function createSupervisorCheckpointStore({ stateStore } = {}) {
  /** @type {Map<string, object>} */
  const _checkpoints = new Map();
  /** Index: run_id -> [checkpointId, ...] */
  const _runIndex = new Map();

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.supervisor_checkpoints) {
      for (const [id, cp] of Object.entries(state.supervisor_checkpoints)) {
        _checkpoints.set(id, cp);
        if (!_runIndex.has(cp.run_id)) _runIndex.set(cp.run_id, []);
        _runIndex.get(cp.run_id).push(id);
      }
    }
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.supervisor_checkpoints = Object.fromEntries(_checkpoints);
    });
  }

  _loadPersisted().catch(() => {});

  /**
   * Create a new checkpoint.
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function createCheckpoint(input) {
    const cp = createSupervisorCheckpoint(input);
    _checkpoints.set(cp.id, structuredClone(cp));
    if (!_runIndex.has(cp.run_id)) _runIndex.set(cp.run_id, []);
    _runIndex.get(cp.run_id).push(cp.id);
    await _persist();
    return structuredClone(cp);
  }

  /**
   * Read a checkpoint by ID.
   * @param {string} checkpointId
   * @returns {Promise<object>}
   */
  async function readCheckpoint(checkpointId) {
    const cp = _checkpoints.get(checkpointId);
    if (!cp) throw new SupervisorCheckpointNotFoundError(checkpointId);
    return structuredClone(cp);
  }

  /**
   * List checkpoints for a run, most recent first.
   * @param {string} runId
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async function listCheckpoints(runId, limit) {
    const ids = _runIndex.get(runId) || [];
    const results = ids.map((id) => _checkpoints.get(id)).filter(Boolean);
    results.reverse();
    if (limit && limit > 0) return results.slice(0, limit).map((cp) => structuredClone(cp));
    return results.map((cp) => structuredClone(cp));
  }

  /**
   * Update a checkpoint's verdict and action (idempotent post-evaluation).
   * @param {string} checkpointId
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async function updateCheckpoint(checkpointId, patch) {
    const cp = _checkpoints.get(checkpointId);
    if (!cp) throw new SupervisorCheckpointNotFoundError(checkpointId);
    const { id, run_id, created_at, ...safePatch } = patch;
    Object.assign(cp, safePatch);
    _checkpoints.set(checkpointId, cp);
    await _persist();
    return structuredClone(cp);
  }

  /**
   * Count all checkpoints.
   * @returns {number}
   */
  function count() {
    return _checkpoints.size;
  }

  return { createCheckpoint, readCheckpoint, listCheckpoints, updateCheckpoint, count };
}
