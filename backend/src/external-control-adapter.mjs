/**
 * external-control-adapter.mjs — External Control Adapter Contract & Registry.
 *
 * ## Contract
 *
 * An External Control Adapter is a pluggable integration between GPTWork core
 * state and an external control surface (e.g. GitHub Issues, a web dashboard,
 * Gitlab Issues, Linear, etc.).  Each adapter wraps an external system so it
 * can participate in three operations:
 *
 *   - **mirrorState** — Push local state (tasks, requests, status) outward.
 *   - **importState** — Pull tasks/issues from the external system inward.
 *   - **readCommands** — Read control commands (comments, labels, reactions)
 *                        from the external system and apply them locally.
 *
 * ## Principles
 *
 * 1. **External systems never replace core state.**
 *    GPTWork state store is always the source of truth. Adapters mirror,
 *    import, and read — they do not own state.
 *
 * 2. **No GitHub = full workflow.**
 *    When no adapters are enabled the system runs identically. Adapters
 *    are purely optional additive integrations.
 *
 * 3. **Graceful degradation.**
 *    If an adapter is misconfigured or its remote system is unreachable,
 *    it returns a structured error and never blocks the caller.
 *
 * @module external-control-adapter
 */

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

/**
 * Required method names on every ExternalControlAdapter object.
 * `name` (string) and `enabled` (boolean) are properties, not methods.
 */
const CONTRACT_REQUIREMENTS = [
  { key: 'name', kind: 'string', desc: 'Human-readable adapter name' },
  { key: 'enabled', kind: 'boolean', desc: 'Whether the adapter is configured to run' },
  { key: 'mirrorState', kind: 'function', desc: '(state) => Promise<{ok, count, details}>' },
  { key: 'importState', kind: 'function', desc: '(store, opts?) => Promise<{imported, skipped, diagnostics}>' },
  { key: 'readCommands', kind: 'function', desc: '(store, opts?) => Promise<{commands, imported, details}>' },
  { key: 'status', kind: 'function', desc: '() => object — adapter status info' },
];

/**
 * Validate that an object conforms to the ExternalControlAdapter contract.
 *
 * @param {object} adapter  Candidate adapter object.
 * @returns {string[]}  Array of missing requirement descriptions, empty if valid.
 */
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    return ['adapter must be a non-null object'];
  }
  const missing = [];
  for (const req of CONTRACT_REQUIREMENTS) {
    const value = adapter[req.key];
    if (req.kind === 'function') {
      if (typeof value !== 'function') missing.push(`${req.key} (must be a function)`);
    } else if (req.kind === 'string') {
      if (typeof value !== 'string') missing.push(`${req.key} (must be a string)`);
    } else if (req.kind === 'boolean') {
      if (typeof value !== 'boolean') missing.push(`${req.key} (must be a boolean)`);
    }
  }
  return missing;
}

/**
 * Create a minimal stub adapter that satisfies the contract while disabled.
 * Useful as a fallback when no real adapter is configured.
 *
 * @param {string} name  Adapter name.
 * @returns {object}  Stub adapter (always disabled, all ops no-op).
 */
export function createDisabledStubAdapter(name) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  return {
    name,
    enabled: false,
    async mirrorState() { return { ok: false, count: 0, details: { reason: `${name} not configured` } }; },
    async importState() { return { imported: [], skipped: [{ reason: `${name} not configured` }], diagnostics: {} }; },
    async readCommands() { return { commands: [], imported: [], details: { reason: `${name} not configured` } }; },
    status() { return { enabled: false, name, configured: false }; },
    getDiagnostics() { return { name, enabled: false }; },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Create an External Control Adapter Registry.
 *
 * The registry is the single point of coordination for all external control
 * surface integrations.  Adapters are registered by type and the registry
 * provides bulk operations across all enabled adapters.
 *
 * When no adapters are enabled, every bulk method returns an empty result —
 * the system runs normally without any external control surface.
 *
 * @param {object}   [options]
 * @param {boolean}  [options.allowOverwrite=false]  Allow overwriting existing adapters.
 * @returns {object}  Registry API.
 */
export function createAdapterRegistry(options = {}) {
  const { allowOverwrite = false } = options;
  /** @type {Map<string, object>} */
  const adapters = new Map();

  /** Ensure an adapter conforms to the contract before registration. */
  function _assertValid(adapter) {
    const missing = validateAdapter(adapter);
    if (missing.length > 0) {
      throw new Error(
        `Adapter contract validation failed:\n  - ${missing.join('\n  - ')}`
      );
    }
  }

  const registry = {

    /**
     * Register an adapter instance under a type identifier.
     *
     * @param {string} type     Adapter type (e.g. "github-issues", "linear").
     * @param {object} adapter  Object implementing the ExternalControlAdapter contract.
     * @returns {object}  this (registry), for chaining.
     */
    register(type, adapter) {
      if (!type || typeof type !== 'string') {
        throw new Error('Adapter type must be a non-empty string');
      }
      _assertValid(adapter);
      if (adapters.has(type) && !allowOverwrite) {
        throw new Error(`Adapter type "${type}" is already registered. Use allowOverwrite to replace.`);
      }
      if (adapters.has(type)) {
        console.warn(`[adapter-registry] Overwriting existing adapter: ${type}`);
      }
      adapters.set(type, adapter);
      return registry;
    },

    /**
     * Unregister an adapter by type.
     *
     * @param {string} type  Adapter type to remove.
     * @returns {object}  this (registry), for chaining.
     */
    unregister(type) {
      adapters.delete(type);
      return registry;
    },

    /**
     * Check whether an adapter type is registered.
     *
     * @param {string} type
     * @returns {boolean}
     */
    has(type) {
      return adapters.has(type);
    },

    /**
     * Retrieve a registered adapter by type.
     *
     * @param {string} type
     * @returns {object|null}
     */
    getAdapter(type) {
      return adapters.get(type) || null;
    },

    /**
     * List all registered adapters (type + adapter object).
     *
     * @returns {Array<{type: string, adapter: object}>}
     */
    getAllAdapters() {
      return Array.from(adapters.entries()).map(([type, adapter]) => ({ type, adapter }));
    },

    /**
     * List only adapters whose `enabled` property is true.
     *
     * @returns {Array<{type: string, adapter: object}>}
     */
    getEnabledAdapters() {
      return Array.from(adapters.entries())
        .filter(([, a]) => a.enabled)
        .map(([type, adapter]) => ({ type, adapter }));
    },

    /**
     * Mirror system state to all enabled adapters.
     *
     * Each adapter's mirrorState() is called independently. A single adapter
     * failure never propagates — it is captured in the per-adapter result.
     *
     * @param {object} state  Full GPTWork state ({ tasks, chatgpt_requests, ... }).
     * @returns {Promise<object>}  Results keyed by adapter type.
     */
    async mirrorAllState(state) {
      const results = {};
      for (const [type, adapter] of adapters) {
        if (!adapter.enabled) continue;
        try {
          results[type] = await adapter.mirrorState(state);
        } catch (err) {
          results[type] = { ok: false, count: 0, error: err.message };
        }
      }
      return results;
    },

    /**
     * Import state from all enabled adapters.
     *
     * Merges `imported` and `skipped` arrays from each adapter, tagging each
     * entry with its source adapter type. Diagnostics are kept per-adapter.
     *
     * @param {object} store   State store with load/save.
     * @param {object} [opts]  Options forwarded to each adapter's importState.
     * @returns {Promise<{imported: Array, skipped: Array, diagnostics: object}>}
     */
    async importAllState(store, opts = {}) {
      const results = { imported: [], skipped: [], diagnostics: {} };
      for (const [type, adapter] of adapters) {
        if (!adapter.enabled) continue;
        try {
          const r = await adapter.importState(store, opts);
          if (Array.isArray(r.imported)) {
            for (const item of r.imported) results.imported.push({ ...item, source_type: type });
          }
          if (Array.isArray(r.skipped)) {
            for (const item of r.skipped) results.skipped.push({ ...item, source_type: type });
          }
          results.diagnostics[type] = r.diagnostics || r;
        } catch (err) {
          results.diagnostics[type] = { error: err.message };
        }
      }
      return results;
    },

    /**
     * Read control commands from all enabled adapters.
     *
     * @param {object} store   State store.
     * @param {object} [opts]  Options forwarded to each adapter's readCommands.
     * @returns {Promise<{commands: Array, imported: Array, details: object}>}
     */
    async readAllCommands(store, opts = {}) {
      const results = { commands: [], imported: [], details: {} };
      for (const [type, adapter] of adapters) {
        if (!adapter.enabled) continue;
        try {
          const r = await adapter.readCommands(store, opts);
          if (Array.isArray(r.commands)) {
            for (const c of r.commands) results.commands.push({ ...c, source_type: type });
          }
          if (Array.isArray(r.imported)) {
            for (const i of r.imported) results.imported.push({ ...i, source_type: type });
          }
          results.details[type] = r.details || r;
        } catch (err) {
          results.details[type] = { error: err.message };
        }
      }
      return results;
    },

    /**
     * Aggregate status across all adapters.
     *
     * @returns {{ adapter_count: number, enabled_count: number, adapters: object }}
     */
    statusAll() {
      const adapterStatuses = {};
      for (const [type, adapter] of adapters) {
        try {
          adapterStatuses[type] = { enabled: adapter.enabled, ...adapter.status() };
        } catch (err) {
          adapterStatuses[type] = { enabled: adapter.enabled, error: err.message };
        }
      }
      return {
        adapter_count: adapters.size,
        enabled_count: this.getEnabledAdapters().length,
        adapters: adapterStatuses,
      };
    },

    /**
     * Collect diagnostics from all adapters that support getDiagnostics().
     *
     * @returns {object}  Diagnostics keyed by adapter type.
     */
    diagnosticsAll() {
      const diag = {};
      for (const [type, adapter] of adapters) {
        try {
          diag[type] = typeof adapter.getDiagnostics === 'function'
            ? adapter.getDiagnostics()
            : { note: 'getDiagnostics() not implemented' };
        } catch (err) {
          diag[type] = { error: err.message };
        }
      }
      return diag;
    },

    /**
     * Number of registered adapters (enabled or not).
     *
     * @type {number}
     */
    get size() {
      return adapters.size;
    },
  };

  return registry;
}
