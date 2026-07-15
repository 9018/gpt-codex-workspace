/**
 * tool-capability-registry.mjs — Ephemeral execution capability registry
 *
 * Maps tool names to capability metadata consumed by the ephemeral batch
 * scheduler and execution classifier.  Accepts registration from normalized
 * tool descriptors (tool-catalog) or raw capability objects.
 *
 * @module ephemeral-execution/tool-capability-registry
 */

const READ_ONLY = [
  'health_check', 'runtime_status', 'worker_status',
  'project_context_status', 'get_repository_status',
  'read_text_file', 'stat_path', 'search_files', 'sha256_file',
  'github_status', 'get_workstream_capacity',
  'get_workstream_execution_graph', 'evaluate_workstream_join',
];

const UNKNOWN = Object.freeze({
  side_effect: 'unknown',
  idempotency: 'unknown',
  execution_class: 'durable_only',
  authority: null,
  parallel_safe: null,
  requires_lock: null,
  default_timeout_ms: 30000,
  max_timeout_ms: 120000,
  result_size_limit_bytes: 1048576,
});

/**
 * Create a tool capability registry.
 *
 * @param {object} [options]
 * @param {object[]} [options.descriptors] - Pre-populated descriptors (legacy compat)
 * @returns {object} Registry API
 */
export function createToolCapabilityRegistry({ descriptors = [] } = {}) {
  const map = new Map();
  let revision = 1;

  const api = {
    /**
     * Register a single tool capability.
     *
     * @param {string} name - Tool name
     * @param {object} [cap] - Capability fields to merge over UNKNOWN defaults
     * @returns {object} api (chainable)
     */
    register(name, cap = {}) {
      map.set(String(name), { ...UNKNOWN, ...cap });
      revision++;
      return api;
    },

    /**
     * Import normalized tool descriptors from the canonical catalog.
     * Each descriptor's metadata fields are mapped to capability fields.
     * Descriptors with no explicit metadata fields do NOT overwrite
     * existing entries, preserving defaults (e.g. READ_ONLY tools).
     * Descriptors with at least one metadata field will replace
     * the entire capability entry.
     *
     * @param {object[]} descriptors - Array of normalized tool descriptors
     * @returns {object} api (chainable)
     */
    registerFromDescriptors(descriptors) {
      if (!Array.isArray(descriptors)) return api;
      for (const d of descriptors) {
        if (!d || !d.name) continue;
        const meta = d.metadata || {};
        // Only overwrite if at least one capability field is present
        const capFields = ['side_effect', 'idempotency', 'execution_class', 'authority', 'parallel_safe', 'requires_lock'];
        const hasFields = capFields.some(f => meta[f] != null);
        if (!hasFields) continue; // Skip descriptors with no capability metadata
        const cap = {};
        if (meta.side_effect != null) cap.side_effect = meta.side_effect;
        if (meta.idempotency != null) cap.idempotency = meta.idempotency;
        if (meta.execution_class != null) cap.execution_class = meta.execution_class;
        if (meta.authority != null) cap.authority = meta.authority;
        if (meta.parallel_safe != null) cap.parallel_safe = meta.parallel_safe;
        if (meta.requires_lock != null) cap.requires_lock = meta.requires_lock;
        if (Object.keys(cap).length > 0) api.register(d.name, cap);
      }
      return api;
    },

    /**
     * Get capability metadata for a tool name.
     * Returns the UNKNOWN default when tool is not registered.
     *
     * @param {string} name
     * @returns {object}
     */
    get(name) {
      return map.get(String(name)) || UNKNOWN;
    },

    /**
     * Classify a tool by execution_class.
     * Convenience shortcut for api.get(name).execution_class.
     *
     * @param {string} name
     * @returns {string}
     */
    classify(name) {
      return api.get(name).execution_class;
    },

    /** Current revision number (increments on each register call). */
    get revision() { return revision; },
  };

  // Register default READ_ONLY tools as ephemeral_eligible
  for (const name of READ_ONLY) {
    api.register(name, {
      side_effect: 'none',
      idempotency: 'idempotent',
      execution_class: 'ephemeral_eligible',
    });
  }

  // Legacy: pre-populate from descriptors option
  if (Array.isArray(descriptors) && descriptors.length > 0) {
    api.registerFromDescriptors(descriptors);
  }

  return api;
}
