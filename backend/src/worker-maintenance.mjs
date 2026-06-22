/**
 * worker-maintenance.mjs — Worker-throttled idle maintenance pass.
 *
 * Runs on worker startup and periodically during idle ticks.
 * Checks goal storage and tmp file pressure thresholds and logs dry-run
 * recommendations. Never auto-applies cleanup unless explicitly configured
 * via env var GPTWORK_AUTO_MAINTENANCE=true (case-insensitive "true").
 *
 * Default behaviour: log-only / dry-run. All warnings go to the GPTWORK_LOG_PATH.
 */

import { appendFileSync } from "node:fs";
import { scanGoals } from "./goal-storage-service.mjs";
import { scanManagedTmp, scanSystemTmp, getInodePressure } from "./gptwork-tmp.mjs";

// ---------------------------------------------------------------------------
// Constants (mirroring goal-storage-service.mjs defaults)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_GOAL_DIRS = 100;
const DEFAULT_MAX_FILES = 5000;

/** Warn when total goal dirs exceed this fraction of the max. */
const GOAL_DIRS_WARN_THRESHOLD = 0.85;
/** Warn when total files exceed this fraction of the max. */
const GOAL_FILES_WARN_THRESHOLD = 0.85;
/** Warn when managed tmp file count exceeds this. */
const TMP_COUNT_WARN = 1000;
/** Warn when managed tmp bytes exceeds this (500 MB). */
const TMP_BYTES_WARN = 500 * 1024 * 1024;
/** Warn when inode use exceeds this percentage. */
const INODE_WARN_PCT = 85;

// ---------------------------------------------------------------------------
// Maintenance execution
// ---------------------------------------------------------------------------

export async function runIdleMaintenance(workspaceRoot, { log, dryRunOnly = true } = {}) {
  const _log = log || ((msg) => {
    const lp = process.env.GPTWORK_LOG_PATH;
    if (lp) appendFileSync(lp, `[gptwork-maintenance] ${msg}\n`);
  });

  const warnings = [];

  let gs, mt, st, ip;

  try {
    // ── Goal storage check ───────────────────────────────────────────────
    gs = await scanGoals(workspaceRoot);
    if (gs.goal_dir_count > Math.round(DEFAULT_MAX_GOAL_DIRS * GOAL_DIRS_WARN_THRESHOLD)) {
      warnings.push(
        `Goal dirs ${gs.goal_dir_count} approaching max ${DEFAULT_MAX_GOAL_DIRS}. ` +
        `Run: bin/gptwork.mjs goals cleanup --dry-run to preview, --apply to archive terminal goals.`
      );
    }
    if (gs.total_files > Math.round(DEFAULT_MAX_FILES * GOAL_FILES_WARN_THRESHOLD)) {
      warnings.push(
        `Goal files ${gs.total_files} approaching max ${DEFAULT_MAX_FILES}. ` +
        `Run: bin/gptwork.mjs goals cleanup --dry-run to preview, --apply to archive terminal goals.`
      );
    }

    // ── Managed tmp check ────────────────────────────────────────────────
    mt = await scanManagedTmp({ workspaceRoot });
    if (mt.fileCount > TMP_COUNT_WARN) {
      warnings.push(
        `Managed tmp files ${mt.fileCount} exceeds ${TMP_COUNT_WARN}. ` +
        `Run: bin/gptwork.mjs tmp cleanup --dry-run to preview, --apply to clean.`
      );
    }
    if (mt.totalBytes > TMP_BYTES_WARN) {
      warnings.push(
        `Managed tmp bytes ${(mt.totalBytes / 1024 / 1024).toFixed(1)} MB exceeds ${TMP_BYTES_WARN / 1024 / 1024} MB. ` +
        `Run: bin/gptwork.mjs tmp cleanup --dry-run to preview.`
      );
    }

    // ── System /tmp check ────────────────────────────────────────────────
    st = await scanSystemTmp();
    if (st.file_count > TMP_COUNT_WARN) {
      warnings.push(
        `System /tmp GPTWork files ${st.file_count} exceeds ${TMP_COUNT_WARN}. ` +
        `Run: bin/gptwork.mjs tmp cleanup --dry-run to preview.`
      );
    }

    // ── Inode pressure ──────────────────────────────────────────────────
    ip = await getInodePressure();
    if (ip && parseInt(ip.used_pct, 10) >= INODE_WARN_PCT) {
      warnings.push(
        `Inode pressure ${ip.used_pct} on /tmp (${ip.free_inodes} free). ` +
        `Consider tmp cleanup if GPTWork-owned files are contributing.`
      );
    }
  } catch (err) {
    _log(`Error during idle maintenance: ${err.message}`);
    return { ok: false, error: err.message, warnings: [] };
  }

  // Report warnings
  for (const w of warnings) {
    _log(`WARNING: ${w}`);
  }

  if (warnings.length === 0) {
    _log(`OK: goal_dirs=${gs?.goal_dir_count ?? "?"} tmp_files=${mt?.fileCount ?? "?"} inode_ok=${ip?.used_pct ?? "?"}`);
  }

  return { ok: true, warnings, dry_run: dryRunOnly };
}
