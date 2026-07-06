/**
 * product-status-tools-group.mjs — Product-level operator dashboard tool.
 *
 * Single tool: product_status — compact summary of runtime, worker, queue,
 * review, retention, and TUI diagnostics.
 *
 * This is the primary "what's going on" command for operators and codex
 * agents that replaces reading 10+ individual tool results.
 */

import { collectProductStatus } from "../product-status-view.mjs";

/**
 * @param {object} deps
 * @param {Function} deps.tool          — MCP tool factory from tool-registry.mjs
 * @param {Function} deps.schema        — schema factory from mcp-tooling.mjs
 * @param {object}   deps.store         — StateStore instance
 * @param {object}   deps.config        — Runtime config
 * @param {object}   deps.workerState   — Worker state tracking object
 * @param {Function} deps.collectWorkerQueueCounts — Queue counts collector
 * @param {object}   deps.github        — GitHub adapter
 * @param {object}   deps.bark          — Bark notifier
 * @param {object}   deps.registry      — Repo registry
 * @param {object}   deps.envLoadResult — Env load result
 * @param {Date}     deps.processStartedAt — Process start time
 * @param {object}   deps.sources       — Config sources map
 */
export function createProductStatusToolsGroup({ tool, schema, store, config, workerState, collectWorkerQueueCounts, github, bark, registry, envLoadResult, processStartedAt, sources }) {
  return {
    product_status: tool({
      name: "product_status",
      description: "Return a compact product-level dashboard: running commit, worktree status, worker health, queue progress, current blockers vs raw historical counts, review classification, retention pressure, TUI provider state, and prioritized next actions. Replaces reading 10+ separate tool results.",
      inputSchema: schema({}),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "operator", "codex"],
      tags: ["system", "dashboard", "product"],
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async () => {
        return collectProductStatus({
          store, config, workerState, collectWorkerQueueCounts, github, bark,
          registry, envLoadResult, processStartedAt, sources,
        });
      },
    }),
  };
}
