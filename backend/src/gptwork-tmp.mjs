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
// System /tmp scanning (files under /tmp with GPTWork prefixes)
// ---------------------------------------------------------------------------

/**
 * Scan /tmp for GPTWork-owned temp files using readdir (never shell globs).
 * This covers legacy files like /tmp/.gptwork-task-* and /tmp/gptwork-*.
 *
 * @returns {Promise<{
 *   file_count: number,
 *   total_bytes: number,
 *   total_bytes_h: string,
 *   oldest: object|null,
 *   newest: object|null,
 *   files: Array<object>
 * }>}
 */
export async function scanSystemTmp() {
  const dir = "/tmp";
  const prefixes = [".gptwork-task-", "gptwork-"];
  const matched = [];
  let totalBytes = 0;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { file_count: 0, total_bytes: 0, total_bytes_h: "0 B", oldest: null, newest: null, files: [] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!prefixes.some((p) => entry.name.startsWith(p))) continue;

    const fullPath = join(dir, entry.name);
    try {
      const s = await stat(fullPath);
      matched.push({
        name: entry.name,
        path: fullPath,
        size: s.size,
        size_h: _humanSize(s.size),
        mtimeMs: s.mtimeMs,
        mtimeIso: new Date(s.mtimeMs).toISOString(),
      });
      totalBytes += s.size;
    } catch {
      // best effort
    }
  }

  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    file_count: matched.length,
    total_bytes: totalBytes,
    total_bytes_h: _humanSize(totalBytes),
    oldest: matched.length > 0
      ? { name: matched[matched.length - 1].name, mtime: matched[matched.length - 1].mtimeIso }
      : null,
    newest: matched.length > 0
      ? { name: matched[0].name, mtime: matched[0].mtimeIso }
      : null,
    files: matched.slice(0, 100), // Limit detailed listing
  };
}

/**
 * Basic inode/pressure diagnostic: runs `df -i` and parses output.
 * Returns null if unavailable (permission, platform, etc.).
 *
 * @returns {Promise<object|null>}
 */
export async function getInodePressure() {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("df -i /tmp 2>/dev/null || true", { encoding: "utf8", timeout: 3000 });
    const lines = output.trim().split("\n");
    if (lines.length < 2) return null;
    // Parse: Filesystem     Inodes IUsed IFree IUse% Mounted on
    const parts = lines[1].split(/\s+/);
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
    // Platform may not support df -i, or not available
  }
  return null;
}

/**
 * Clean up GPTWork-owned /tmp files with age/count/byte budgets.
 * Uses readdir-based batches, never shell globs.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true]
 * @param {number} [opts.maxAgeMs=86400000]
 * @param {number} [opts.maxBytes=1073741824]
 * @param {number} [opts.maxCount=5000]
 * @param {string[]} [opts.protectPrefixes] - File prefixes to preserve
 * @returns {Promise<object>}
 */
export async function cleanupSystemTmp({
  dryRun = true,
  maxAgeMs,
  maxBytes,
  maxCount,
  protectPrefixes = [],
}) {
  const effectiveMaxAge = maxAgeMs != null ? maxAgeMs : 24 * 60 * 60 * 1000;
  const effectiveMaxBytes = maxBytes != null ? maxBytes : 1 * 1024 * 1024 * 1024;
  const effectiveMaxCount = maxCount != null ? maxCount : 5000;

  const scan = await scanSystemTmp();

  if (scan.file_count === 0) {
    return {
      dry_run: dryRun,
      deleted: 0,
      deleted_bytes: 0,
      deleted_bytes_h: "0 B",
      skipped: 0,
      message: "No GPTWork /tmp files to clean up.",
    };
  }

  const now = Date.now();
  let candidates = scan.files.filter((f) => {
    for (const p of protectPrefixes) {
      if (f.name.startsWith(p)) return false;
    }
    return true;
  });

  // Sort oldest first for FIFO eviction
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const deleteSet = new Set();

  // Phase 1: age-expired files
  for (const f of candidates) {
    if (now - f.mtimeMs >= effectiveMaxAge) {
      deleteSet.add(f.name);
    }
  }

  // Phase 2: byte budget — evict oldest until under budget
  let remainingBytes = candidates
    .filter((f) => !deleteSet.has(f.name))
    .reduce((s, f) => s + f.size, 0);
  if (remainingBytes > effectiveMaxBytes) {
    for (const f of candidates) {
      if (deleteSet.has(f.name)) continue;
      if (remainingBytes <= effectiveMaxBytes) break;
      deleteSet.add(f.name);
      remainingBytes -= f.size;
    }
  }

  // Phase 3: count budget — evict oldest until under budget
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
      try {
        await rm(f.path, { force: true });
      } catch {
        // best effort
      }
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
