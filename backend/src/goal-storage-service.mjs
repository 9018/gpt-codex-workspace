/**
 * goal-storage-service.mjs — Goal diagnostics, cleanup, and archive lifecycle.
 *
 * Prevents .gptwork/goals/ from growing unbounded by:
 * - Providing read-only file-count/inode diagnostics
 * - Enabling dry-run and apply cleanup of terminal goals
 * - Archiving old goals to .gptwork/archive/goals/YYYY-MM/
 * - Preserving open/running/assigned/queued goals
 *
 * All directory iteration is streaming via fs.readdir + batched stats
 * to avoid shell glob expansion failures with very large directories.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_STATUSES } from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max terminal goal age: 7 days. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default max goal dirs. */
const DEFAULT_MAX_GOAL_DIRS = 100;

/** Default max total files under goals/. */
const DEFAULT_MAX_FILES = 5000;

/** Max goals to show in top-N lists. */
const TOP_N = 10;

/**
 * Prefixes for GPTWork-owned /tmp files.
 */
const GPTWORK_TMP_PREFIXES = [".gptwork-task-", "gptwork-"];

const TERMINAL_GOAL_STATUSES = new Set([
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.CANCELLED,
  TASK_STATUSES.TIMED_OUT,
  TASK_STATUSES.WAITING_FOR_REVIEW,
]);

const ACTIVE_GOAL_STATUSES = new Set([
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.QUEUED,
  "loading",
  "preparing",
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function goalsDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "goals");
}

function eventsDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "events");
}

function archiveDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "archive", "goals");
}

// ---------------------------------------------------------------------------
// Human-readable size
// ---------------------------------------------------------------------------

function _humanSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

// ---------------------------------------------------------------------------
// File counting helpers
// ---------------------------------------------------------------------------

async function _countFilesInDir(dirPath) {
  const results = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await _countFilesInDir(fullPath);
        results.push(...sub);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          results.push({ name: entry.name, path: fullPath, size: s.size, mtimeMs: s.mtimeMs });
        } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
  return results;
}

async function _readGoalStatus(goalPath) {
  try {
    const ctxPath = join(goalPath, "context.json");
    if (existsSync(ctxPath)) {
      const ctx = JSON.parse(await readFile(ctxPath, "utf8"));
      return {
        status: ctx.goal?.status || ctx.task?.status || "unknown",
        createdAt: ctx.goal?.created_at || ctx.task?.created_at || null,
      };
    }
  } catch { /* best effort */ }
  return { status: "unknown", createdAt: null };
}

// ---------------------------------------------------------------------------
// Goal storage diagnostics
// ---------------------------------------------------------------------------

export async function scanGoals(workspaceRoot) {
  const dir = goalsDir(workspaceRoot);
  if (!existsSync(dir)) {
    return {
      goal_dir_count: 0, total_files: 0, total_bytes: 0, total_bytes_h: "0 B",
      oldest_goal: null, newest_goal: null,
      top_largest: [], top_by_file_count: [], status_breakdown: {},
    };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const goalDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("goal_"));

  const goalStats = [];
  const statusCounts = {};
  let totalFiles = 0;
  let totalBytes = 0;

  for (const gd of goalDirs) {
    const gdPath = join(dir, gd.name);
    const files = await _countFilesInDir(gdPath);
    const gBytes = files.reduce((sum, f) => sum + f.size, 0);
    const mtimes = files.map((f) => f.mtimeMs).filter(Boolean);
    const newest = mtimes.length > 0 ? Math.max(...mtimes) : null;

    const { status } = await _readGoalStatus(gdPath);
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    totalFiles += files.length;
    totalBytes += gBytes;

    goalStats.push({
      name: gd.name, file_count: files.length,
      total_bytes: gBytes, total_bytes_h: _humanSize(gBytes),
      newest_ms: newest, status,
    });
  }

  const bySize = [...goalStats].sort((a, b) => b.total_bytes - a.total_bytes);
  const byCount = [...goalStats].sort((a, b) => b.file_count - a.file_count);

  const withMtime = goalStats.filter((g) => g.newest_ms !== null);
  withMtime.sort((a, b) => a.newest_ms - b.newest_ms);
  const now = Date.now();

  return {
    goal_dir_count: goalDirs.length,
    total_files: totalFiles,
    total_bytes: totalBytes,
    total_bytes_h: _humanSize(totalBytes),
    oldest_goal: withMtime.length > 0
      ? { name: withMtime[0].name, mtime: new Date(withMtime[0].newest_ms).toISOString(), age_days: ((now - withMtime[0].newest_ms) / 86400000).toFixed(1) }
      : null,
    newest_goal: withMtime.length > 0
      ? { name: withMtime[withMtime.length - 1].name, mtime: new Date(withMtime[withMtime.length - 1].newest_ms).toISOString(), age_days: ((now - withMtime[withMtime.length - 1].newest_ms) / 86400000).toFixed(1) }
      : null,
    top_largest: bySize.slice(0, TOP_N).map((g) => ({
      name: g.name, file_count: g.file_count, total_bytes_h: g.total_bytes_h, status: g.status,
    })),
    top_by_file_count: byCount.slice(0, TOP_N).map((g) => ({
      name: g.name, file_count: g.file_count, total_bytes_h: g.total_bytes_h, status: g.status,
    })),
    status_breakdown: statusCounts,
  };
}

// ---------------------------------------------------------------------------
// Goal cleanup / archive
// ---------------------------------------------------------------------------

export async function cleanupGoals({
  workspaceRoot, dryRun = true, maxAgeMs, maxGoalDirs, maxFiles, archive = true,
}) {
  const effectiveMaxAge = maxAgeMs != null ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  const effectiveMaxGoalDirs = maxGoalDirs != null ? maxGoalDirs : DEFAULT_MAX_GOAL_DIRS;
  const effectiveMaxFiles = maxFiles != null ? maxFiles : DEFAULT_MAX_FILES;

  const dir = goalsDir(workspaceRoot);
  if (!existsSync(dir)) {
    return { dry_run: dryRun, eligible: 0, archived: 0, deleted: 0, skipped: 0,
      total_goal_dirs: 0, total_files: 0, details: [],
      message: "No goals to clean up." };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const goalDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("goal_"));
  const now = Date.now();
  const goalDetails = [];

  for (const gd of goalDirs) {
    const gdPath = join(dir, gd.name);
    const { status, createdAt } = await _readGoalStatus(gdPath);
    const createdMs = createdAt ? new Date(createdAt).getTime() : now;
    const ageMs = now - createdMs;
    const isTerminal = TERMINAL_GOAL_STATUSES.has(status);
    const isActive = ACTIVE_GOAL_STATUSES.has(status);
    const files = await _countFilesInDir(gdPath);
    const gBytes = files.reduce((sum, f) => sum + f.size, 0);

    goalDetails.push({
      name: gd.name, path: gdPath, status, created_at: createdAt,
      age_ms: ageMs, age_days: (ageMs / 86400000).toFixed(1),
      is_terminal: isTerminal, is_active: isActive,
      file_count: files.length, total_bytes: gBytes,
      total_bytes_h: _humanSize(gBytes), eligible: false,
    });
  }

  // Mark eligible: terminal goals sorted oldest-first
  const terminalGoals = goalDetails.filter((g) => g.is_terminal)
    .sort((a, b) => a.age_ms - b.age_ms);

  for (const g of terminalGoals) {
    if (g.age_ms >= effectiveMaxAge) g.eligible = true;
  }

  // Enforce count cap: if total retained > effectiveMaxGoalDirs, mark more
  const totalTerminal = terminalGoals.length;
  const activeCount = goalDetails.filter((g) => g.is_active).length;
  const otherCount = goalDetails.filter((g) => !g.is_terminal && !g.is_active).length;

  // Already eligible from age
  const ageEligible = terminalGoals.filter((g) => g.eligible).length;
  const notAgeEligible = terminalGoals.filter((g) => !g.eligible);

  // Total retained if we only remove age-eligible
  const retainedAfterAge = activeCount + otherCount + notAgeEligible.length;

  if (retainedAfterAge > effectiveMaxGoalDirs) {
    const excess = retainedAfterAge - effectiveMaxGoalDirs;
    for (const g of notAgeEligible.slice(0, excess)) {
      g.eligible = true;
    }
  }

  // Enforce files cap
  let retainedFiles = goalDetails.filter((g) => !g.eligible).reduce((s, g) => s + g.file_count, 0);
  if (retainedFiles > effectiveMaxFiles) {
    const stillNotEligible = terminalGoals.filter((g) => !g.eligible);
    for (const g of stillNotEligible) {
      if (retainedFiles <= effectiveMaxFiles) break;
      g.eligible = true;
      retainedFiles -= g.file_count;
    }
  }

  const eligible = goalDetails.filter((g) => g.eligible);
  const totalEligibleBytes = eligible.reduce((sum, g) => sum + g.total_bytes, 0);

  if (!dryRun) {
    for (const g of eligible) {
      try {
        if (archive) {
          await _archiveGoalDir(workspaceRoot, g);
        } else {
          await rm(g.path, { recursive: true, force: true });
        }
      } catch { /* best effort */ }
    }
  }

  return {
    dry_run: dryRun,
    eligible: eligible.length,
    archived: !dryRun && archive ? eligible.length : 0,
    deleted: !dryRun && !archive ? eligible.length : 0,
    skipped: goalDetails.length - eligible.length,
    total_goal_dirs: goalDirs.length,
    total_files: goalDetails.reduce((s, g) => s + g.file_count, 0),
    freed_bytes: totalEligibleBytes,
    freed_bytes_h: _humanSize(totalEligibleBytes),
    details: eligible.map((g) => ({
      name: g.name, status: g.status, age_days: g.age_days,
      file_count: g.file_count, total_bytes_h: g.total_bytes_h,
    })),
    message: dryRun
      ? `[dry-run] Would archive/clean ${eligible.length} terminal goal(s) (${_humanSize(totalEligibleBytes)}), preserving ${goalDetails.length - eligible.length} goal(s).`
      : `Cleaned ${eligible.length} terminal goal(s) (${_humanSize(totalEligibleBytes)}), ${goalDetails.length - eligible.length} goal(s) preserved.`,
  };
}

async function _archiveGoalDir(workspaceRoot, goalInfo) {
  const createdDate = goalInfo.created_at ? new Date(goalInfo.created_at) : new Date();
  const yearMonth = `${createdDate.getFullYear()}-${String(createdDate.getMonth() + 1).padStart(2, "0")}`;
  const targetDir = join(archiveDir(workspaceRoot), yearMonth);
  await mkdir(targetDir, { recursive: true });

  const targetPath = join(targetDir, goalInfo.name);

  try {
    await rename(goalInfo.path, targetPath);
  } catch {
    await rm(targetPath, { recursive: true, force: true }).catch(() => {});
    const { cp } = await import("node:fs/promises");
    await cp(goalInfo.path, targetPath, { recursive: true });
    await rm(goalInfo.path, { recursive: true, force: true });
  }

  // Update archive index
  const indexPath = join(archiveDir(workspaceRoot), "index.json");
  let index = [];
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    }
  } catch { index = []; }

  index.push({
    goal_name: goalInfo.name, status: goalInfo.status,
    created_at: goalInfo.created_at, archived_at: new Date().toISOString(),
    archive_path: targetPath, file_count: goalInfo.file_count,
    total_bytes: goalInfo.total_bytes, summary: null,
  });

  if (index.length > 1000) index = index.slice(-1000);
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Event/log diagnostics and rotation
// ---------------------------------------------------------------------------

export async function scanEvents(workspaceRoot) {
  const dir = eventsDir(workspaceRoot);
  if (!existsSync(dir)) {
    return { file_count: 0, total_bytes: 0, total_bytes_h: "0 B", event_files: [] };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, entry.name);
    try {
      const s = await stat(fullPath);
      files.push({ name: entry.name, size_h: _humanSize(s.size), mtime: new Date(s.mtimeMs).toISOString() });
      totalBytes += s.size;
    } catch { /* best effort */ }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return { file_count: files.length, total_bytes: totalBytes, total_bytes_h: _humanSize(totalBytes), event_files: files };
}

export async function rotateEvents(workspaceRoot, keepDays = 7) {
  const dir = eventsDir(workspaceRoot);
  if (!existsSync(dir)) {
    return { deleted: 0, kept: 0, message: "No events directory." };
  }

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(dir, { withFileTypes: true });
  let deleted = 0;
  let kept = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, entry.name);
    try {
      const s = await stat(fullPath);
      if (s.mtimeMs < cutoff) {
        await rm(fullPath, { force: true });
        deleted++;
      } else { kept++; }
    } catch { kept++; }
  }

  return { deleted, kept, message: `Rotated ${deleted} event file(s), kept ${kept}.` };
}

// ---------------------------------------------------------------------------
// System /tmp diagnostics and cleanup
// ---------------------------------------------------------------------------

export async function scanSystemTemp() {
  let entries;
  try {
    entries = await readdir("/tmp", { withFileTypes: true });
  } catch {
    return { file_count: 0, total_bytes: 0, total_bytes_h: "0 B", oldest: null, newest: null, files: [] };
  }

  const matched = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!GPTWORK_TMP_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const fullPath = join("/tmp", entry.name);
    try {
      const s = await stat(fullPath);
      matched.push({
        name: entry.name, path: fullPath, size: s.size, size_h: _humanSize(s.size),
        mtimeMs: s.mtimeMs, mtimeIso: new Date(s.mtimeMs).toISOString(),
      });
      totalBytes += s.size;
    } catch { /* best effort */ }
  }

  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    file_count: matched.length,
    total_bytes: totalBytes,
    total_bytes_h: _humanSize(totalBytes),
    oldest: matched.length > 0 ? { name: matched[matched.length - 1].name, mtime: matched[matched.length - 1].mtimeIso } : null,
    newest: matched.length > 0 ? { name: matched[0].name, mtime: matched[0].mtimeIso } : null,
    files: matched.slice(0, 100),
  };
}

export async function cleanupSystemTemp({
  dryRun = true, maxAgeMs, maxBytes, maxCount, protectPrefixes = [],
}) {
  const effectiveMaxAge = maxAgeMs != null ? maxAgeMs : 24 * 60 * 60 * 1000;
  const effectiveMaxBytes = maxBytes != null ? maxBytes : 1 * 1024 * 1024 * 1024;
  const effectiveMaxCount = maxCount != null ? maxCount : 5000;

  const scan = await scanSystemTemp();
  if (scan.file_count === 0) {
    return { dry_run: dryRun, deleted: 0, deleted_bytes: 0, deleted_bytes_h: "0 B", skipped: 0,
      message: "No GPTWork /tmp files to clean up." };
  }

  const now = Date.now();
  let candidates = scan.files.filter((f) => {
    for (const p of protectPrefixes) { if (f.name.startsWith(p)) return false; }
    return true;
  });

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const deleteSet = new Set();

  for (const f of candidates) {
    if (now - f.mtimeMs >= effectiveMaxAge) deleteSet.add(f.name);
  }

  let remainingBytes = candidates.filter((f) => !deleteSet.has(f.name)).reduce((s, f) => s + f.size, 0);
  if (remainingBytes > effectiveMaxBytes) {
    for (const f of candidates) {
      if (deleteSet.has(f.name)) continue;
      if (remainingBytes <= effectiveMaxBytes) break;
      deleteSet.add(f.name);
      remainingBytes -= f.size;
    }
  }

  let remainingCount = candidates.filter((f) => !deleteSet.has(f.name)).length;
  if (remainingCount > effectiveMaxCount) {
    for (const f of candidates) {
      if (deleteSet.has(f.name)) continue;
      if (remainingCount <= effectiveMaxCount) break;
      deleteSet.add(f.name);
      remainingCount--;
    }
  }

  const filesToDelete = scan.files.filter((f) => deleteSet.has(f.name));
  const deletedBytes = filesToDelete.reduce((sum, f) => sum + f.size, 0);

  if (!dryRun) {
    for (const f of filesToDelete) {
      try { await rm(f.path, { force: true }); } catch { /* best effort */ }
    }
  }

  return {
    dry_run: dryRun,
    deleted: filesToDelete.length,
    deleted_bytes: deletedBytes,
    deleted_bytes_h: _humanSize(deletedBytes),
    skipped: scan.file_count - filesToDelete.length,
    message: dryRun
      ? `[dry-run] Would delete ${filesToDelete.length} GPTWork /tmp file(s) (${_humanSize(deletedBytes)}), skipping ${scan.file_count - filesToDelete.length}.`
      : `Deleted ${filesToDelete.length} GPTWork /tmp file(s) (${_humanSize(deletedBytes)}), ${scan.file_count - filesToDelete.length} preserved.`,
  };
}
