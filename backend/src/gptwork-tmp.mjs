/**
 * gptwork-tmp.mjs — Managed temp file lifecycle for GPTWork.
 *
 * Prevents unbounded /tmp filling by:
 * - Using a managed temp root under workspace state dir (instead of /tmp)
 * - Enforcing TTL, size budget, and count budget
 * - Providing safe cleanup and diagnostics tools
 * - Offering ENOSPC recovery on write failures
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for GPTWork task prompt temp files in managed tmp dir. */
const GPTWORK_TMP_PREFIX = ".gptwork-task-";

/** Default max age for temp files: 24 hours. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default max total bytes: 1 GB. */
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/** Default max file count. */
const DEFAULT_MAX_COUNT = 5000;

/** Bytes to reclaim when ENOSPC is detected during write. */
const ENOSPC_RECLAIM_TARGET_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the managed temp directory path.
 * All GPTWork temp files should live under this directory.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getManagedTmpDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "tmp");
}

/**
 * Get the managed temp file path for a specific task prompt.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {string}
 */
export function getTaskPromptPath(workspaceRoot, taskId) {
  return join(getManagedTmpDir(workspaceRoot), `${GPTWORK_TMP_PREFIX}${taskId}.txt`);
}

// ---------------------------------------------------------------------------
// Directory lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure the managed tmp directory exists with safe permissions.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<string>} path to the managed tmp dir
 */
export async function ensureManagedTmpDir(workspaceRoot) {
  const dir = getManagedTmpDir(workspaceRoot);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

// ---------------------------------------------------------------------------
// Write operations with ENOSPC recovery
// ---------------------------------------------------------------------------

/**
 * Write a task prompt file to the managed temp directory.
 *
 * On ENOSPC, triggers cleanup of old files and retries once.
 * If still failing after cleanup, throws with a clear error (code ENOSPC_RETRY_FAILED).
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string} opts.taskId
 * @param {string} opts.content - prompt text content
 * @returns {Promise<string>} path to the written file
 */
export async function writeTaskPromptFile({ workspaceRoot, taskId, content }) {
  const dir = await ensureManagedTmpDir(workspaceRoot);
  const filePath = join(dir, `${GPTWORK_TMP_PREFIX}${taskId}.txt`);

  try {
    await writeFile(filePath, content, "utf8");
  } catch (err) {
    if (err.code === "ENOSPC") {
      // Clean up old files and retry once
      await cleanupManagedTmp({
        workspaceRoot,
        maxAgeMs: 0,            // delete everything eligible regardless of age
        maxBytes: ENOSPC_RECLAIM_TARGET_BYTES,
        dryRun: false,
      });
      try {
        await writeFile(filePath, content, "utf8");
      } catch (retryErr) {
        if (retryErr.code === "ENOSPC") {
          const error = new Error(
            `ENOSPC: Cannot write task prompt file for ${taskId} even after cleanup. Disk is full.`
          );
          error.code = "ENOSPC_RETRY_FAILED";
          throw error;
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  return filePath;
}

// ---------------------------------------------------------------------------
// Single file removal
// ---------------------------------------------------------------------------

/**
 * Remove a single task prompt file by task ID.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<boolean>} true if file existed and was removed
 */
export async function removeTaskPromptFile(workspaceRoot, taskId) {
  const filePath = getTaskPromptPath(workspaceRoot, taskId);
  try {
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove all GPTWork-owned task prompt files in the managed tmp dir.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<number>} count of files removed
 */
export async function removeAllTaskPromptFiles(workspaceRoot) {
  const files = await _listManagedFiles(workspaceRoot);
  let removed = 0;
  for (const f of files) {
    try {
      await rm(f.path, { force: true });
      removed++;
    } catch {
      // best effort
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Scanning (read-only)
// ---------------------------------------------------------------------------

/**
 * Scan the managed tmp directory and return file information.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {boolean} [opts.includeActive] - include non-GPTWork-owned files in results
 * @returns {Promise<{files: object[], totalBytes: number, fileCount: number, oldestMs: number|null, newestMs: number|null}>}
 */
export async function scanManagedTmp({ workspaceRoot, includeActive = false }) {
  const dir = getManagedTmpDir(workspaceRoot);

  if (!existsSync(dir)) {
    return { files: [], totalBytes: 0, fileCount: 0, oldestMs: null, newestMs: null };
  }

  const now = Date.now();
  const files = [];
  let totalBytes = 0;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const isGptWork = entry.name.startsWith(GPTWORK_TMP_PREFIX);
      if (!isGptWork && !includeActive) continue;

      const filePath = join(dir, entry.name);
      let s;
      try {
        s = await stat(filePath);
      } catch {
        continue;
      }

      const age = now - s.mtimeMs;
      totalBytes += s.size;

      files.push({
        name: entry.name,
        path: filePath,
        size: s.size,
        size_h: _humanSize(s.size),
        mtimeMs: s.mtimeMs,
        mtimeIso: new Date(s.mtimeMs).toISOString(),
        ageMs: age,
        ageH: (age / 3_600_000).toFixed(1),
        gptwork_owned: isGptWork,
      });
    }
  } catch {
    // non-fatal
  }

  // Sort by mtime descending (newest first)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    files,
    totalBytes,
    totalBytesH: _humanSize(totalBytes),
    fileCount: files.length,
    oldestMs: files.length > 0 ? files[files.length - 1].mtimeMs : null,
    newestMs: files.length > 0 ? files[0].mtimeMs : null,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up managed temp files with configurable budgets.
 *
 * Deletion order: age-expired files first (oldest files beyond maxAgeMs),
 * then oldest files overall until byte and count budgets are met.
 *
 * @param {object} opts
 * @param {string}  opts.workspaceRoot
 * @param {number}  [opts.maxAgeMs=86400000]      - Delete files older than this
 * @param {number}  [opts.maxBytes=1073741824]      - Evict oldest until total <= this
 * @param {number}  [opts.maxCount=5000]             - Evict oldest until count <= this
 * @param {boolean} [opts.dryRun=false]             - If true, only report, don't delete
 * @param {boolean} [opts.includeActive=false]       - Include non-GPTWork-owned files
 * @returns {Promise<{deleted: number, deletedBytes: number, skipped: number, dryRun: boolean, freedBytes: number}>}
 */
export async function cleanupManagedTmp({
  workspaceRoot,
  maxAgeMs,
  maxBytes,
  maxCount,
  dryRun = false,
  includeActive = false,
}) {
  const effectiveMaxAge = maxAgeMs !== undefined ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  const effectiveMaxBytes = maxBytes !== undefined ? maxBytes : DEFAULT_MAX_BYTES;
  const effectiveMaxCount = maxCount !== undefined ? maxCount : DEFAULT_MAX_COUNT;

  const scan = await scanManagedTmp({ workspaceRoot, includeActive });

  if (scan.fileCount === 0) {
    return { deleted: 0, deletedBytes: 0, skipped: 0, dryRun, freedBytes: 0 };
  }

  // Sort by mtime ascending (oldest first) for FIFO eviction
  const sorted = [...scan.files].sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Phase 1: mark files that exceed maxAge
  const deleteSet = new Set();
  for (const f of sorted) {
    if (f.ageMs >= effectiveMaxAge) {
      deleteSet.add(f.name);
    }
  }

  // Compute remaining after Phase 1
  let remainingBytes = scan.totalBytes;
  let remainingCount = scan.fileCount;
  for (const f of sorted) {
    if (deleteSet.has(f.name)) {
      remainingBytes -= f.size;
      remainingCount--;
    }
  }

  // Phase 2: enforce byte and count budgets — delete oldest first
  for (const f of sorted) {
    if (deleteSet.has(f.name)) continue;
    if (remainingBytes <= effectiveMaxBytes && remainingCount <= effectiveMaxCount) break;
    deleteSet.add(f.name);
    remainingBytes -= f.size;
    remainingCount--;
  }

  const filesToDelete = scan.files.filter((f) => deleteSet.has(f.name));
  const deletedBytes = filesToDelete.reduce((sum, f) => sum + f.size, 0);
  const deletedCount = filesToDelete.length;

  if (!dryRun) {
    for (const f of filesToDelete) {
      try {
        await rm(f.path, { force: true });
      } catch {
        // best effort
      }
    }
  }

  return {
    deleted: deletedCount,
    deletedBytes,
    deletedBytesH: _humanSize(deletedBytes),
    skipped: scan.fileCount - deletedCount,
    dryRun,
    freedBytes: deletedBytes,
    freedBytesH: _humanSize(deletedBytes),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * List all GPTWork-owned managed files in the GPTWork tmp dir.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{name: string, path: string}[]>}
 */
async function _listManagedFiles(workspaceRoot) {
  const dir = getManagedTmpDir(workspaceRoot);
  if (!existsSync(dir)) return [];

  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(GPTWORK_TMP_PREFIX)) continue;
      results.push({ name: entry.name, path: join(dir, entry.name) });
    }
  } catch {
    // non-fatal
  }
  return results;
}

/**
 * Format a byte count into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
function _humanSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

// ---------------------------------------------------------------------------
// System /tmp scanning (GPTWork-owned files and test-run directories)
// ---------------------------------------------------------------------------

const SYSTEM_TMP_FILE_PREFIXES = Object.freeze([".gptwork-task-"]);
const SYSTEM_TMP_DIRECTORY_PREFIXES = Object.freeze([
  "gptwork-",
  "agent-run-",
  "watch-test-",
  "graph-state-",
  "old-state-data-",
  "mock-codex-",
  "worker-queue-cache-",
  "ws-cap-test-",
  "ws-dag-test-",
  "ws-join-test-",
  "pipeline-orch-test-",
  "retention-git-test-",
  "delivery-recovery-",
  "p0-ma11-r2-test-",
  "p0-ma11-r3-test-",
  "patrol-test-",
  "sweeper-test-",
]);

export function isOwnedSystemTmpEntry(name, kind = "directory") {
  const prefixes = kind === "file" ? SYSTEM_TMP_FILE_PREFIXES : SYSTEM_TMP_DIRECTORY_PREFIXES;
  return prefixes.some((prefix) => String(name || "").startsWith(prefix));
}

async function _estimateEntryInodes(path, kind, maxEntries = 20_000) {
  if (kind !== "directory") return 1;
  let count = 1;
  const pending = [path];
  while (pending.length > 0 && count < maxEntries) {
    const current = pending.pop();
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory() && count < maxEntries) pending.push(join(current, entry.name));
      if (count >= maxEntries) break;
    }
  }
  return count;
}

/** Scan a temp root for explicitly GPTWork-owned files and directories. */
export async function scanSystemTmp({ tmpRoot = "/tmp", maxDetail = 100 } = {}) {
  const matched = [];
  let totalBytes = 0;
  let estimatedInodes = 0;
  let fileCount = 0;
  let directoryCount = 0;

  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return { file_count: 0, directory_count: 0, entry_count: 0, estimated_inodes: 0, total_bytes: 0, total_bytes_h: "0 B", oldest: null, newest: null, files: [], entries: [] };
  }

  for (const entry of entries) {
    const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    if (kind === "other" || !isOwnedSystemTmpEntry(entry.name, kind)) continue;
    const fullPath = join(tmpRoot, entry.name);
    try {
      const s = await stat(fullPath);
      const inodeCount = await _estimateEntryInodes(fullPath, kind);
      matched.push({
        name: entry.name,
        path: fullPath,
        kind,
        size: s.size,
        size_h: _humanSize(s.size),
        inode_count: inodeCount,
        mtimeMs: s.mtimeMs,
        mtimeIso: new Date(s.mtimeMs).toISOString(),
      });
      totalBytes += s.size;
      estimatedInodes += inodeCount;
      if (kind === "directory") directoryCount += 1;
      else fileCount += 1;
    } catch {
      // best effort
    }
  }

  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const detailed = matched.slice(0, maxDetail);
  return {
    file_count: fileCount,
    directory_count: directoryCount,
    entry_count: matched.length,
    estimated_inodes: estimatedInodes,
    total_bytes: totalBytes,
    total_bytes_h: _humanSize(totalBytes),
    oldest: matched.length > 0 ? { name: matched.at(-1).name, kind: matched.at(-1).kind, mtime: matched.at(-1).mtimeIso } : null,
    newest: matched.length > 0 ? { name: matched[0].name, kind: matched[0].kind, mtime: matched[0].mtimeIso } : null,
    files: detailed.filter((entry) => entry.kind === "file"),
    entries: detailed,
    all_entries: matched,
  };
}

/** Basic inode/pressure diagnostic for a temp root. */
export async function getInodePressure(tmpRoot = "/tmp") {
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("df", ["-i", tmpRoot], { encoding: "utf8", timeout: 3000 });
    const lines = output.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = lines.at(-1).split(/\s+/);
    if (parts.length >= 5) {
      return {
        mount: parts[0] || "",
        total_inodes: parseInt(parts[1], 10) || 0,
        used_inodes: parseInt(parts[2], 10) || 0,
        free_inodes: parseInt(parts[3], 10) || 0,
        used_pct: parts[4] || "0%",
      };
    }
  } catch {
    // Platform may not support df -i.
  }
  return null;
}

/** Clean up aged or over-budget GPTWork-owned entries from a temp root. */
export async function cleanupSystemTmp({
  tmpRoot = "/tmp",
  dryRun = true,
  maxAgeMs,
  maxBytes,
  maxCount,
  maxInodes = 50_000,
  protectPrefixes = [],
}) {
  const effectiveMaxAge = maxAgeMs != null ? maxAgeMs : 24 * 60 * 60 * 1000;
  const effectiveMaxBytes = maxBytes != null ? maxBytes : 1 * 1024 * 1024 * 1024;
  const effectiveMaxCount = maxCount != null ? maxCount : 5000;
  const scan = await scanSystemTmp({ tmpRoot, maxDetail: Number.MAX_SAFE_INTEGER });
  const allEntries = scan.all_entries || scan.entries || [];

  if (allEntries.length === 0) {
    return { dry_run: dryRun, deleted: 0, deleted_bytes: 0, deleted_bytes_h: "0 B", deleted_inodes: 0, skipped: 0, message: "No GPTWork /tmp entries to clean up." };
  }

  const now = Date.now();
  const candidates = allEntries
    .filter((entry) => !protectPrefixes.some((prefix) => entry.name.startsWith(prefix)))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const deleteSet = new Set(candidates.filter((entry) => now - entry.mtimeMs >= effectiveMaxAge).map((entry) => entry.name));

  let remainingBytes = candidates.filter((entry) => !deleteSet.has(entry.name)).reduce((sum, entry) => sum + entry.size, 0);
  let remainingCount = candidates.filter((entry) => !deleteSet.has(entry.name)).length;
  let remainingInodes = candidates.filter((entry) => !deleteSet.has(entry.name)).reduce((sum, entry) => sum + entry.inode_count, 0);
  for (const entry of candidates) {
    if (deleteSet.has(entry.name)) continue;
    if (remainingBytes <= effectiveMaxBytes && remainingCount <= effectiveMaxCount && remainingInodes <= maxInodes) break;
    deleteSet.add(entry.name);
    remainingBytes -= entry.size;
    remainingCount -= 1;
    remainingInodes -= entry.inode_count;
  }

  const entriesToDelete = candidates.filter((entry) => deleteSet.has(entry.name));
  const deletedBytes = entriesToDelete.reduce((sum, entry) => sum + entry.size, 0);
  const deletedInodes = entriesToDelete.reduce((sum, entry) => sum + entry.inode_count, 0);
  if (!dryRun) {
    for (const entry of entriesToDelete) {
      try { await rm(entry.path, { recursive: entry.kind === "directory", force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  }

  return {
    dry_run: dryRun,
    deleted: entriesToDelete.length,
    deleted_bytes: deletedBytes,
    deleted_bytes_h: _humanSize(deletedBytes),
    deleted_inodes: deletedInodes,
    skipped: allEntries.length - entriesToDelete.length,
    message: dryRun
      ? `[dry-run] Would delete ${entriesToDelete.length} GPTWork /tmp entr${entriesToDelete.length === 1 ? "y" : "ies"} (${deletedInodes} inode(s)).`
      : `Deleted ${entriesToDelete.length} GPTWork /tmp entr${entriesToDelete.length === 1 ? "y" : "ies"} (${deletedInodes} inode(s)).`,
  };
}
