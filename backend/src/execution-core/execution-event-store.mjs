/**
 * execution-event-store.mjs — Append-only event store for ExecutionEvents.
 *
 * Events are immutable once written.  The store supports filtering by
 * run_id, type, severity, time range, and idempotent append via
 * idempotency_key.
 *
 * @module execution-event-store
 */

import { createExecutionEvent } from "./execution-event-schema.mjs";

/**
 * Create an in-memory, append-only event store with optional persistence.
 *
 * @param {object} [options]
 * @param {object} [options.stateStore] - Optional durable state-store for persistence
 * @returns {object} Store API
 */
export function createExecutionEventStore({ stateStore } = {}) {
  /** @type {Array<object>} */
  const _events = [];
  /** Index: idempotency_key -> event */
  const _idempotencyIndex = new Map();

  /**
   * Load persisted events from stateStore if available.
   */
  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.execution_events) {
      for (const event of state.execution_events) {
        _events.push(event);
        if (event.idempotency_key) {
          _idempotencyIndex.set(event.idempotency_key, event.id);
        }
      }
    }
  }

  /**
   * Persist current events to stateStore if available.
   */
  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.execution_events = [..._events];
      state.execution_event_index = Object.fromEntries(_idempotencyIndex);
    });
  }

  // Load persisted state on creation
  const _initPromise = _loadPersisted().catch(() => {});
  async function _ensureLoaded() { await _initPromise.catch(() => {}); }

  /**
   * Append an event to the store.  Idempotent if idempotency_key is provided
   * and that key already exists.
   *
   * @param {object} input - Event fields (see createExecutionEvent)
   * @returns {Promise<object>} The created event (cloned)
   */
  async function appendEvent(input) { await _ensureLoaded();
    // Check idempotency
    if (input.idempotency_key) {
      const existingId = _idempotencyIndex.get(input.idempotency_key);
      if (existingId) {
        const existing = _events.find((e) => e.id === existingId);
        if (existing) return structuredClone(existing);
      }
    }

    const event = createExecutionEvent(input);
    _events.push(structuredClone(event));

    if (event.idempotency_key) {
      _idempotencyIndex.set(event.idempotency_key, event.id);
    }

    await _persist();
    return structuredClone(event);
  }

  /**
   * Read a single event by ID.
   *
   * @param {string} eventId
   * @returns {Promise<object>} The event
   * @throws {Error} If not found
   */
  async function readEvent(eventId) { await _ensureLoaded();
    const event = _events.find((e) => e.id === eventId);
    if (!event) {
      throw new Error(`ExecutionEvent not found: ${eventId}`);
    }
    return structuredClone(event);
  }

  /**
   * Query events with optional filters.  Results are returned
   * in insertion order (oldest first).
   *
   * @param {object} [filters]
   * @param {string} [filters.run_id]
   * @param {string|string[]} [filters.type]
   * @param {string|string[]} [filters.severity]
   * @param {number} [filters.limit] - Max events to return
   * @param {string} [filters.from] - ISO timestamp (inclusive)
   * @param {string} [filters.to] - ISO timestamp (inclusive)
   * @returns {Promise<object[]>} Array of event clones
   */
  async function queryEvents(filters = {}) { await _ensureLoaded();
    let results = _events;

    if (filters.run_id) {
      results = results.filter((e) => e.run_id === filters.run_id);
    }
    if (filters.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      results = results.filter((e) => types.includes(e.type));
    }
    if (filters.severity) {
      const severities = Array.isArray(filters.severity) ? filters.severity : [filters.severity];
      results = results.filter((e) => severities.includes(e.severity));
    }
    if (filters.from) {
      results = results.filter((e) => e.created_at >= filters.from);
    }
    if (filters.to) {
      results = results.filter((e) => e.created_at <= filters.to);
    }

    if (filters.limit && filters.limit > 0) {
      results = results.slice(0, filters.limit);
    }

    return results.map((e) => structuredClone(e));
  }

  /**
   * Return the total number of events stored.
   * @returns {number}
   */
  async function count() {
    await _ensureLoaded();
    return _events.length;
  }

  return {
    appendEvent,
    readEvent,
    queryEvents,
    count,
  };
}
