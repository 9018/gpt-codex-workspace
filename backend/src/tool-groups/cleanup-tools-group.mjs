/**
 * cleanup-tools-group.mjs — GPTWork managed temp / goal storage diagnostics and cleanup tools
 *
 * MCP tools:
 *   tmp_status          — read-only diagnostics of GPTWork-owned temp files (managed + system /tmp)
 *   cleanup_tmp         — safe mutation: delete aged/over-budget GPTWork temp files
 *   goal_storage_status — read-only diagnostics of .gptwork/goals/ (dir count, files, bytes, top N)
 *   cleanup_goals       — safe mutation: archive/delete terminal old goals
 *
 * These tools expose safe, audited temp file management to ChatGPT without
 * requiring broad shell/delete privileges.
 */

import { scanManagedTmp, cleanupManagedTmp, scanSystemTmp, cleanupSystemTmp, getInodePressure } from "../gptwork-tmp.mjs";
import { scanGoals, cleanupGoals, scanEvents, rotateEvents } from "../goal-storage-service.mjs";

/**
 * Factory for cleanup MCP tool registration.
 */
export function createCleanupToolsGroup({ tool, schema, config }) {
  return {
    // -----------------------------------------------------------------------
    // tmp_status — read-only diagnostics for temp files
    // -----------------------------------------------------------------------
    tmp_status: tool({
      name: "tmp_status",
      description:
        "Read-only snapshot of GPTWork-owned temp files. Reports for both managed " +
        "tmp directory (.gptwork/tmp/) and raw /tmp GPTWork files: total bytes, " +
        "file count, oldest/newest files, and inode pressure. " +
        "Use this to assess disk/inode pressure before running cleanup_tmp. " +
        "(查看GPTWork临时文件状态)",
      inputSchema: schema({
        include_active: {
          type: "boolean",
          description:
            "If true, include non-GPTWork-owned files in the managed tmp dir in results.",
          default: false,
        },
      }),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "tmp", "diagnostics"],
      handler: async ({ include_active }) => {
        const workspaceRoot = config.defaultWorkspaceRoot;
        if (!workspaceRoot) {
          return { ok: false, error: "defaultWorkspaceRoot not configured" };
        }

        // Managed tmp diagnostics
        const managed = await scanManagedTmp({
          workspaceRoot,
          includeActive: include_active || false,
        });

        // System /tmp diagnostics
        const systemTmp = await scanSystemTmp();

        // Inode pressure
        const inodePressure = await getInodePressure();

        // Build summaries
        const oldestFile = managed.fileCount > 0
          ? { name: managed.files[managed.files.length - 1].name, size: managed.files[managed.files.length - 1].size_h, age: managed.files[managed.files.length - 1].ageH + "h", mtime: managed.files[managed.files.length - 1].mtimeIso }
          : null;
        const newestFile = managed.fileCount > 0
          ? { name: managed.files[0].name, size: managed.files[0].size_h, age: managed.files[0].ageH + "h", mtime: managed.files[0].mtimeIso }
          : null;

        const filesOlderThan24h = managed.files.filter((f) => f.ageMs >= 86400000).length;
        const topLargest = [...managed.files].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({
          name: f.name, size: f.size_h, age: f.ageH + "h", gptwork_owned: f.gptwork_owned,
        }));

        return {
          ok: true,
          managed_tmp: {
            total_files: managed.fileCount,
            total_bytes: managed.totalBytes,
            total_bytes_h: managed.totalBytesH,
            oldest_file: oldestFile,
            newest_file: newestFile,
            files_older_than_24h: filesOlderThan24h,
            top_5_largest: topLargest,
            gptwork_owned_files: managed.files.filter((f) => f.gptwork_owned).length,
          },
          system_tmp: {
            total_files: systemTmp.file_count,
            total_directories: systemTmp.directory_count || 0,
            total_entries: systemTmp.entry_count || systemTmp.file_count,
            estimated_inodes: systemTmp.estimated_inodes || 0,
            total_bytes: systemTmp.total_bytes,
            total_bytes_h: systemTmp.total_bytes_h,
            oldest_file: systemTmp.oldest,
            newest_file: systemTmp.newest,
          },
          inode_pressure: inodePressure || null,
        };
      },
    }),

    // -----------------------------------------------------------------------
    // cleanup_tmp — safe mutation with strong defaults
    // -----------------------------------------------------------------------
    cleanup_tmp: tool({
      name: "cleanup_tmp",
      description:
        "Safely delete aged or over-budget GPTWork-owned temp files. " +
        "Covers both managed tmp dir (.gptwork/tmp/) and /tmp GPTWork files. " +
        "By default, only deletes files older than 24h or when total bytes " +
        "exceed 1GB or file count exceeds 5000. " +
        "Use dry_run=true to preview before applying. " +
        "(清理GPTWork临时文件 — 安全且有预算保护)",
      inputSchema: schema({
        dry_run: {
          type: "boolean",
          description: "If true, only report what would be deleted without actually deleting. Defaults to true.",
          default: true,
        },
        max_age_ms: {
          type: "number",
          description: "Maximum age in milliseconds. Default: 86400000 (24 hours).",
          default: 86400000,
        },
        max_bytes: {
          type: "number",
          description: "Maximum total bytes to retain. Default: 1073741824 (1 GB).",
          default: 1073741824,
        },
        max_count: {
          type: "number",
          description: "Maximum file count to retain. Default: 5000.",
          default: 5000,
        },
        include_active: {
          type: "boolean",
          description: "If true, include non-GPTWork-owned files in managed tmp dir scope.",
          default: false,
        },
        clean_system_tmp: {
          type: "boolean",
          description: "If true, also clean GPTWork-owned /tmp files (.gptwork-task-*, gptwork-*). Default: true.",
          default: true,
        },
      }),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "tmp", "admin"],
      handler: async ({ dry_run, max_age_ms, max_bytes, max_count, include_active, clean_system_tmp }) => {
        const workspaceRoot = config.defaultWorkspaceRoot;
        if (!workspaceRoot) {
          return { ok: false, error: "defaultWorkspaceRoot not configured" };
        }

        const isDryRun = dry_run !== false;

        // Managed tmp cleanup
        const managedResult = await cleanupManagedTmp({
          workspaceRoot,
          maxAgeMs: max_age_ms,
          maxBytes: max_bytes,
          maxCount: max_count,
          dryRun: isDryRun,
          includeActive: include_active || false,
        });

        // System /tmp cleanup
        let systemResult = { deleted: 0, deletedBytes: 0, skipped: 0, message: "Skipped" };
        if (clean_system_tmp !== false) {
          systemResult = await cleanupSystemTmp({
            dryRun: isDryRun,
            maxAgeMs: max_age_ms,
            maxBytes: max_bytes,
            maxCount: max_count,
          });
        }

        const totalDeleted = (managedResult.deleted || 0) + (systemResult.deleted || 0);
        const totalBytes = (managedResult.deletedBytes || 0) + (systemResult.deleted_bytes || 0);
        const totalSkipped = (managedResult.skipped || 0) + (systemResult.skipped || 0);

        return {
          ok: true,
          dry_run: isDryRun,
          managed_tmp: {
            deleted_files: managedResult.deleted,
            deleted_bytes: managedResult.deletedBytes,
            deleted_bytes_h: managedResult.deletedBytesH || managedResult.deletedBytes + " B",
            skipped_files: managedResult.skipped,
          },
          system_tmp: {
            deleted_entries: systemResult.deleted || 0,
            deleted_files: systemResult.deleted || 0,
            deleted_inodes: systemResult.deleted_inodes || 0,
            deleted_bytes: systemResult.deleted_bytes || 0,
            deleted_bytes_h: systemResult.deleted_bytes_h || "0 B",
            skipped_files: systemResult.skipped || 0,
          },
          total: {
            deleted_files: totalDeleted,
            deleted_bytes: totalBytes,
            deleted_bytes_h: _formatBytes(totalBytes),
            skipped_files: totalSkipped,
          },
          message: isDryRun
            ? `[dry-run] Managed tmp: would delete ${managedResult.deleted} file(s). System /tmp: would delete ${systemResult.deleted} file(s). Total: ${totalDeleted} file(s).`
            : `Cleaned ${totalDeleted} file(s) (managed: ${managedResult.deleted}, system: ${systemResult.deleted}). ${totalSkipped} file(s) retained.`,
        };
      },
    }),

    // -----------------------------------------------------------------------
    // goal_storage_status — read-only diagnostics for .gptwork/goals/
    // -----------------------------------------------------------------------
    goal_storage_status: tool({
      name: "goal_storage_status",
      description:
        "Read-only snapshot of .gptwork/goals/ storage. Reports goal directory count, " +
        "total files, total bytes, oldest/newest goals, top N largest goal dirs, " +
        "top N goal dirs by file count, and status breakdown. " +
        "Also scans .gptwork/events/ and other GPTWork state directories. " +
        "Use this before running cleanup_goals. (查看目标存储状态)",
      inputSchema: schema({}),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "goals", "diagnostics"],
      handler: async () => {
        const workspaceRoot = config.defaultWorkspaceRoot;
        if (!workspaceRoot) {
          return { ok: false, error: "defaultWorkspaceRoot not configured" };
        }

        const goalScan = await scanGoals(workspaceRoot);
        const eventScan = await scanEvents(workspaceRoot);

        return {
          ok: true,
          goals: goalScan,
          events: eventScan,
        };
      },
    }),

    // -----------------------------------------------------------------------
    // cleanup_goals — safe mutation: archive/delete terminal old goals
    // -----------------------------------------------------------------------
    cleanup_goals: tool({
      name: "cleanup_goals",
      description:
        "Archive or delete terminal (completed/failed/cancelled/timed_out) goals. " +
        "Dry-run by default. Honors max_age, max_goal_dirs, and max_total_files budgets. " +
        "Will NOT archive/delete running/assigned/queued/pending goals. " +
        "Archives to .gptwork/archive/goals/YYYY-MM/ with summary index. " +
        "(清理目标存储 — 安全且有预算保护)",
      inputSchema: schema({
        dry_run: {
          type: "boolean",
          description: "If true, only report what would be cleaned without actually cleaning. Defaults to true.",
          default: true,
        },
        max_age_days: {
          type: "number",
          description: "Maximum age in days for terminal goals. Default: 7.",
          default: 7,
        },
        max_goal_dirs: {
          type: "number",
          description: "Maximum number of goal directories to retain. Default: 100.",
          default: 100,
        },
        max_files: {
          type: "number",
          description: "Maximum total files under .gptwork/goals/. Default: 5000.",
          default: 5000,
        },
        archive: {
          type: "boolean",
          description: "If true, archive goals to .gptwork/archive/goals/ instead of deleting. Default: true.",
          default: true,
        },
      }),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "goals", "admin"],
      handler: async ({ dry_run, max_age_days, max_goal_dirs, max_files, archive }) => {
        const workspaceRoot = config.defaultWorkspaceRoot;
        if (!workspaceRoot) {
          return { ok: false, error: "defaultWorkspaceRoot not configured" };
        }

        const isDryRun = dry_run !== false;
        const maxAgeMs = max_age_days != null ? max_age_days * 24 * 60 * 60 * 1000 : undefined;

        const result = await cleanupGoals({
          workspaceRoot,
          dryRun: isDryRun,
          maxAgeMs,
          maxGoalDirs: max_goal_dirs,
          maxFiles: max_files,
          archive: archive !== false,
        });

        return {
          ok: true,
          dry_run: result.dry_run,
          eligible: result.eligible,
          archived: result.archived,
          deleted: result.deleted,
          skipped: result.skipped,
          total_goal_dirs: result.total_goal_dirs,
          total_files: result.total_files,
          freed_bytes: result.freed_bytes,
          freed_bytes_h: result.freed_bytes_h,
          details: result.details,
          message: result.message,
        };
      },
    }),
  };
}

function _formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}
