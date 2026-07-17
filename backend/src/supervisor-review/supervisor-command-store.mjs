/**
 * supervisor-command-store.mjs — Durable SupervisorCommand store.
 *
 * Manages the lifecycle of SupervisorCommands with CAS-based state
 * transitions, idempotency key dedup, and expired claim reclamation.
 *
 * States: pending → claimed → applying → applied
 *                                          → retryable_failed
 *                                          → terminal_failed
 *         pending → superseded
 *         claimed → superseded
 *
 * @module supervisor-review/supervisor-command-store
 */

import { commandFromDecision } from "./supervisor-command-schema.mjs";

/** States that are still pending or in-flight. */
const ACTIVE_STATES = new Set(["pending", "claimed", "applying"]);

const now = () => new Date().toISOString();

/**
 * Create the Command store.
 *
 * @param {object} [options]
 * @param {Function} [options.now] - Timestamp generator
 * @param {object} [options.stateStore] - Optional durable state-store
 * @returns {object} Store API
 */
export function createCommandStore({ now: _now, stateStore } = {}) {
  const ts = _now || now;
  /** Map: command.id -> command */
  const _commands = new Map();
  /** Index: idempotency_key -> command.id */
  const _idempotencyIndex = new Map();
  /** Index: run_id -> Set<command.id> */
  const _byRun = new Map();

  let _initPromise = null;

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.supervisor_commands) {
      for (const cmd of state.supervisor_commands) {
        _commands.set(cmd.id, cmd);
        _addIndexes(cmd);
      }
    }
  }

  function _addIndexes(cmd) {
    if (cmd.idempotency_key) {
      _idempotencyIndex.set(cmd.idempotency_key, cmd.id);
    }
    if (!_byRun.has(cmd.run_id)) _byRun.set(cmd.run_id, new Set());
    _byRun.get(cmd.run_id).add(cmd.id);
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.supervisor_commands = Array.from(_commands.values());
    });
  }

  async function _ensureLoaded() {
    if (!_initPromise) {
      _initPromise = _loadPersisted().catch(() => {});
    }
    await _initPromise.catch(() => {});
  }

  /**
   * Create a command from a decision and run.
   * Idempotent: same idempotency key returns the existing command.
   *
   * @param {object} decision - Normalized SupervisorDecision
   * @param {object} run - ExecutionRun
   * @returns {Promise<object>} Command
   */
  async function createFromDecision(decision, run) {
    await _ensureLoaded();
    const cmd = commandFromDecision(decision, run);

    // Check idempotency
    const existingId = _idempotencyIndex.get(cmd.idempotency_key);
    if (existingId) {
      return structuredClone(_commands.get(existingId));
    }

    _commands.set(cmd.id, cmd);
    _addIndexes(cmd);
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * Claim the next available pending command.
   * Only one worker should succeed per command.
   *
   * @param {object} options
   * @param {string} options.workerId
   * @param {number} [options.leaseMs=30000]
   * @returns {Promise<object|null>} Claimed command or null
   */
  async function claimNext({ workerId, leaseMs = 30000 }) {
    await _ensureLoaded();

    for (const cmd of _commands.values()) {
      if (cmd.status !== "pending") continue;

      // Check if claim is expired
      if (cmd.claimed_by && cmd.claim_expires_at) {
        const nowMs = Date.now();
        const expireMs = new Date(cmd.claim_expires_at).getTime();
        if (nowMs < expireMs) continue;
      }

      cmd.status = "claimed";
      cmd.claimed_by = workerId;
      cmd.claim_expires_at = new Date(Date.now() + leaseMs).toISOString();
      cmd.attempt += 1;
      cmd.updated_at = ts();

      await _persist();
      return structuredClone(cmd);
    }

    return null;
  }

  /**
   * Mark a command as applying.
   *
   * @param {string} commandId
   * @returns {Promise<object>}
   */
  async function markApplying(commandId) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);

    cmd.status = "applying";
    cmd.updated_at = ts();
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * Mark a command as applied with result.
   *
   * @param {string} commandId
   * @param {object} result
   * @returns {Promise<object>}
   */
  async function markApplied(commandId, result) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);

    cmd.status = "applied";
    cmd.result = structuredClone(result);
    cmd.updated_at = ts();
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * Mark a command as retryable failure.
   *
   * @param {string} commandId
   * @param {object} failure
   * @returns {Promise<object>}
   */
  async function markRetryableFailure(commandId, failure) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);

    cmd.status = "retryable_failed";
    cmd.failure = structuredClone(failure);
    cmd.updated_at = ts();
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * Mark a command as terminal failure.
   *
   * @param {string} commandId
   * @param {object} failure
   * @returns {Promise<object>}
   */
  async function markTerminalFailure(commandId, failure) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);

    cmd.status = "terminal_failed";
    cmd.failure = structuredClone(failure);
    cmd.updated_at = ts();
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * Mark a command as superseded (e.g., by a newer revision).
   *
   * @param {string} commandId
   * @param {string} reason
   * @returns {Promise<object>}
   */
  async function markSuperseded(commandId, reason) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);

    cmd.status = "superseded";
    cmd.failure = { reason };
    cmd.updated_at = ts();
    await _persist();
    return structuredClone(cmd);
  }

  /**
   * List pending or in-flight commands for a run.
   *
   * @param {string} runId
   * @returns {Promise<object[]>}
   */
  async function listPendingByRun(runId) {
    await _ensureLoaded();
    const ids = _byRun.get(runId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => _commands.get(id))
      .filter((cmd) => cmd && ACTIVE_STATES.has(cmd.status))
      .map((cmd) => structuredClone(cmd));
  }

  /**
   * Read a command by ID.
   *
   * @param {string} commandId
   * @returns {Promise<object>}
   */
  async function readCommand(commandId) {
    await _ensureLoaded();
    const cmd = _commands.get(commandId);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);
    return structuredClone(cmd);
  }

  /**
   * Reclaim expired claims, returning them to pending state.
   *
   * @returns {Promise<object[]>} List of reclaimed commands
   */
  async function reclaimExpired() {
    await _ensureLoaded();
    const reclaimed = [];
    const nowMs = Date.now();

    for (const cmd of _commands.values()) {
      if (cmd.status !== "claimed") continue;
      if (!cmd.claim_expires_at) continue;

      const expireMs = new Date(cmd.claim_expires_at).getTime();
      if (nowMs < expireMs) continue;

      cmd.status = "pending";
      cmd.claimed_by = null;
      cmd.claim_expires_at = null;
      cmd.updated_at = ts();
      reclaimed.push(structuredClone(cmd));
    }

    if (reclaimed.length > 0) {
      await _persist();
    }

    return reclaimed;
  }

  return {
    createFromDecision,
    claimNext,
    markApplying,
    markApplied,
    markRetryableFailure,
    markTerminalFailure,
    markSuperseded,
    listPendingByRun,
    readCommand,
    reclaimExpired,
  };
}
