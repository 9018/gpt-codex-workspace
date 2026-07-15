/**
 * tool-discovery-tools-group.mjs — MCP delayed discovery tools
 *
 * Provides read-only tool_search and tool_describe tools that query the
 * canonical tool descriptor catalog.  Always visible regardless of mode.
 * Never expose handlers or invoke tools.
 *
 * @module tool-groups/tool-discovery-tools-group
 */

/**
 * Create the tool discovery tool group.
 *
 * The catalog argument must implement { search(query, opts), get(name), list() }
 * as returned by createToolCatalog.
 *
 * @param {object} deps
 * @param {Function} deps.tool       - createTool wrapper
 * @param {Function} deps.schema     - schema builder
 * @param {object}   deps.catalog    - Canonical tool descriptor catalog
 * @returns {object} Tool map { tool_search, tool_describe }
 */
export function createToolDiscoveryToolsGroup({ tool, schema, catalog }) {
  return {
    tool_search: tool({
      name: 'tool_search',
      description: 'Search the canonical tool catalog. Returns ranked, bounded tool descriptors without exposing handlers. Supports filtering by audience, mode, and tags. Use this to discover available capabilities before invoking them.',
      inputSchema: schema({
        query: { type: 'string', description: 'Free-text search query. Empty returns all tools.' },
        limit: { type: 'integer', description: 'Maximum results (1-200).', minimum: 1, maximum: 200, default: 50 },
        audience: { type: 'string', description: 'Filter by audience (chatgpt, operator, codex, worker).' },
        mode: { type: 'string', description: 'Filter by tool mode (minimal, standard, operator, codex, full).' },
        tags: { type: 'string', description: 'Filter by tags (comma-separated, any match).' },
        include_schema: { type: 'boolean', description: 'Include inputSchema in results.', default: false },
      }),
      modes: ['standard', 'operator', 'codex', 'full'],
      audience: ['chatgpt', 'codex', 'operator', 'worker'],
      tags: ['system', 'discovery'],
      handler: async ({ query, limit, audience, mode, tags, include_schema } = {}) => {
        const parsedTags = typeof tags === 'string' && tags.trim()
          ? tags.split(',').map(t => t.trim()).filter(Boolean)
          : undefined;

        const results = catalog.search(query || '', {
          limit: limit != null ? Number(limit) : undefined,
          audience: audience || undefined,
          mode: mode || undefined,
          tags: parsedTags,
        });

        // Optionally strip schema
        let tools = include_schema ? results : results.map(d => {
          const { inputSchema, ...rest } = d;
          return rest;
        });

        // Strip any residual metadata.handler and ensure safety
        tools = tools.map(d => {
          const safe = { ...d };
          delete safe.handler;
          return safe;
        });

        return {
          tools,
          count: tools.length,
          query: query || '',
        };
      },
    }),

    tool_describe: tool({
      name: 'tool_describe',
      description: 'Retrieve full descriptors for one or more named tools from the canonical catalog. Returns found descriptors plus not_found names. Use this to inspect tool schemas before invocation.',
      inputSchema: schema({
        names: { type: 'string', description: 'Comma-separated tool names to describe, or a JSON array.' },
        include_schema: { type: 'boolean', description: 'Include inputSchema in results.', default: false },
      }),
      modes: ['standard', 'operator', 'codex', 'full'],
      audience: ['chatgpt', 'codex', 'operator', 'worker'],
      tags: ['system', 'discovery'],
      handler: async ({ names, include_schema } = {}) => {
        // Parse names: JSON array or comma-separated string
        let nameList = [];
        if (typeof names === 'string' && names.trim()) {
          try {
            nameList = JSON.parse(names);
            if (!Array.isArray(nameList)) nameList = [names];
          } catch {
            nameList = names.split(',').map(n => n.trim()).filter(Boolean);
          }
        } else if (Array.isArray(names)) {
          nameList = names;
        }

        const found = [];
        const notFound = [];

        for (const n of nameList) {
          const desc = catalog.get(n);
          if (desc) {
            const safe = { ...desc };
            delete safe.handler;
            if (!include_schema) delete safe.inputSchema;
            found.push(safe);
          } else {
            notFound.push(n);
          }
        }

        return {
          tools: found,
          found: found.length,
          not_found: notFound,
        };
      },
    }),
  };
}
