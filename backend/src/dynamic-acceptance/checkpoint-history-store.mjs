/**
 * checkpoint-history-store.mjs — Checkpoint evaluation history store.
 *
 * Keeps a durable record of checkpoint verdicts for auditing,
 * debugging, and detecting repeated failure patterns.
 *
 * @module checkpoint-history-store
 */

/**
 * Create a checkpoint history store.
 *
 * @param {object} [options]
 * @param {object} [options.stateStore] - Optional durable state store
 * @returns {object} History store API
 */
export function createCheckpointHistoryStore({ stateStore } = {}) {
  /** @type {Map<string, object[]>} run_id -> verdicts */
  const _history = new Map();

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.checkpoint_history) {
      for (const [runId, verdicts] of Object.entries(state.checkpoint_history)) {
        _history.set(runId, verdicts);
      }
    }
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.checkpoint_history = Object.fromEntries(_history);
    });
  }

  _loadPersisted().catch(() => {});

  /**
   * Record a verdict in the history.
   *
   * @param {object} verdict - A checkpoint verdict
   * @returns {Promise<void>}
   */
  async function recordVerdict(verdict) {
    const runId = verdict.run_id || verdict.checkpoint_id;
    if (!_history.has(runId)) _history.set(runId, []);
    _history.get(runId).push(structuredClone(verdict));
    await _persist();
  }

  /**
   * Get verdict history for a run, most recent first.
   *
   * @param {string} runId
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async function getHistory(runId, limit) {
    const verdicts = _history.get(runId) || [];
    const reversed = [...verdicts].reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  }

  /**
   * Get recent verdicts of a specific type for a run.
   *
   * @param {string} runId
   * @param {string} verdictType
   * @param {number} [recent=5]
   * @returns {Promise<object[]>}
   */
  async function getRecentByType(runId, verdictType, recent = 5) {
    const verdicts = _history.get(runId) || [];
    return verdicts.filter((v) => v.verdict === verdictType).slice(-recent);
  }

  /**
   * Count all recorded verdicts.
   * @returns {number}
   */
  function count() {
    let total = 0;
    for (const verdicts of _history.values()) total += verdicts.length;
    return total;
  }

  return { recordVerdict, getHistory, getRecentByType, count };
}
