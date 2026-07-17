/**
 * supervisor-review-request-store.mjs — Durable Review Request store.
 *
 * Holds the state of each review request through its lifecycle:
 * pending → claimed → decided | superseded | failed.
 * Enforces UNIQUE(run_id, revision_id) so the same revision
 * never gets reviewed twice.
 *
 * @module supervisor-review/supervisor-review-request-store
 */

import { randomUUID } from "node:crypto";

/** Allowed review request states. */
export const REVIEW_REQUEST_STATES = Object.freeze([
  "pending",
  "claimed",
  "decided",
  "superseded",
  "failed",
]);

const now = () => new Date().toISOString();

/**
 * Create the Review Request store.
 *
 * @param {object} [options]
 * @param {Function} [options.now] - Timestamp generator
 * @param {object} [options.stateStore] - Optional durable state-store
 * @returns {object} Store API
 */
export function createReviewRequestStore({ now: _now, stateStore } = {}) {
  const ts = _now || now;
  /** Map: request.id -> request */
  const _requests = new Map();
  /** Index: run_id -> Set<request.id> */
  const _byRun = new Map();
  /** Index: `${run_id}:${revision_id}` -> request.id */
  const _uniqueIndex = new Map();

  let _initPromise = null;

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.supervisor_review_requests) {
      for (const req of state.supervisor_review_requests) {
        _requests.set(req.id, req);
        _addIndexes(req);
      }
    }
  }

  function _addIndexes(req) {
    if (!_byRun.has(req.run_id)) _byRun.set(req.run_id, new Set());
    _byRun.get(req.run_id).add(req.id);
    _uniqueIndex.set(`${req.run_id}:${req.revision_id}`, req.id);
  }

  function _removeIndexes(req) {
    _byRun.get(req.run_id)?.delete(req.id);
    _uniqueIndex.delete(`${req.run_id}:${req.revision_id}`);
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.supervisor_review_requests = Array.from(_requests.values());
    });
  }

  async function _ensureLoaded() {
    if (!_initPromise) {
      _initPromise = _loadPersisted().catch(() => {});
    }
    await _initPromise.catch(() => {});
  }

  /**
   * Get an existing review request or create a new one.
   * Idempotent for same (run_id, revision_id).
   *
   * @param {object} input
   * @param {string} input.runId
   * @param {object} input.packet - SupervisorReviewPacket
   * @returns {Promise<object>} ReviewRequest
   */
  async function getOrCreate({ runId, packet }) {
    await _ensureLoaded();
    const key = `${runId}:${packet.revision.id}`;
    const existingId = _uniqueIndex.get(key);
    if (existingId) {
      return structuredClone(_requests.get(existingId));
    }

    const req = {
      id: `review_${runId}_${packet.revision.id}`,
      run_id: runId,
      revision_id: packet.revision.id,
      packet: structuredClone(packet),
      status: "pending",
      claim_owner: null,
      claim_expires_at: null,
      decision_id: null,
      attempts: 0,
      created_at: ts(),
      updated_at: ts(),
    };

    _requests.set(req.id, req);
    _addIndexes(req);
    await _persist();
    return structuredClone(req);
  }

  /**
   * Claim a pending review request. Returns null if already claimed or
   * does not exist.
   *
   * @param {object} input
   * @param {string} input.runId
   * @param {string} input.revisionId
   * @param {string} input.workerId
   * @param {number} [input.leaseMs=30000] - Lease duration in ms
   * @returns {Promise<object|null>} Claimed request or null
   */
  async function claim({ runId, revisionId, workerId, leaseMs = 30000 }) {
    await _ensureLoaded();
    const key = `${runId}:${revisionId}`;
    const existingId = _uniqueIndex.get(key);
    if (!existingId) return null;

    const req = _requests.get(existingId);
    if (req.status !== "pending") return null;

    // Check if claim is expired
    if (req.claim_owner && req.claim_expires_at) {
      const nowMs = Date.now();
      const expireMs = new Date(req.claim_expires_at).getTime();
      if (nowMs < expireMs) return null;
    }

    const newExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    req.status = "claimed";
    req.claim_owner = workerId;
    req.claim_expires_at = newExpiresAt;
    req.attempts += 1;
    req.updated_at = ts();

    await _persist();
    return structuredClone(req);
  }

  /**
   * Update the status of a review request (used by decision store).
   *
   * @param {string} requestId
   * @param {string} status
   * @param {string} [decisionId]
   */
  async function updateRequestStatus(requestId, status, decisionId = null) {
    await _ensureLoaded();
    const req = _requests.get(requestId);
    if (!req) throw new Error(`Review request not found: ${requestId}`);

    req.status = status;
    if (decisionId) req.decision_id = decisionId;
    req.updated_at = ts();
    await _persist();
  }

  /**
   * Read a request by ID.
   *
   * @param {string} requestId
   * @returns {Promise<object>}
   */
  async function readRequest(requestId) {
    await _ensureLoaded();
    const req = _requests.get(requestId);
    if (!req) throw new Error(`Review request not found: ${requestId}`);
    return structuredClone(req);
  }

  /**
   * List pending requests for a run.
   *
   * @param {string} runId
   * @returns {Promise<object[]>}
   */
  async function listByRun(runId) {
    await _ensureLoaded();
    const ids = _byRun.get(runId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => _requests.get(id))
      .filter(Boolean)
      .map((r) => structuredClone(r));
  }

  return {
    getOrCreate,
    claim,
    updateRequestStatus,
    readRequest,
    listByRun,
  };
}
