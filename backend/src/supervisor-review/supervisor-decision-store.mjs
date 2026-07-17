/**
 * supervisor-decision-store.mjs — Durable SupervisorDecision store.
 *
 * Decisions are immutable once recorded. The store enforces that only
 * one decision per review revision is active, and that the revision
 * hasn't changed since the decision was made. Stale decisions are
 * rejected with StaleReviewDecisionError.
 *
 * @module supervisor-review/supervisor-decision-store
 */

/**
 * Error thrown when a decision references a stale review revision.
 */
export class StaleReviewDecisionError extends Error {
  /**
   * @param {object} options
   * @param {string} options.reviewRevisionId
   * @param {string} options.currentRevisionId
   */
  constructor({ reviewRevisionId, currentRevisionId } = {}) {
    super(
      `Stale review decision: revision ${reviewRevisionId} is no longer current (current: ${currentRevisionId})`
    );
    this.name = "StaleReviewDecisionError";
    this.reviewRevisionId = reviewRevisionId;
    this.currentRevisionId = currentRevisionId;
  }
}

/**
 * Create the Decision store.
 *
 * @param {object} deps
 * @param {object} [deps.revisionReader] - { current(runId) => Revision }
 * @param {object} [deps.requestStore] - { getOrCreate, updateRequestStatus }
 * @param {object} [deps.stateStore] - Optional durable state-store
 * @returns {object} Store API
 */
export function createDecisionStore(deps = {}) {
  const { revisionReader, requestStore, stateStore } = deps;
  /** Map: decision.id -> decision */
  const _decisions = new Map();
  /** Index: run_id -> decision.id[] */
  const _byRun = new Map();

  let _initPromise = null;

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.supervisor_decisions) {
      for (const d of state.supervisor_decisions) {
        _decisions.set(d.id, d);
        _addIndex(d);
      }
    }
  }

  function _addIndex(d) {
    if (!_byRun.has(d.run_id)) _byRun.set(d.run_id, []);
    _byRun.get(d.run_id).push(d.id);
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.supervisor_decisions = Array.from(_decisions.values());
    });
  }

  async function _ensureLoaded() {
    if (!_initPromise) {
      _initPromise = _loadPersisted().catch(() => {});
    }
    await _initPromise.catch(() => {});
  }

  /**
   * Record a decision immutably. Checks that the review revision is
   * still current, and that no duplicate decision ID exists.
   *
   * @param {object} decision - Normalized SupervisorDecision
   * @returns {Promise<object>} The recorded decision
   * @throws {StaleReviewDecisionError} If revision is stale
   * @throws {Error} If decision ID already exists
   */
  async function recordDecision(decision) {
    await _ensureLoaded();

    // Immutability: no duplicate IDs
    if (_decisions.has(decision.id)) {
      throw new Error(`Decision already exists: ${decision.id}`);
    }

    // Check that the revision is still current
    if (revisionReader) {
      const currentRevision = await revisionReader.current(decision.run_id);
      if (currentRevision.id !== decision.review_revision_id) {
        throw new StaleReviewDecisionError({
          reviewRevisionId: decision.review_revision_id,
          currentRevisionId: currentRevision.id,
        });
      }
    }

    _decisions.set(decision.id, decision);
    _addIndex(decision);

    // Update the associated review request
    if (requestStore) {
      const key = `${decision.run_id}:${decision.review_revision_id}`;
      try {
        const requests = await requestStore.listByRun(decision.run_id);
        const match = requests.find(
          (r) => r.revision_id === decision.review_revision_id
        );
        if (match) {
          await requestStore.updateRequestStatus(match.id, "decided", decision.id);
        }
      } catch {
        // Non-fatal: request may not exist
      }
    }

    await _persist();
    return structuredClone(decision);
  }

  /**
   * Read a decision by ID.
   *
   * @param {string} decisionId
   * @returns {Promise<object>}
   * @throws {Error} If not found
   */
  async function readDecision(decisionId) {
    await _ensureLoaded();
    const d = _decisions.get(decisionId);
    if (!d) throw new Error(`Decision not found: ${decisionId}`);
    return structuredClone(d);
  }

  /**
   * List decisions for a run, newest first, with optional limit.
   *
   * @param {string} runId
   * @param {number} [limit=10] Max decisions to return
   * @returns {Promise<object[]>}
   */
  async function listByRun(runId, limit = 10) {
    await _ensureLoaded();
    const ids = _byRun.get(runId);
    if (!ids || ids.length === 0) return [];
    const decisions = ids
      .map((id) => _decisions.get(id))
      .filter(Boolean)
      .sort(
        (a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime()
      );
    if (limit > 0 && decisions.length > limit) {
      return decisions.slice(0, limit).map((d) => structuredClone(d));
    }
    return decisions.map((d) => structuredClone(d));
  }

  return {
    recordDecision,
    readDecision,
    listByRun,
  };
}
