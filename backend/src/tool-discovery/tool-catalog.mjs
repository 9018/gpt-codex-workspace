/**
 * tool-catalog.mjs — Canonical tool descriptor catalog
 *
 * Provides a read-only, deterministic searchable catalog of tool descriptors
 * normalized from the live tool registry.  No handler exposure.
 *
 * @module tool-discovery/tool-catalog
 */

import { computeToolCatalogRevision, createToolCatalogIndex } from "./tool-catalog-index.mjs";

// ---------------------------------------------------------------------------
// normalizeToolDescriptor
// ---------------------------------------------------------------------------

/**
 * Normalize a tool registry entry into a plain descriptor safe for MCP listing
 * and search.  Strips handler and any non-serializable state.
 *
 * @param {string} name - Tool name
 * @param {object} tool - Tool registry entry (from createTool)
 * @returns {object} Normalized descriptor with no handler
 */
export function normalizeToolDescriptor(name, tool) {
  const metadata = tool.metadata || {};
  return {
    name: metadata.name || name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
    tags: Array.isArray(metadata.tags) ? [...metadata.tags] : [],
    audience: Array.isArray(metadata.audience) ? [...metadata.audience] : [],
    modes: Array.isArray(metadata.modes) ? [...metadata.modes] : [],
    // Include lightweight annotations (side_effect, idempotency, etc.) without handler refs
    metadata: {
      side_effect: metadata.annotations?.side_effect || null,
      idempotency: metadata.annotations?.idempotency || null,
      execution_class: metadata.annotations?.execution_class || null,
      authority: metadata.annotations?.authority || null,
      parallel_safe: metadata.annotations?.parallel_safe ?? null,
      requires_lock: metadata.annotations?.requires_lock ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// createToolCatalog
// ---------------------------------------------------------------------------

/**
 * Create a read-only searchable catalog from a map of tool registry entries.
 *
 * @param {Record<string, object>} tools - Map of tool name -> tool descriptor from createTool
 * @returns {object} Catalog with list(), get(name), and search(query, options)
 */
export function createToolCatalog(tools) {
  /** Pre-computed descriptors for O(1) lookup and O(n) listing. */
  const descriptors = new Map();

  for (const [name, tool] of Object.entries(tools)) {
    descriptors.set(name, normalizeToolDescriptor(name, tool));
  }
  const lightweightIndex = createToolCatalogIndex(Array.from(descriptors.values()));
  const revision = computeToolCatalogRevision(lightweightIndex);

  /**
   * Simple tokenizer that splits on word boundaries and lowercases.
   *
   * @param {string} text
   * @returns {string[]}
   */
  function tokenize(text) {
    return String(text)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean);
  }

  /**
   * Compute a simple weighted relevance score for a descriptor against a set
   * of query tokens.
   *
   * Scoring weights:
   *   - name exact match       +10
   *   - name prefix match       +5
   *   - name token match        +3
   *   - tag match               +2
   *   - description match       +1
   *   - audience match          +0.5
   *   - mode match              +0.5
   *
   * @param {object} desc
   * @param {string[]} queryTokens
   * @returns {number}
   */
  function scoreDescriptor(desc, queryTokens) {
    let score = 0;
    const name = String(desc.name).toLowerCase();
    const descText = String(desc.description).toLowerCase();
    const tagTexts = (desc.tags || []).map(t => String(t).toLowerCase());
    const audienceTexts = (desc.audience || []).map(a => String(a).toLowerCase());
    const modeTexts = (desc.modes || []).map(m => String(m).toLowerCase());

    for (const qt of queryTokens) {
      // Exact name match
      if (name === qt) score += 10;
      // Name prefix match
      if (name.startsWith(qt)) score += 5;
      // Name contains token
      if (name.includes(qt)) score += 3;
      // Tag match
      if (tagTexts.some(t => t === qt || t.includes(qt))) score += 2;
      // Description match
      if (descText.includes(qt)) score += 1;
      // Audience match
      if (audienceTexts.some(a => a === qt || a.includes(qt))) score += 0.5;
      // Mode match
      if (modeTexts.some(m => m === qt || m.includes(qt))) score += 0.5;
    }

    return score;
  }

  /**
   * Apply audience/mode/tags filters to a descriptor.
   *
   * @param {object} desc
   * @param {{ audience?: string, mode?: string, tags?: string[] }} filters
   * @returns {boolean}
   */
  function matchesFilters(desc, filters = {}) {
    if (filters.audience) {
      const target = String(filters.audience).toLowerCase();
      if (!desc.audience.some(a => String(a).toLowerCase() === target)) return false;
    }

    if (filters.mode) {
      const target = String(filters.mode).toLowerCase();
      if (!desc.modes.some(m => String(m).toLowerCase() === target)) return false;
    }

    if (Array.isArray(filters.tags) && filters.tags.length > 0) {
      const filterTags = filters.tags.map(t => String(t).toLowerCase());
      const descTags = desc.tags.map(t => String(t).toLowerCase());
      if (!filterTags.some(ft => descTags.includes(ft))) return false;
    }

    return true;
  }

  return {
    revision,

    index() {
      return lightweightIndex.map((entry) => ({ ...entry }));
    },

    /**
     * List all catalog entries (preserves insertion order).
     *
     * @returns {object[]}
     */
    list() {
      return Array.from(descriptors.values());
    },

    /**
     * Get a single descriptor by name.
     *
     * @param {string} name
     * @returns {object|undefined}
     */
    get(name) {
      return descriptors.get(name);
    },

    /**
     * Search the catalog with optional filters.
     *
     * Results are scored by relevance, filtered by audience/mode/tags,
     * and bounded by limit.
     *
     * @param {string} query - Free-text search query (empty matches all)
     * @param {object} [options]
     * @param {number}  [options.limit]    - Max results (default unlimited)
     * @param {string}  [options.audience] - Filter by audience
     * @param {string}  [options.mode]     - Filter by mode
     * @param {string[]} [options.tags]    - Filter by tags (any match)
     * @returns {object[]} Ranked descriptors (no handlers)
     */
    search(query, options = {}) {
      const { limit, audience, mode, tags } = options;
      const queryTokens = tokenize(query || '');
      const all = Array.from(descriptors.values());

      // Score and filter
      const scored = [];
      for (const desc of all) {
        if (!matchesFilters(desc, { audience, mode, tags })) continue;
        const score = queryTokens.length > 0 ? scoreDescriptor(desc, queryTokens) : 1;
        if (score > 0 || queryTokens.length === 0) {
          scored.push({ desc, score });
        }
      }

      // Sort by score descending, then name ascending for determinism
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.desc.name).localeCompare(String(b.desc.name));
      });

      // Bounded results
      const maxResults = Number.isFinite(limit) ? Math.max(1, Math.min(Number(limit), 200)) : scored.length;
      const results = scored.slice(0, maxResults).map(entry => entry.desc);

      return results;
    },
  };
}
