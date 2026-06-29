/**
 * retention-service.mjs — Configurable rolling retention limits for GPTWork.
 *
 * Catalogs all GPTWork record families (state + filesystem) and provides
 * safe per-category retention cleanup. Never removes active/running/open/
 * assigned/queued records. Defaults to dry_run=true.
 *
 * Config keys (via GPTWORK_RETENTION_* env vars):
 *   GPTWORK_RETENTION_ENABLED             - Enable/disable retention (default: true)
 *   GPTWORK_RETENTION_LIMIT               - Per-category rolling limit (default: 50)
 *   GPTWORK_RETENTION_DRY_RUN_DEFAULT     - Default to dry-run (default: true)
 *   GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE - Archive before deleting (default: true)
 */

import { existsSync } from "node:fs";
import { readFile, readdir, rm, mkdir, writeFile, appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { createAdminAuditLogger } from "./admin-audit-log.mjs";
import { retainedWorktreeDecision } from "./legacy-reconciliation.mjs";
import {
  TASK_STATUSES,
  isActiveExecutionStatus,
  isHumanReviewStatus,
  isTerminalStatus as isTaxonomyTerminalTaskStatus,
  normalizeTaskStatus,
} from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function getRetentionConfig() {
  const getBool = (key, def) => {
    const v = process.env[key];
    if (v === undefined || v === null) return def;
    return v === "true" || v === "1" || v === true;
  };
  const getNum = (key, def) => {
    const v = process.env[key];
    if (v === undefined || v === null) return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const getStr = (key, def) => process.env[key] || def;

  return {
    enabled: getBool("GPTWORK_RETENTION_ENABLED", true),
    limit: getNum("GPTWORK_RETENTION_LIMIT", 50),
    dryRunDefault: getBool("GPTWORK_RETENTION_DRY_RUN_DEFAULT", true),
    archiveBeforeDelete: getBool("GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE", true),
  };
}

// ---------------------------------------------------------------------------
// Status / terminal / active sets
// ---------------------------------------------------------------------------

const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
const ACTIVE_GOAL_STATUSES = new Set(["assigned", "open", "queued", "running"]);

const TERMINAL_QUEUE_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_QUEUE_STATUSES = new Set(["waiting", "ready", "running", "blocked"]);

const TERMINAL_AGENT_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "skipped"]);
const ACTIVE_AGENT_RUN_STATUSES = new Set(["queued", "running", "waiting_for_review"]);

const TERMINAL_CHATGPT_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_CHATGPT_STATUSES = new Set(["pending", "processing", "waiting"]);

const TERMINAL_RESTART_MARKER_STATUSES = new Set(["verified", "failed"]);
const ACTIVE_RESTART_MARKER_STATUSES = new Set(["pending", "scheduled", "restarted"]);

function _isTerminalTaskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized !== TASK_STATUSES.BLOCKED && isTaxonomyTerminalTaskStatus(normalized);
}

function _isActiveTaskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized !== TASK_STATUSES.WAITING_FOR_INTEGRATION
    && (isActiveExecutionStatus(normalized) || isHumanReviewStatus(normalized));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _humanSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function _getTs(record, field = "updated_at") {
  const ts = Date.parse(record[field] || record.created_at || "");
  return Number.isFinite(ts) ? ts : 0;
}

function _newestTs(records, field = "updated_at") {
  if (!records || records.length === 0) return null;
  let max = 0;
  for (const r of records) {
    const t = _getTs(r, field);
    if (t > max) max = t;
  }
  return max > 0 ? new Date(max).toISOString() : null;
}

function _taskWorktreePath(task = {}) {
  const result = task.result || {};
  return task.worktree_path
    || task.worktree?.path
    || result.worktree_path
    || result.repo_resolution?.task_worktree_path
    || result.repo_resolution?.worktree_lifecycle?.worktree_path
    || result.worktree_lifecycle?.worktree_path
    || result.worktree_lifecycle?.path
    || null;
}

function _oldestTs(records, field = "updated_at") {
  if (!records || records.length === 0) return null;
  let min = Infinity;
  for (const r of records) {
    const t = _getTs(r, field);
    if (t > 0 && t < min) min = t;
  }
  return min < Infinity ? new Date(min).toISOString() : null;
}

async function _dirSize(dirPath) {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const fp = join(dirPath, e.name);
      if (e.isDirectory()) {
        total += await _dirSize(fp);
      } else if (e.isFile()) {
        try { total += (await stat(fp)).size; } catch {}
      }
    }
  } catch {}
  return total;
}

async function _countDirFiles(dirPath) {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const fp = join(dirPath, e.name);
      if (e.isDirectory()) {
        count += await _countDirFiles(fp);
      } else if (e.isFile()) {
        count++;
      }
    }
  } catch {}
  return count;
}

// ---------------------------------------------------------------------------
// Record family status (single category)
// ---------------------------------------------------------------------------

function _makeFamilyStatus(name, { total, active, terminal, bytes, oldest, newest, proposedAction, safe, type }) {
  return {
    name,
    type: type || "state",
    current_count: total,
    active_count: active,
    terminal_count: terminal,
    bytes: bytes || 0,
    bytes_h: _humanSize(bytes || 0),
    oldest,
    newest,
    proposed_action: proposedAction || "none",
    cleanup_safe: safe !== false,
  };
}

// ---------------------------------------------------------------------------
// retentionStatus
// ---------------------------------------------------------------------------

export async function retentionStatus({ config, store, workspaceRoot }) {
  const retCfg = getRetentionConfig();
  const limit = retCfg.limit;

  const state = await store.load();
  const families = [];

  // ── 1. tasks ───────────────────────────────────────────────────────
  {
    const tasks = state.tasks || [];
    const terminal = tasks.filter((t) => _isTerminalTaskStatus(t.status));
    const active = tasks.filter((t) => _isActiveTaskStatus(t.status));
    const other = tasks.filter((t) =>
      !_isTerminalTaskStatus(t.status) && !_isActiveTaskStatus(t.status)
    );
    const terminalCount = terminal.length;
    const over = terminalCount > limit ? terminalCount - limit : 0;
    families.push(_makeFamilyStatus("tasks", {
      total: tasks.length,
      active: active.length,
      terminal: terminalCount,
      oldest: _oldestTs(tasks, "updated_at"),
      newest: _newestTs(tasks, "updated_at"),
      proposedAction: over > 0 ? `remove ${over} oldest terminal tasks (keep ${limit})` : `within limit (${terminalCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 2. goals ───────────────────────────────────────────────────────
  {
    const goals = state.goals || [];
    const terminal = goals.filter((g) => TERMINAL_GOAL_STATUSES.has(g.status));
    const active = goals.filter((g) => ACTIVE_GOAL_STATUSES.has(g.status));
    const other = goals.filter((g) =>
      !TERMINAL_GOAL_STATUSES.has(g.status) && !ACTIVE_GOAL_STATUSES.has(g.status)
    );
    const terminalCount = terminal.length;
    const over = terminalCount > limit ? terminalCount - limit : 0;
    families.push(_makeFamilyStatus("goals", {
      total: goals.length,
      active: active.length,
      terminal: terminalCount,
      oldest: _oldestTs(goals, "updated_at"),
      newest: _newestTs(goals, "updated_at"),
      proposedAction: over > 0 ? `remove ${over} oldest terminal goals (keep ${limit})` : `within limit (${terminalCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 3. goal_queue ──────────────────────────────────────────────────
  {
    const queue = state.goal_queue || [];
    const terminal = queue.filter((q) => TERMINAL_QUEUE_STATUSES.has(q.status));
    const active = queue.filter((q) => ACTIVE_QUEUE_STATUSES.has(q.status));
    const terminalCount = terminal.length;
    const over = terminalCount > limit ? terminalCount - limit : 0;
    families.push(_makeFamilyStatus("goal_queue", {
      total: queue.length,
      active: active.length,
      terminal: terminalCount,
      oldest: _oldestTs(queue, "updated_at"),
      newest: _newestTs(queue, "updated_at"),
      proposedAction: over > 0 ? `remove ${over} oldest terminal queue items (keep ${limit})` : `within limit (${terminalCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 4. conversations ──────────────────────────────────────────────
  {
    const convs = state.conversations || [];
    families.push(_makeFamilyStatus("conversations", {
      total: convs.length,
      type: "state",
      oldest: _oldestTs(convs, "updated_at"),
      newest: _newestTs(convs, "updated_at"),
      proposedAction: "cleanup tied to goal retention",
      safe: true,
    }));
  }

  // ── 5. memories ──────────────────────────────────────────────────
  {
    const mems = state.memories || [];
    families.push(_makeFamilyStatus("memories", {
      total: mems.length,
      type: "state",
      oldest: _oldestTs(mems, "created_at"),
      newest: _newestTs(mems, "created_at"),
      proposedAction: "cleanup tied to goal retention",
      safe: true,
    }));
  }

  // ── 6. agent_runs ──────────────────────────────────────────────────
  {
    const runs = state.agent_runs || [];
    const terminal = runs.filter((r) => TERMINAL_AGENT_RUN_STATUSES.has(r.status));
    const active = runs.filter((r) => ACTIVE_AGENT_RUN_STATUSES.has(r.status));
    const terminalCount = terminal.length;
    const over = terminalCount > limit ? terminalCount - limit : 0;
    families.push(_makeFamilyStatus("agent_runs", {
      total: runs.length,
      active: active.length,
      terminal: terminalCount,
      oldest: _oldestTs(runs, "updated_at"),
      newest: _newestTs(runs, "updated_at"),
      proposedAction: over > 0 ? `remove ${over} oldest terminal runs (keep ${limit})` : `within limit (${terminalCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 7. chatgpt_requests ───────────────────────────────────────────
  {
    const reqs = state.chatgpt_requests || [];
    const terminal = reqs.filter((r) => TERMINAL_CHATGPT_STATUSES.has(r.status));
    const active = reqs.filter((r) => ACTIVE_CHATGPT_STATUSES.has(r.status));
    const terminalCount = terminal.length;
    const over = terminalCount > limit ? terminalCount - limit : 0;
    families.push(_makeFamilyStatus("chatgpt_requests", {
      total: reqs.length,
      active: active.length,
      terminal: terminalCount,
      oldest: _oldestTs(reqs, "updated_at"),
      newest: _newestTs(reqs, "updated_at"),
      proposedAction: over > 0 ? `remove ${over} oldest terminal requests (keep ${limit})` : `within limit (${terminalCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 8. activities ─────────────────────────────────────────────────
  {
    const acts = state.activities || [];
    const over = acts.length > limit ? acts.length - limit : 0;
    families.push(_makeFamilyStatus("activities", {
      total: acts.length,
      active: 0,
      terminal: acts.length,
      oldest: _oldestTs(acts, "timestamp"),
      newest: _newestTs(acts, "timestamp"),
      proposedAction: over > 0 ? `cap ${over} oldest activities` : `within limit (${acts.length}/${limit})`,
      safe: true,
    }));
  }

  // ── 9. state audit ────────────────────────────────────────────────
  {
    const auditArr = state.audit || [];
    const over = auditArr.length > limit ? auditArr.length - limit : 0;
    families.push(_makeFamilyStatus("state_audit", {
      total: auditArr.length,
      active: 0,
      terminal: auditArr.length,
      oldest: _oldestTs(auditArr, "timestamp"),
      newest: _newestTs(auditArr, "timestamp"),
      proposedAction: over > 0 ? `cap ${over} oldest audit entries` : `within limit (${auditArr.length}/${limit})`,
      safe: true,
    }));
  }

  // ── 10. goal directories ─────────────────────────────────────────
  {
    const goalsDir = join(workspaceRoot, ".gptwork", "goals");
    let goalDirCount = 0;
    let goalDirBytes = 0;
    let terminalGoalDirs = 0;
    let activeGoalDirs = 0;
    let oldestGoalDir = null;
    let newestGoalDir = null;

    if (existsSync(goalsDir)) {
      try {
        const entries = await readdir(goalsDir, { withFileTypes: true });
        const goalEntries = entries.filter((e) => e.isDirectory() && e.name.startsWith("goal_"));
        goalDirCount = goalEntries.length;

        let oldestMs = Infinity;
        let newestMs = 0;

        for (const g of goalEntries) {
          const gp = join(goalsDir, g.name);
          const ctxPath = join(gp, "context.json");
          let isTerminal = false;
          let isActive = false;
          let createdAt = null;

          try {
            if (existsSync(ctxPath)) {
              const ctx = JSON.parse(await readFile(ctxPath, "utf8"));
              const st = ctx.goal?.status || ctx.task?.status || "unknown";
              isTerminal = TERMINAL_GOAL_STATUSES.has(st) || st === "completed" || st === "failed";
              isActive = ACTIVE_GOAL_STATUSES.has(st) || st === "assigned" || st === "open" || st === "queued" || st === "running";
              createdAt = ctx.goal?.created_at || ctx.task?.created_at || null;
            }
          } catch {}

          if (isTerminal) terminalGoalDirs++;
          if (isActive) activeGoalDirs++;

          // Look for newest file mtime
          try {
            const s = await stat(gp);
            if (s.mtimeMs > 0) {
              if (s.mtimeMs < oldestMs) oldestMs = s.mtimeMs;
              if (s.mtimeMs > newestMs) newestMs = s.mtimeMs;
            }
          } catch {}
        }

        goalDirBytes = await _dirSize(goalsDir);
        oldestGoalDir = oldestMs < Infinity ? new Date(oldestMs).toISOString() : null;
        newestGoalDir = newestMs > 0 ? new Date(newestMs).toISOString() : null;
      } catch {}
    }

    const terminalOver = terminalGoalDirs > limit ? terminalGoalDirs - limit : 0;
    families.push(_makeFamilyStatus("goal_dirs", {
      type: "filesystem",
      total: goalDirCount,
      active: activeGoalDirs,
      terminal: terminalGoalDirs,
      bytes: goalDirBytes,
      oldest: oldestGoalDir,
      newest: newestGoalDir,
      proposedAction: terminalOver > 0
        ? `archive ${terminalOver} oldest terminal goal dirs (keep ${limit})`
        : `within limit (${terminalGoalDirs}/${limit})`,
      safe: true,
    }));
  }

  // ── 11. event logs ────────────────────────────────────────────────
  {
    const eventsDir = join(workspaceRoot, ".gptwork", "events");
    let fileCount = 0;
    let totalBytes = 0;
    let oldestEvent = null;
    let newestEvent = null;

    if (existsSync(eventsDir)) {
      try {
        const entries = await readdir(eventsDir, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
        fileCount = files.length;

        let oldestMs = Infinity;
        let newestMs = 0;
        for (const f of files) {
          const fp = join(eventsDir, f.name);
          try {
            const s = await stat(fp);
            totalBytes += s.size;
            if (s.mtimeMs < oldestMs) oldestMs = s.mtimeMs;
            if (s.mtimeMs > newestMs) newestMs = s.mtimeMs;
          } catch {}
        }
        oldestEvent = oldestMs < Infinity ? new Date(oldestMs).toISOString() : null;
        newestEvent = newestMs > 0 ? new Date(newestMs).toISOString() : null;
      } catch {}
    }

    const over = fileCount > limit ? fileCount - limit : 0;
    families.push(_makeFamilyStatus("event_logs", {
      type: "filesystem",
      total: fileCount,
      active: 0,
      terminal: fileCount,
      bytes: totalBytes,
      oldest: oldestEvent,
      newest: newestEvent,
      proposedAction: over > 0
        ? `compact/remove ${over} oldest event files (keep ${limit})`
        : `within limit (${fileCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 12. admin audit log ──────────────────────────────────────────
  {
    const auditPath = join(workspaceRoot, ".gptwork", "admin-audit.jsonl");
    let lineCount = 0;
    let fileBytes = 0;
    let oldestAudit = null;
    let newestAudit = null;

    if (existsSync(auditPath)) {
      try {
        const content = await readFile(auditPath, "utf8");
        const lines = content.split("\n").filter(Boolean);
        lineCount = lines.length;
        fileBytes = Buffer.byteLength(content);

        // Parse oldest/newest from first/last line
        if (lines.length > 0) {
          try {
            const first = JSON.parse(lines[0]);
            oldestAudit = first.timestamp || null;
          } catch {}
          try {
            const last = JSON.parse(lines[lines.length - 1]);
            newestAudit = last.timestamp || null;
          } catch {}
        }
      } catch {}
    }

    const over = lineCount > limit ? lineCount - limit : 0;
    families.push(_makeFamilyStatus("admin_audit_log", {
      type: "filesystem",
      total: lineCount,
      active: 0,
      terminal: lineCount,
      bytes: fileBytes,
      oldest: oldestAudit,
      newest: newestAudit,
      proposedAction: over > 0
        ? `compact ${over} oldest entries (keep ${limit})`
        : `within limit (${lineCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 13. restart markers ──────────────────────────────────────────
  {
    const markersDir = join(workspaceRoot, ".gptwork", "pending-restarts");
    let markerCount = 0;
    let activeMarkers = 0;
    let terminalMarkers = 0;
    let markerOldest = null;
    let markerNewest = null;

    if (existsSync(markersDir)) {
      try {
        const entries = await readdir(markersDir, { withFileTypes: true });
        const markerFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
        markerCount = markerFiles.length;

        let oldestMs = Infinity;
        let newestMs = 0;

        for (const f of markerFiles) {
          const fp = join(markersDir, f.name);
          try {
            const data = JSON.parse(await readFile(fp, "utf8"));
            const st = data.status || "pending";
            if (ACTIVE_RESTART_MARKER_STATUSES.has(st)) activeMarkers++;
            if (TERMINAL_RESTART_MARKER_STATUSES.has(st)) terminalMarkers++;
            const ts = Date.parse(data.requested_at || data.updated_at || "");
            if (Number.isFinite(ts)) {
              if (ts < oldestMs) oldestMs = ts;
              if (ts > newestMs) newestMs = ts;
            }
          } catch {}
        }

        markerOldest = oldestMs < Infinity ? new Date(oldestMs).toISOString() : null;
        markerNewest = newestMs > 0 ? new Date(newestMs).toISOString() : null;
      } catch {}
    }

    const terminalOver = terminalMarkers > limit ? terminalMarkers - limit : 0;
    families.push(_makeFamilyStatus("restart_markers", {
      type: "filesystem",
      total: markerCount,
      active: activeMarkers,
      terminal: terminalMarkers,
      oldest: markerOldest,
      newest: markerNewest,
      proposedAction: terminalOver > 0
        ? `remove ${terminalOver} oldest terminal markers (keep ${limit}), keep ${activeMarkers} active`
        : `within limit (${terminalMarkers}/${limit})`,
      safe: true,
    }));
  }

  // ── 14. managed tmp ─────────────────────────────────────────────
  {
    const tmpDir = join(workspaceRoot, ".gptwork", "tmp");
    let tmpCount = 0;
    let tmpBytes = 0;

    if (existsSync(tmpDir)) {
      try {
        tmpBytes = await _dirSize(tmpDir);
        tmpCount = await _countDirFiles(tmpDir);
      } catch {}
    }

    families.push(_makeFamilyStatus("managed_tmp", {
      type: "filesystem",
      total: tmpCount,
      bytes: tmpBytes,
      proposedAction: tmpCount > 0 ? `align age/size/count cap with retention (${tmpCount} files)` : "empty",
      safe: true,
    }));
  }

  // ── 15. workflow files ──────────────────────────────────────────
  {
    const wfDir = join(workspaceRoot, ".gptwork", "workflows");
    let wfCount = 0;
    let wfBytes = 0;

    if (existsSync(wfDir)) {
      try {
        const entries = await readdir(wfDir, { withFileTypes: true });
        const wfFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
        wfCount = wfFiles.length;
        for (const f of wfFiles) {
          try {
            wfBytes += (await stat(join(wfDir, f.name))).size;
          } catch {}
        }
      } catch {}
    }

    const over = wfCount > limit ? wfCount - limit : 0;
    families.push(_makeFamilyStatus("workflow_files", {
      type: "filesystem",
      total: wfCount,
      bytes: wfBytes,
      proposedAction: over > 0 ? `remove ${over} oldest workflow files (keep ${limit})` : `within limit (${wfCount}/${limit})`,
      safe: true,
    }));
  }

  // ── 16. system tmp (GPTWork /tmp files) ─────────────────────────
  {
    let sysTmpCount = 0;
    let sysTmpBytes = 0;
    try {
      const entries = await readdir("/tmp", { withFileTypes: true });
      const prefixes = [".gptwork-task-", "gptwork-"];
      for (const e of entries) {
        if (e.isFile() && prefixes.some((p) => e.name.startsWith(p))) {
          sysTmpCount++;
          try {
            sysTmpBytes += (await stat(join("/tmp", e.name))).size;
          } catch {}
        }
      }
    } catch {}

    families.push(_makeFamilyStatus("system_tmp", {
      type: "filesystem",
      total: sysTmpCount,
      bytes: sysTmpBytes,
      proposedAction: sysTmpCount > 0 ? `align age/size/count cap with retention (${sysTmpCount} files)` : "empty",
      safe: true,
    }));
  }

  // ── 17. retained task worktrees ─────────────────────────────────
  {
    const tasks = state.tasks || [];
    let total = 0;
    let removable = 0;
    let currentActive = 0;
    let manualReview = 0;
    let otherHistorical = 0;
    for (const task of tasks) {
      const worktreePath = _taskWorktreePath(task);
      if (!worktreePath || !existsSync(worktreePath)) continue;
      total++;
      const decision = retainedWorktreeDecision(task);
      if (decision.action === "remove") removable++;
      else if (decision.reason === "active_or_review" || decision.reason === "non_terminal") currentActive++;
      else if (decision.reason === "needs_manual_review") manualReview++;
      else otherHistorical++;
    }
    const family = _makeFamilyStatus("retained_worktrees", {
      type: "filesystem",
      total,
      active: currentActive,
      terminal: removable,
      proposedAction: removable > 0
        ? `remove ${removable} resolved terminal retained worktree(s), keep ${currentActive} current active/review and ${manualReview} manual-review retained`
        : `no resolved terminal retained worktrees (${total} tracked)`,
      safe: true,
    });
    family.historical_count = removable + otherHistorical;
    family.manual_review_count = manualReview;
    family.current_active_count = currentActive;
    families.push(family);
  }

  return {
    retention_config: {
      enabled: retCfg.enabled,
      limit: retCfg.limit,
      dry_run_default: retCfg.dryRunDefault,
      archive_before_delete: retCfg.archiveBeforeDelete,
    },
    families,
    total_families: families.length,
    summary: {
      total_records: families.reduce((s, f) => s + f.current_count, 0),
      total_active: families.reduce((s, f) => s + (typeof f.active_count === "number" ? f.active_count : 0), 0),
      total_terminal: families.reduce((s, f) => s + (typeof f.terminal_count === "number" ? f.terminal_count : 0), 0),
      total_bytes: families.reduce((s, f) => s + f.bytes, 0),
      total_bytes_h: _humanSize(families.reduce((s, f) => s + f.bytes, 0)),
      families_over_limit: families.filter((f) => f.proposed_action && f.proposed_action.includes("remove")).length,
    },
  };
}

// ---------------------------------------------------------------------------
// retentionCleanup
// ---------------------------------------------------------------------------

/**
 * Perform per-category retention cleanup.
 *
 * @param {object} opts
 * @param {object} opts.config - server config
 * @param {object} opts.store - StateStore
 * @param {string} opts.workspaceRoot
 * @param {number} [opts.limit=50] - per-category limit
 * @param {boolean} [opts.dryRun=true] - if true, only report no mutations
 * @param {boolean} [opts.archiveBeforeDelete=true] - archive before removing
 * @returns {Promise<object>}
 */
export async function retentionCleanup({
  config, store, workspaceRoot,
  limit = 50, dryRun = true, archiveBeforeDelete = true,
}) {
  const auditLogger = createAdminAuditLogger({
    workspaceRoot,
    logPath: ".gptwork/admin-audit.jsonl",
  });

  const startTime = Date.now();
  const state = await store.load();
  const beforeState = { tasks: state.tasks?.length || 0, goals: state.goals?.length || 0 };

  const changes = [];
  const skipped = [];

  // Utility to mutate state arrays safely
  function _removeFromArray(arr, predicate) {
    const removed = [];
    const kept = [];
    for (const item of arr) {
      if (predicate(item)) {
        removed.push(item);
      } else {
        kept.push(item);
      }
    }
    arr.length = 0;
    arr.push(...kept);
    return removed;
  }

  // Helper to record a change
  function _recordChange(family, action, detail, path) {
    changes.push({
      family, action, detail,
      path: path || null,
      dry_run: dryRun,
      applied: !dryRun,
    });
  }

  function _recordSkip(family, reason, detail) {
    skipped.push({
      family, reason, detail,
    });
  }

  // ── 1. Tasks ─────────────────────────────────────────────────────
  {
    const tasks = state.tasks || [];
    const terminalTasks = tasks
      .filter((t) => _isTerminalTaskStatus(t.status))
      .sort((a, b) => _getTs(b, "updated_at") - _getTs(a, "updated_at"));

    if (terminalTasks.length > limit) {
      const toRemove = terminalTasks.slice(limit);
      for (const t of toRemove) {
        _recordChange("tasks", "remove_terminal", `task ${t.id} (${t.status})`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((t) => t.id));
        _removeFromArray(tasks, (t) => ids.has(t.id));
      }
      _recordChange("tasks", "summary", `removed ${toRemove.length} terminal tasks, kept ${limit}`, null);
    } else {
      _recordSkip("tasks", "within_limit", `${terminalTasks.length} terminal tasks (limit=${limit})`);
    }
  }

  // ── 2. Goals ─────────────────────────────────────────────────────
  {
    const goals = state.goals || [];
    const terminalGoals = goals
      .filter((g) => TERMINAL_GOAL_STATUSES.has(g.status))
      .sort((a, b) => _getTs(b, "updated_at") - _getTs(a, "updated_at"));

    if (terminalGoals.length > limit) {
      const toRemove = terminalGoals.slice(limit);
      for (const g of toRemove) {
        _recordChange("goals", "remove_terminal", `goal ${g.id} (${g.status})`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((g) => g.id));
        _removeFromArray(goals, (g) => ids.has(g.id));
      }
      _recordChange("goals", "summary", `removed ${toRemove.length} terminal goals, kept ${limit}`, null);
    } else {
      _recordSkip("goals", "within_limit", `${terminalGoals.length} terminal goals (limit=${limit})`);
    }
  }

  // ── 3. goal_queue (terminal items) ──────────────────────────────
  {
    const queue = state.goal_queue || [];
    const terminalQueue = queue
      .filter((q) => TERMINAL_QUEUE_STATUSES.has(q.status))
      .sort((a, b) => _getTs(b, "updated_at") - _getTs(a, "updated_at"));

    if (terminalQueue.length > limit) {
      const toRemove = terminalQueue.slice(limit);
      for (const q of toRemove) {
        _recordChange("goal_queue", "remove_terminal", `queue item ${q.queue_id || q.id} (${q.status})`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((q) => q.queue_id || q.id));
        _removeFromArray(queue, (q) => ids.has(q.queue_id || q.id));
      }
      _recordChange("goal_queue", "summary", `removed ${toRemove.length} terminal queue items, kept ${limit}`, null);
    } else {
      _recordSkip("goal_queue", "within_limit", `${terminalQueue.length} terminal items (limit=${limit})`);
    }
  }

  // ── 4. conversations (tied to removed goals) ───────────────────
  {
    const convs = state.conversations || [];
    const removedGoalIds = changes
      .filter((c) => c.family === "goals" && c.action === "remove_terminal")
      .map((c) => {
        const m = c.detail.match(/goal (\S+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const removedGoalIdSet = new Set(removedGoalIds);

    if (removedGoalIdSet.size > 0) {
      const toRemove = convs.filter((c) => removedGoalIdSet.has(c.id) || removedGoalIdSet.has(c.goal_id));
      for (const c of toRemove) {
        _recordChange("conversations", "remove_tied_to_goal", `conversation ${c.id}`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((c) => c.id));
        _removeFromArray(convs, (c) => ids.has(c.id));
      }
      _recordChange("conversations", "summary", `removed ${toRemove.length} conversations tied to removed goals`, null);
    } else {
      _recordSkip("conversations", "no_removed_goals", "no conversations to compact");
    }
  }

  // ── 5. memories (tied to removed goals) ──────────────────────────
  {
    const mems = state.memories || [];
    const removedGoalIds = changes
      .filter((c) => c.family === "goals" && c.action === "remove_terminal")
      .map((c) => {
        const m = c.detail.match(/goal (\S+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const removedGoalIdSet = new Set(removedGoalIds);

    if (removedGoalIdSet.size > 0) {
      const toRemove = mems.filter((m) => removedGoalIdSet.has(m.goal_id));
      for (const m of toRemove) {
        _recordChange("memories", "remove_tied_to_goal", `memory ${m.id || m.goal_id}`, null);
      }
      if (!dryRun) {
        _removeFromArray(mems, (m) => removedGoalIdSet.has(m.goal_id));
      }
      _recordChange("memories", "summary", `removed ${toRemove.length} memories tied to removed goals`, null);
    } else {
      _recordSkip("memories", "no_removed_goals", "no memories to compact");
    }
  }

  // ── 6. agent_runs ──────────────────────────────────────────────
  {
    const runs = state.agent_runs || [];
    const terminalRuns = runs
      .filter((r) => TERMINAL_AGENT_RUN_STATUSES.has(r.status))
      .sort((a, b) => _getTs(b, "updated_at") - _getTs(a, "updated_at"));

    if (terminalRuns.length > limit) {
      const toRemove = terminalRuns.slice(limit);
      for (const r of toRemove) {
        _recordChange("agent_runs", "remove_terminal", `run ${r.id} (${r.status})`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((r) => r.id));
        _removeFromArray(runs, (r) => ids.has(r.id));
      }
      _recordChange("agent_runs", "summary", `removed ${toRemove.length} terminal runs, kept ${limit}`, null);
    } else {
      _recordSkip("agent_runs", "within_limit", `${terminalRuns.length} terminal runs (limit=${limit})`);
    }
  }

  // ── 7. chatgpt_requests ──────────────────────────────────────────
  {
    const reqs = state.chatgpt_requests || [];
    const terminalReqs = reqs
      .filter((r) => TERMINAL_CHATGPT_STATUSES.has(r.status))
      .sort((a, b) => _getTs(b, "updated_at") - _getTs(a, "updated_at"));

    if (terminalReqs.length > limit) {
      const toRemove = terminalReqs.slice(limit);
      for (const r of toRemove) {
        _recordChange("chatgpt_requests", "remove_terminal", `request ${r.id} (${r.status})`, null);
      }
      if (!dryRun) {
        const ids = new Set(toRemove.map((r) => r.id));
        _removeFromArray(reqs, (r) => ids.has(r.id));
      }
      _recordChange("chatgpt_requests", "summary", `removed ${toRemove.length} terminal requests, kept ${limit}`, null);
    } else {
      _recordSkip("chatgpt_requests", "within_limit", `${terminalReqs.length} terminal requests (limit=${limit})`);
    }
  }

  // ── 8. activities ──────────────────────────────────────────────
  {
    if (state.activities && state.activities.length > limit) {
      const before = state.activities.length;
      const toRemove = state.activities.length - limit;
      if (!dryRun) {
        state.activities.splice(0, toRemove);
      }
      _recordChange("activities", "capped", `capped ${toRemove} oldest activities, kept ${limit}`, null);
    } else {
      _recordSkip("activities", "within_limit", `${state.activities?.length || 0} activities (limit=${limit})`);
    }
  }

  // ── 9. state audit ────────────────────────────────────────────
  {
    if (state.audit && state.audit.length > limit) {
      const before = state.audit.length;
      const toRemove = state.audit.length - limit;
      if (!dryRun) {
        state.audit.splice(0, toRemove);
      }
      _recordChange("state_audit", "capped", `capped ${toRemove} oldest audit entries, kept ${limit}`, null);
    } else {
      _recordSkip("state_audit", "within_limit", `${state.audit?.length || 0} audit entries (limit=${limit})`);
    }
  }

  // ── 10. goal directories (filesystem) ──────────────────────────
  {
    const goalsDir = join(workspaceRoot, ".gptwork", "goals");
    if (existsSync(goalsDir)) {
      try {
        const entries = await readdir(goalsDir, { withFileTypes: true });
        const goalDirs = entries
          .filter((e) => e.isDirectory() && e.name.startsWith("goal_"))
          .map((e) => ({ name: e.name, path: join(goalsDir, e.name) }));

        // Read status for each goal dir
        const dirsWithStatus = [];
        for (const gd of goalDirs) {
          const ctxPath = join(gd.path, "context.json");
          let status = "unknown";
          let createdAt = null;
          try {
            if (existsSync(ctxPath)) {
              const ctx = JSON.parse(await readFile(ctxPath, "utf8"));
              status = ctx.goal?.status || ctx.task?.status || "unknown";
              createdAt = ctx.goal?.created_at || ctx.task?.created_at || null;
            }
          } catch {}
          dirsWithStatus.push({ ...gd, status, createdAt });
        }

        // Terminal dirs sorted by created_at desc
        const terminalDirs = dirsWithStatus
          .filter((d) => TERMINAL_GOAL_STATUSES.has(d.status) || d.status === "completed" || d.status === "failed")
          .sort((a, b) => {
            const aTs = Date.parse(a.createdAt || "0");
            const bTs = Date.parse(b.createdAt || "0");
            return bTs - aTs; // newest first
          });

        if (terminalDirs.length > limit) {
          const toArchive = terminalDirs.slice(limit);
          const archiveDir = join(workspaceRoot, ".gptwork", "archive", "goals");

          for (const gd of toArchive) {
            _recordChange("goal_dirs", "archive_terminal",
              `goal dir ${gd.name} (${gd.status})`, gd.path);

            if (!dryRun) {
              if (archiveBeforeDelete) {
                const yearMonth = new Date().toISOString().slice(0, 7);
                const targetDir = join(archiveDir, yearMonth);
                await mkdir(targetDir, { recursive: true });
                const targetPath = join(targetDir, gd.name);
                try {
                  await rename(gd.path, targetPath);
                } catch {
                  // fallback: copy + delete
                  const { cp } = await import("node:fs/promises");
                  await cp(gd.path, targetPath, { recursive: true });
                  await rm(gd.path, { recursive: true, force: true });
                }

                // Write index entry
                const indexPath = join(archiveDir, "index.json");
                let index = [];
                try {
                  if (existsSync(indexPath)) {
                    index = JSON.parse(await readFile(indexPath, "utf8"));
                  }
                } catch {}
                index.push({
                  goal_name: gd.name, status: gd.status,
                  archived_at: new Date().toISOString(),
                  archive_path: targetPath,
                });
                if (index.length > 1000) index = index.slice(-1000);
                await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
              } else {
                await rm(gd.path, { recursive: true, force: true });
              }
            }
          }
          _recordChange("goal_dirs", "summary",
            `archived ${toArchive.length} terminal goal dirs, kept ${Math.min(terminalDirs.length, limit)}`, null);
        } else {
          _recordSkip("goal_dirs", "within_limit",
            `${terminalDirs.length} terminal dirs (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("goal_dirs", "error", err.message);
      }
    } else {
      _recordSkip("goal_dirs", "no_goals_dir", "goals directory does not exist");
    }
  }

  // ── 11. event logs ────────────────────────────────────────────
  {
    const eventsDir = join(workspaceRoot, ".gptwork", "events");
    if (existsSync(eventsDir)) {
      try {
        const entries = await readdir(eventsDir, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
          .sort(); // alphabetical = chronological for YYYY-MM-DD files

        if (files.length > limit) {
          const toCompact = files.slice(0, files.length - limit);
          for (const f of toCompact) {
            const fp = join(eventsDir, f.name);
            _recordChange("event_logs", "remove_old",
              `event file ${f.name}`, fp);
            if (!dryRun) {
              await rm(fp, { force: true });
            }
          }
          _recordChange("event_logs", "summary",
            `removed ${toCompact.length} old event files, kept ${limit}`, null);
        } else {
          _recordSkip("event_logs", "within_limit",
            `${files.length} event files (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("event_logs", "error", err.message);
      }
    } else {
      _recordSkip("event_logs", "no_events_dir", "events directory does not exist");
    }
  }

  // ── 12. admin audit log ─────────────────────────────────────────
  {
    const auditPath = join(workspaceRoot, ".gptwork", "admin-audit.jsonl");
    if (existsSync(auditPath)) {
      try {
        const content = await readFile(auditPath, "utf8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length > limit) {
          const toRemove = lines.length - limit;
          const keptLines = lines.slice(toRemove);

          // Write summary/index of removed entries
          if (archiveBeforeDelete && !dryRun) {
            const removedEntries = lines.slice(0, toRemove);
            const summaryPath = join(workspaceRoot, ".gptwork", "archive",
              `admin-audit-summary-${new Date().toISOString().slice(0, 10)}.jsonl`);
            await mkdir(join(workspaceRoot, ".gptwork", "archive"), { recursive: true });
            for (const line of removedEntries) {
              await appendFile(summaryPath, line + "\n", "utf8");
            }
          }

          if (!dryRun) {
            await writeFile(auditPath, keptLines.join("\n") + "\n", "utf8");
          }

          _recordChange("admin_audit_log", "compacted",
            `removed ${toRemove} oldest entries, kept ${limit}`, auditPath);
        } else {
          _recordSkip("admin_audit_log", "within_limit",
            `${lines.length} entries (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("admin_audit_log", "error", err.message);
      }
    } else {
      _recordSkip("admin_audit_log", "no_audit_log", "admin audit log does not exist");
    }
  }

  // ── 13. restart markers ───────────────────────────────────────
  {
    const markersDir = join(workspaceRoot, ".gptwork", "pending-restarts");
    if (existsSync(markersDir)) {
      try {
        const entries = await readdir(markersDir, { withFileTypes: true });
        const markerFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));

        // Parse markers to find active vs terminal
        const parsedMarkers = [];
        for (const f of markerFiles) {
          const fp = join(markersDir, f.name);
          try {
            const data = JSON.parse(await readFile(fp, "utf8"));
            parsedMarkers.push({
              name: f.name,
              path: fp,
              status: data.status || "pending",
              requestedAt: data.requested_at || data.updated_at || null,
              data,
            });
          } catch {}
        }

        const activeMarkers = parsedMarkers.filter((m) =>
          ACTIVE_RESTART_MARKER_STATUSES.has(m.status));
        const terminalMarkers = parsedMarkers
          .filter((m) => TERMINAL_RESTART_MARKER_STATUSES.has(m.status))
          .sort((a, b) => {
            const aTs = Date.parse(a.requestedAt || "0");
            const bTs = Date.parse(b.requestedAt || "0");
            return bTs - aTs;
          });

        // Write summary index before removing
        if (terminalMarkers.length > limit) {
          const toRemove = terminalMarkers.slice(limit);

          if (archiveBeforeDelete && !dryRun) {
            const indexLines = toRemove.map((m) => JSON.stringify({
              name: m.name, status: m.status,
              requested_at: m.requestedAt,
              removed_at: new Date().toISOString(),
            }));
            const indexPath = join(workspaceRoot, ".gptwork", "archive",
              "restart-marker-summary.jsonl");
            await mkdir(join(workspaceRoot, ".gptwork", "archive"), { recursive: true });
            for (const line of indexLines) {
              await appendFile(indexPath, line + "\n", "utf8");
            }
          }

          for (const m of toRemove) {
            _recordChange("restart_markers", "remove_terminal",
              `marker ${m.name} (${m.status})`, m.path);
            if (!dryRun) {
              await rm(m.path, { force: true });
            }
          }
          _recordChange("restart_markers", "summary",
            `removed ${toRemove.length} terminal markers, kept ${Math.min(terminalMarkers.length, limit)} terminal + ${activeMarkers.length} active`,
            null);
        } else {
          _recordSkip("restart_markers", "within_limit",
            `${terminalMarkers.length} terminal markers (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("restart_markers", "error", err.message);
      }
    } else {
      _recordSkip("restart_markers", "no_markers_dir", "pending-restarts directory does not exist");
    }
  }

  // ── 14. workflow files ─────────────────────────────────────────
  {
    const wfDir = join(workspaceRoot, ".gptwork", "workflows");
    if (existsSync(wfDir)) {
      try {
        const entries = await readdir(wfDir, { withFileTypes: true });
        const wfFiles = entries
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .sort((a, b) => {
            // Sort by mtime descending
            const aS = a.name;
            const bS = b.name;
            return bS.localeCompare(aS);
          });

        if (wfFiles.length > limit) {
          const toCompact = wfFiles.slice(limit);
          for (const f of toCompact) {
            const fp = join(wfDir, f.name);
            _recordChange("workflow_files", "remove_old",
              `workflow file ${f.name}`, fp);
            if (!dryRun) {
              await rm(fp, { force: true });
            }
          }
          _recordChange("workflow_files", "summary",
            `removed ${toCompact.length} old workflow files, kept ${limit}`, null);
        } else {
          _recordSkip("workflow_files", "within_limit",
            `${wfFiles.length} workflow files (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("workflow_files", "error", err.message);
      }
    } else {
      _recordSkip("workflow_files", "no_workflows_dir", "workflows directory does not exist");
    }
  }

  // ── 15. managed tmp ──────────────────────────────────────────
  {
    const tmpDir = join(workspaceRoot, ".gptwork", "tmp");
    if (existsSync(tmpDir)) {
      try {
        const entries = await readdir(tmpDir, { withFileTypes: true });
        const tmpFiles = entries.filter((e) => e.isFile() && e.name.startsWith(".gptwork-task-"));
        if (tmpFiles.length > limit) {
          // Sort by mtime, remove oldest
          const withMtime = [];
          for (const f of tmpFiles) {
            const fp = join(tmpDir, f.name);
            try {
              const s = await stat(fp);
              withMtime.push({ name: f.name, path: fp, mtimeMs: s.mtimeMs });
            } catch {}
          }
          withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
          const toRemove = withMtime.slice(0, withMtime.length - limit);

          for (const f of toRemove) {
            _recordChange("managed_tmp", "remove_old",
              `tmp file ${f.name}`, f.path);
            if (!dryRun) {
              await rm(f.path, { force: true });
            }
          }
          _recordChange("managed_tmp", "summary",
            `removed ${toRemove.length} old tmp files, kept ${limit}`, null);
        } else {
          _recordSkip("managed_tmp", "within_limit",
            `${tmpFiles.length} tmp files (limit=${limit})`);
        }
      } catch (err) {
        _recordSkip("managed_tmp", "error", err.message);
      }
    } else {
      _recordSkip("managed_tmp", "no_tmp_dir", "managed tmp directory does not exist");
    }
  }

  // ── 16. retained task worktrees ───────────────────────────────
  {
    const tasks = state.tasks || [];
    let removed = 0;
    let candidates = 0;
    for (const task of tasks) {
      const worktreePath = _taskWorktreePath(task);
      if (!worktreePath || !existsSync(worktreePath)) continue;
      candidates++;
      const decision = retainedWorktreeDecision(task);
      if (decision.action === "remove") {
        _recordChange("retained_worktrees", "remove_resolved_terminal", `task ${task.id} (${task.status}) reason=${decision.reason}`, worktreePath);
        if (!dryRun) {
          await rm(worktreePath, { recursive: true, force: true });
          task.worktree_cleanup = {
            status: "removed",
            reason: decision.reason,
            path: worktreePath,
            cleaned_at: new Date().toISOString(),
          };
          task.result ||= {};
          task.result.worktree_cleanup = task.worktree_cleanup;
        }
        removed++;
      } else {
        _recordSkip("retained_worktrees", decision.reason, `task ${task.id} (${task.status}) path=${worktreePath}`);
      }
    }
    if (removed === 0) {
      _recordSkip("retained_worktrees", "no_removable_worktrees", `${candidates} retained worktree candidate(s)`);
    } else {
      _recordChange("retained_worktrees", "summary", `removed ${removed} resolved terminal retained worktree(s)`, null);
    }
  }

  // Save state if mutated
  if (!dryRun) {
    await store.save();
  }

  const afterState = !dryRun
    ? { tasks: state.tasks?.length || 0, goals: state.goals?.length || 0 }
    : null;

  const elapsedMs = Date.now() - startTime;

  // Write audit log
  const auditResult = await auditLogger.appendRecord({
    tool: "retention_cleanup",
    action: "retention_cleanup",
    dry_run: dryRun,
    apply: !dryRun,
    limit,
    archive_before_delete: archiveBeforeDelete,
    result: "ok",
    summary: `changes=${changes.length} skipped=${skipped.length} elapsed=${elapsedMs}ms`,
    elapsed_ms: elapsedMs,
  });

  return {
    dry_run: dryRun,
    applied: !dryRun,
    limit,
    archive_before_delete: archiveBeforeDelete,
    before: beforeState,
    after: afterState,
    changes,
    changes_count: changes.length,
    skipped,
    skipped_count: skipped.length,
    elapsed_ms: elapsedMs,
    audit_id: auditResult.auditId || null,
    message: dryRun
      ? `[dry-run] Would make ${changes.length} retention change(s), skipping ${skipped.length} category(-ies).`
      : `Applied ${changes.length} retention change(s), skipped ${skipped.length} category(-ies).`,
  };
}
