/**
 * supervisor-controller-lease.mjs — Controller lease with CAS ownership.
 *
 * Manages which controller (Codex, ChatGPT, or none) holds the write
 * lease for a given ExecutionRun. Ownership changes are CAS-based and
 * must follow legal state transitions.
 *
 * Legal transitions:
 *   codex_active -> codex_quiescing -> chatgpt_supervising -> chatgpt_direct
 *   chatgpt_direct -> handoff_to_codex -> codex_active
 *   * -> none
 *
 * @module supervisor-review/supervisor-controller-lease
 */

/** Allowed controller owner values. */
export const CONTROLLER_OWNERS = Object.freeze([
  "codex_active",
  "codex_quiescing",
  "chatgpt_supervising",
  "chatgpt_direct",
  "handoff_to_codex",
  "none",
]);

/** Default owner when no lease exists. */
const DEFAULT_OWNER = "codex_active";

/** Map of legal transitions: currentOwner -> Set<nextOwner> */
const LEGAL_TRANSITIONS = {
  codex_active: new Set(["codex_quiescing", "none"]),
  codex_quiescing: new Set(["chatgpt_supervising", "codex_active", "none"]),
  chatgpt_supervising: new Set(["chatgpt_direct", "codex_quiescing", "none"]),
  chatgpt_direct: new Set(["handoff_to_codex", "none"]),
  handoff_to_codex: new Set(["codex_active", "none"]),
  none: new Set(["codex_active"]),
};

const now = () => new Date().toISOString();

/**
 * Create a controller lease manager.
 *
 * @param {object} [options]
 * @param {Function} [options.now] - Timestamp generator
 * @returns {object} Lease API
 */
export function createControllerLease({ now: _now } = {}) {
  const ts = _now || now;
  /** Map: run_id -> lease state */
  const _leases = new Map();

  function _ensureLease(runId) {
    if (!_leases.has(runId)) {
      _leases.set(runId, {
        run_id: runId,
        owner: DEFAULT_OWNER,
        holder_id: null,
        epoch: 0,
        acquired_at: ts(),
        expires_at: null,
        worktree_path: null,
        session_id: null,
        native_session_id: null,
      });
    }
    return _leases.get(runId);
  }

  /**
   * Get the current lease state for a run.
   * Creates a default lease if none exists.
   *
   * @param {string} runId
   * @returns {Promise<object>}
   */
  async function getLease(runId) {
    return structuredClone(_ensureLease(runId));
  }

  /**
   * Set owner with CAS (compare-and-swap).
   * Only succeeds if current owner matches expectedOwner and
   * the transition is legally allowed.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.expectedOwner - Must match current owner
   * @param {string} options.nextOwner - Target owner
   * @param {number} [options.expectedEpoch] - If set, must match current epoch
   * @param {string} [options.holderId] - New holder identifier
   * @param {string} [options.worktreePath] - Worktree path
   * @param {string} [options.sessionId] - Session ID
   * @param {string} [options.nativeSessionId] - Native session ID
   * @returns {Promise<boolean>} true if ownership changed
   */
  async function compareAndSetOwner({
    runId,
    expectedOwner,
    nextOwner,
    expectedEpoch,
    holderId,
    worktreePath,
    sessionId,
    nativeSessionId,
  }) {
    const lease = _ensureLease(runId);

    // Check expected owner
    if (lease.owner !== expectedOwner) return false;

    // Check expected epoch if provided
    if (expectedEpoch !== undefined && lease.epoch !== expectedEpoch) return false;

    // Check legal transition
    const allowed = LEGAL_TRANSITIONS[lease.owner];
    if (!allowed || !allowed.has(nextOwner)) return false;

    // Apply transition
    lease.owner = nextOwner;
    lease.epoch += 1;
    lease.acquired_at = ts();
    if (holderId !== undefined) lease.holder_id = holderId;
    if (worktreePath !== undefined) lease.worktree_path = worktreePath;
    if (sessionId !== undefined) lease.session_id = sessionId;
    if (nativeSessionId !== undefined) lease.native_session_id = nativeSessionId;

    return true;
  }

  /**
   * List all leases where owner is not "none".
   *
   * @returns {Promise<object[]>}
   */
  async function listActiveLeases() {
    return Array.from(_leases.values())
      .filter((l) => l.owner !== "none")
      .map((l) => structuredClone(l));
  }

  return {
    getLease,
    compareAndSetOwner,
    listActiveLeases,
  };
}
