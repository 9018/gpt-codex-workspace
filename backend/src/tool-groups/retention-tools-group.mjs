/**
 * retention-tools-group.mjs — GPTWork retention management tools.
 *
 * Tools:
 *   1. retention_status   - Read-only status of all record families
 *   2. retention_cleanup   - Dry-run or apply per-category retention cleanup
 *
 * Config: See GPTWORK_RETENTION_* env vars in runtime-config.mjs
 */

import { retentionStatus, retentionCleanup, getRetentionConfig } from "../retention-service.mjs";

/**
 * Factory for retention management tools.
 *
 * @param {object} deps
 * @param {Function} deps.tool - tool factory
 * @param {object} deps.schema - schema factory
 * @param {object} deps.store - StateStore
 * @param {object} deps.config - server config
 * @returns {object} tool map
 */
export function createRetentionToolsGroup({ tool, schema, store, config }) {
  const common = {
    modes: ["standard", "operator", "full"],
    audience: ["chatgpt", "operator"],
    tags: ["system", "maintenance", "retention"],
  };

  const wsRoot = config.defaultWorkspaceRoot;

  const tools = {};

  // ================================================================
  // 1. retention_status
  // ================================================================
  tools.retention_status = tool({
    name: "retention_status",
    description: "Read-only inventory of all GPTWork record families that can grow over time. Reports current count, active vs terminal count, bytes, oldest/newest, proposed action under current limit, and whether cleanup is safe. No mutations.",
    inputSchema: schema({}),
    ...common,
    handler: async () => {
      const report = await retentionStatus({ config, store, workspaceRoot: wsRoot });
      return report;
    },
  });

  // ================================================================
  // 2. retention_cleanup
  // ================================================================
  tools.retention_cleanup = tool({
    name: "retention_cleanup",
    description: "Per-category rolling retention cleanup. Defaults to dry_run=true. Supports per-category limit, archive-before-delete. Never removes active/open/running/queued/assigned records. Always writes audit log. Apply with apply=true.",
    inputSchema: schema({
      dry_run: { type: "boolean", description: "Report without changing. Default: true.", default: true },
      apply: { type: "boolean", description: "Actually apply cleanup changes. Default: false.", default: false },
      limit: { type: "integer", description: "Per-category rolling limit. Default: 50.", default: 50, minimum: 1, maximum: 10000 },
      archive_before_delete: { type: "boolean", description: "Archive before deleting filesystem records. Default: true.", default: true },
    }, []),
    ...common,
    handler: async ({ dry_run, apply, limit, archive_before_delete }) => {
      const isDryRun = dry_run !== false && apply !== true;
      const isApply = apply === true;
      const effectiveLimit = Number(limit) || 50;
      const doArchive = archive_before_delete !== false;

      const result = await retentionCleanup({
        config,
        store,
        workspaceRoot: wsRoot,
        limit: effectiveLimit,
        dryRun: isDryRun,
        archiveBeforeDelete: doArchive,
      });

      return result;
    },
  });

  return tools;
}
