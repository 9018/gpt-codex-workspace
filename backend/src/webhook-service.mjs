/**
 * webhook-service.mjs — Webhook Registry & Reservation Contract.
 *
 * ## Purpose
 *
 * Provides the webhook infrastructure contract for GPTWork.  Webhooks allow
 * external systems (including GitHub, GitLab, Linear, etc.) to push state
 * changes to the server asynchronously.
 *
 * ## Current Status
 *
 * **Reservation layer only.**  No HTTP endpoint, no signature verification,
 * no production webhook listener is implemented.  This module defines:
 *
 *   1. The webhook registry contract (register, dispatch, inspect).
 *   2. Reserved event names that future implementations will handle.
 *   3. A factory to create isolated webhook registries.
 *
 * ## Future (not yet implemented)
 *
 *   - GitHub webhook endpoint:  POST /api/webhooks/github
 *   - Signature verification (HMAC-SHA256 for GitHub, secret per event).
 *   - Auto-registration of webhook subscriptions via GitHub API.
 *
 * @module webhook-service
 */

// ---------------------------------------------------------------------------
// Reserved webhook event names
// ---------------------------------------------------------------------------

/**
 * Reserved webhook event names.
 *
 * These events define the contract between external systems and GPTWork.
 * Actual webhook endpoints and signature verification will be implemented
 * in a future milestone.
 *
 * @enum {string}
 * @readonly
 */
export const RESERVED_WEBHOOK_EVENTS = Object.freeze({
  // --- GitHub events (reserved for future GitHub webhook endpoint) ---

  /** GitHub "issues" event — issue opened, closed, edited, labeled, etc. */
  GITHUB_ISSUES: 'github:issues',

  /** GitHub "issue_comment" event — comment created, edited, deleted. */
  GITHUB_ISSUE_COMMENT: 'github:issue_comment',

  /** GitHub webhook ping (verification). */
  GITHUB_PING: 'github:ping',

  // --- Generic system events ---

  /** A task in GPTWork was updated (status change, comment added, etc.). */
  TASK_UPDATED: 'task:updated',

  /** A goal in GPTWork was updated. */
  GOAL_UPDATED: 'goal:updated',

  /** System health-check probe. */
  HEALTH_CHECK: 'system:health_check',
});

// ---------------------------------------------------------------------------
// Webhook registry
// ---------------------------------------------------------------------------

/**
 * Create a webhook handler registry.
 *
 * External systems or adapters register handlers for specific event names.
 * When a webhook payload arrives (via a future HTTP endpoint), the registry
 * dispatches it to all registered handlers for the matching event.
 *
 * @param {object}   [options]
 * @param {boolean}  [options.allowDuplicateHandlers=false]
 *   Allow the same handler function reference to be registered twice.
 * @returns {object}  Webhook registry API.
 */
export function createWebhookRegistry(options = {}) {
  const { allowDuplicateHandlers = false } = options;
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();

  const registry = {

    /**
     * Register a handler for a webhook event.
     *
     * @param {string}   event    Event name (use RESERVED_WEBHOOK_EVENTS or custom).
     * @param {Function} handler  Async handler: (payload, context) => Promise<any>.
     * @returns {object}  this (registry), for chaining.
     */
    on(event, handler) {
      if (!event || typeof event !== 'string') {
        throw new Error('Webhook event name must be a non-empty string');
      }
      if (typeof handler !== 'function') {
        throw new Error('Webhook handler must be a function');
      }
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      const list = handlers.get(event);
      if (!allowDuplicateHandlers && list.indexOf(handler) !== -1) {
        return registry; // silently ignore duplicate
      }
      list.push(handler);
      return registry;
    },

    /**
     * Remove a previously registered handler.
     *
     * @param {string}   event    Event name.
     * @param {Function} handler  Handler function reference to remove.
     * @returns {object}  this (registry), for chaining.
     */
    off(event, handler) {
      if (!handlers.has(event)) return registry;
      const list = handlers.get(event);
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) handlers.delete(event);
      return registry;
    },

    /**
     * Dispatch a webhook event to all registered handlers.
     *
     * Each handler runs independently. A single handler failure never
     * propagates — it is captured in the per-handler result.
     *
     * @param {string} event    Event name.
     * @param {object} payload  Event payload (typically parsed JSON body).
     * @param {object} [context]  Optional server/request context.
     * @returns {Promise<{ event: string, dispatched: number, succeeded: number, results: Array }>}
     */
    async dispatch(event, payload, context = {}) {
      const list = handlers.get(event) || [];
      const results = [];
      let succeeded = 0;
      for (const handler of list) {
        try {
          const result = await handler(payload, context);
          results.push({ handler: handler.name || 'anonymous', ok: true, result });
          succeeded++;
        } catch (err) {
          results.push({ handler: handler.name || 'anonymous', ok: false, error: err.message });
        }
      }
      return {
        event,
        dispatched: list.length,
        succeeded,
        results,
      };
    },

    /**
     * List all registered event types.
     *
     * @returns {string[]}
     */
    getEvents() {
      return Array.from(handlers.keys());
    },

    /**
     * Get the number of handlers registered for an event.
     *
     * @param {string} event
     * @returns {number}
     */
    handlerCount(event) {
      return (handlers.get(event) || []).length;
    },

    /**
     * Check whether any handlers are registered for an event.
     *
     * @param {string} event
     * @returns {boolean}
     */
    hasHandlers(event) {
      return handlers.has(event) && handlers.get(event).length > 0;
    },

    /**
     * Total number of handler functions across all events.
     *
     * @type {number}
     */
    get totalHandlers() {
      let count = 0;
      for (const list of handlers.values()) count += list.length;
      return count;
    },

    /**
     * Number of distinct event types with at least one handler.
     *
     * @type {number}
     */
    get eventCount() {
      return handlers.size;
    },
  };

  return registry;
}

// ---------------------------------------------------------------------------
// Convenience: create a default GPTWork webhook registry
// ---------------------------------------------------------------------------

/**
 * Create the default GPTWork webhook registry, pre-registering a no-op
 * handler for each reserved event (so that dispatch is always at least
 * self-documenting and never fails from "no handlers").
 *
 * @returns {object}  Webhook registry with reserved stubs.
 */
export function createDefaultWebhookRegistry() {
  const registry = createWebhookRegistry();

  // Register self-documenting no-op stubs for every reserved event.
  for (const [key, eventName] of Object.entries(RESERVED_WEBHOOK_EVENTS)) {
    registry.on(eventName, async function _reservedWebhookStub(payload) {
      console.debug(
        `[webhook] ${eventName} received but no handler registered. ` +
        `Payload keys: ${Object.keys(payload || {}).join(', ')}`
      );
      return { handled: false, event: eventName, note: 'no-op stub (reserved)' };
    });
  }

  return registry;
}
