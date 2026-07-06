#!/usr/bin/env node
/**
 * release-storage-pressure.mjs — Storage pressure release gate check.
 *
 * Evaluates storage pressure on git branches, worktrees, retained worktrees,
 * and overall state file counts. Returns GO if all categories are within
 * threshold, NO-GO with blockers if any threshold is exceeded.
 *
 * Usage:
 *   node scripts/release-storage-pressure.mjs
 *   node scripts/release-storage-pressure.mjs --threshold 100 --json-report /path/to/report.json
 */

import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(BACKEND_ROOT, "src");

// ---------------------------------------------------------------------------
// Thresholds (overridable via env or CLI)
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const BRANCH_WARN_FACTOR = 2;
const BRANCH_BLOCK_FACTOR = 4;
const WORKTREE_WARN_FACTOR = 2;
const WORKTREE_BLOCK_FACTOR = 4;
const STATE_RECORD_WARN = 500;
const STATE_RECORD_BLOCK = 1000;

const CLI_THRESHOLD = (() => {
  const idx = process.argv.indexOf("--threshold");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const v = parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

async function checkStoragePressure({ workspaceRoot, threshold } = {}) {
  const started = Date.now();
  const checks = [];

  const wsRoot = workspaceRoot || BACKEND_ROOT;
  const retThreshold = threshold || CLI_THRESHOLD || DEFAULT_LIMIT;

  const { StateStore } = await import(join(SRC_DIR, "state-store.mjs"));
  const store = new StateStore({
    statePath: join(wsRoot, ".gptwork", "state.json"),
    defaultWorkspaceRoot: wsRoot,
    defaultRepoPath: wsRoot,
  });
  await store.load();

  const { retentionStatus } = await import(join(SRC_DIR, "retention-service.mjs"));
  const report = await retentionStatus({ config: {}, store, workspaceRoot: wsRoot });

  // ── Check 1: git_branches ──────────────────────────────────────────
  const branchesFamily = report.families.find((f) => f.name === "git_branches");
  if (branchesFamily) {
    const total = branchesFamily.current_count;
    const terminal = branchesFamily.terminal || 0;
    if (total > retThreshold * BRANCH_BLOCK_FACTOR) {
      checks.push({ check: "git_branches", passed: false, severity: "BLOCKER", detail: `${total} total git branches exceeds block threshold ${retThreshold * BRANCH_BLOCK_FACTOR} (terminal=${terminal})` });
    } else if (total > retThreshold * BRANCH_WARN_FACTOR) {
      checks.push({ check: "git_branches", passed: true, severity: "WARN", detail: `${total} git branches exceeds warn threshold ${retThreshold * BRANCH_WARN_FACTOR} (terminal=${terminal})`, advisory: "Consider pruning terminal branches with retention_cleanup" });
    } else {
      checks.push({ check: "git_branches", passed: true, severity: "INFO", detail: `${total} git branches, ${terminal} terminal (limit=${retThreshold})` });
    }
  } else {
    checks.push({ check: "git_branches", passed: true, severity: "INFO", detail: "not available" });
  }

  // ── Check 2: git_worktrees ────────────────────────────────────────
  const worktreesFamily = report.families.find((f) => f.name === "git_worktrees");
  if (worktreesFamily) {
    const total = worktreesFamily.current_count;
    const terminal = worktreesFamily.terminal || 0;
    if (total > retThreshold * WORKTREE_BLOCK_FACTOR) {
      checks.push({ check: "git_worktrees", passed: false, severity: "BLOCKER", detail: `${total} git worktrees exceeds block threshold ${retThreshold * WORKTREE_BLOCK_FACTOR} (terminal=${terminal})` });
    } else if (total > retThreshold * WORKTREE_WARN_FACTOR) {
      checks.push({ check: "git_worktrees", passed: true, severity: "WARN", detail: `${total} git worktrees exceeds warn threshold ${retThreshold * WORKTREE_WARN_FACTOR} (terminal=${terminal})`, advisory: "Consider removing terminal worktrees" });
    } else {
      checks.push({ check: "git_worktrees", passed: true, severity: "INFO", detail: `${total} git worktrees, ${terminal} terminal (limit=${retThreshold})` });
    }
  } else {
    checks.push({ check: "git_worktrees", passed: true, severity: "INFO", detail: "not available" });
  }

  // ── Check 3: retained worktrees ────────────────────────────────────
  const retainedFamily = report.families.find((f) => f.name === "retained_worktrees");
  if (retainedFamily) {
    const total = retainedFamily.current_count;
    const terminal = retainedFamily.terminal || 0;
    if (terminal > retThreshold * WORKTREE_BLOCK_FACTOR) {
      checks.push({ check: "retained_worktrees", passed: false, severity: "BLOCKER", detail: `${terminal} removable retained worktrees exceeds block threshold ${retThreshold * WORKTREE_BLOCK_FACTOR} (total=${total})` });
    } else if (terminal > retThreshold * WORKTREE_WARN_FACTOR) {
      checks.push({ check: "retained_worktrees", passed: true, severity: "WARN", detail: `${terminal} removable retained worktrees exceeds warn threshold ${retThreshold * WORKTREE_WARN_FACTOR} (total=${total})`, advisory: "Run retention_cleanup with apply=true to remove terminal retained worktrees" });
    } else {
      checks.push({ check: "retained_worktrees", passed: true, severity: "INFO", detail: `${total} retained worktrees, ${terminal} removable` });
    }
  } else {
    checks.push({ check: "retained_worktrees", passed: true, severity: "INFO", detail: "not available" });
  }

  // ── Check 4: total state records ────────────────────────────────────
  const totalRecords = report.summary?.total_records || 0;
  if (totalRecords > STATE_RECORD_BLOCK) {
    checks.push({ check: "state_records", passed: false, severity: "BLOCKER", detail: `${totalRecords} total state records exceeds block threshold ${STATE_RECORD_BLOCK}` });
  } else if (totalRecords > STATE_RECORD_WARN) {
    checks.push({ check: "state_records", passed: true, severity: "WARN", detail: `${totalRecords} total state records exceeds warn threshold ${STATE_RECORD_WARN}`, advisory: "Run retention_cleanup with apply=true to reduce state records" });
  } else {
    checks.push({ check: "state_records", passed: true, severity: "INFO", detail: `${totalRecords} total state records (warn=${STATE_RECORD_WARN}, block=${STATE_RECORD_BLOCK})` });
  }

  // ── Check 5: storage_pressure summary ──────────────────────────────
  const pressure = report.summary?.storage_pressure;
  if (pressure) {
    const pruneTotal = (pressure.branch_prune_candidates || 0) + (pressure.worktree_prune_candidates || 0) + (pressure.retained_worktree_removable || 0);
    const orphanTotal = (pressure.total_orphaned_branches || 0) + (pressure.total_orphaned_worktrees || 0);
    const overLimitCats = [pressure.branch_over_limit ? "branches" : null, pressure.worktree_over_limit ? "worktrees" : null, pressure.retained_worktree_over_limit ? "retained_worktrees" : null].filter(Boolean);

    if (overLimitCats.length > 2) {
      checks.push({ check: "storage_pressure", passed: false, severity: "BLOCKER", detail: `${overLimitCats.length} categories over limit: ${overLimitCats.join(", ")} (prune candidates: ${pruneTotal})` });
    } else if (overLimitCats.length > 0) {
      checks.push({ check: "storage_pressure", passed: true, severity: "WARN", detail: `${overLimitCats.length} category(ies) over limit: ${overLimitCats.join(", ")} (prune: ${pruneTotal}, orphaned: ${orphanTotal})`, advisory: "Run retention_cleanup or retention_status for details" });
    } else {
      checks.push({ check: "storage_pressure", passed: true, severity: "INFO", detail: `all categories within limit (prune: ${pruneTotal}, orphaned: ${orphanTotal})` });
    }
  } else {
    checks.push({ check: "storage_pressure", passed: true, severity: "INFO", detail: "not available" });
  }

  // ── Check 6: families_over_limit ──────────────────────────────────
  const familiesOver = report.summary?.families_over_limit || 0;
  if (familiesOver > 3) {
    checks.push({ check: "families_over_limit", passed: false, severity: "BLOCKER", detail: `${familiesOver} families over retention limit` });
  } else if (familiesOver > 0) {
    checks.push({ check: "families_over_limit", passed: true, severity: "WARN", detail: `${familiesOver} families over retention limit`, advisory: "Run retention_cleanup with apply=true" });
  } else {
    checks.push({ check: "families_over_limit", passed: true, severity: "INFO", detail: "all families within retention limit" });
  }

  // ── Summary ────────────────────────────────────────────────────────
  const blockers = checks.filter((c) => !c.passed && c.severity === "BLOCKER");
  const warnings = checks.filter((c) => c.passed && c.severity === "WARN");
  const goNoGo = blockers.length === 0 ? "GO" : "NO-GO";
  const durationMs = Date.now() - started;

  return {
    gate_version: "1.0.0",
    scenario: "storage-pressure",
    passed: goNoGo === "GO",
    started_at: new Date(started).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
    threshold: retThreshold,
    go_no_go: goNoGo,
    checks,
    summary: {
      total_checks: checks.length,
      passed_checks: checks.filter((c) => c.passed).length,
      failed_checks: checks.filter((c) => !c.passed).length,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    families: report.families.map((f) => ({
      name: f.name,
      current_count: f.current_count,
      active: f.active_count,
      terminal: f.terminal_count,
      proposed_action: f.proposed_action,
    })),
    storage_pressure: pressure || null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const jsonReportPath = argValue("--json-report");
  const report = await checkStoragePressure({ workspaceRoot: BACKEND_ROOT, threshold: CLI_THRESHOLD || undefined });

  console.log(`\n==========================================================`);
  console.log(`  GPTWork Storage Pressure Release Gate v${report.gate_version}`);
  console.log(`  Scenario: storage-pressure`);
  console.log(`==========================================================\n`);
  console.log(`Threshold: ${report.threshold} per category\n`);
  console.log(`Duration: ${formatDuration(report.duration_ms)}`);
  console.log(`Result: ${report.go_no_go}\n`);

  console.log(`  [Checks]`);
  for (const check of report.checks) {
    const icon = check.passed ? (check.severity === "WARN" ? "~" : "\u2713") : "\u2717";
    console.log(`  ${icon} ${check.check}: ${check.detail || ""}`);
    if (check.advisory) console.log(`       advisory: ${check.advisory}`);
  }

  if (report.blockers?.length > 0) {
    console.log(`\n--- BLOCKERS (${report.blockers.length}) ---`);
    for (const b of report.blockers) console.log(`  \u2717 ${b.check}: ${b.detail}`);
  }

  if (report.warnings?.length > 0) {
    console.log(`\n--- WARNINGS (${report.warnings.length}) ---`);
    for (const w of report.warnings) console.log(`  ~ ${w.check}: ${w.detail}`);
  }

  console.log(`\n=== ${report.go_no_go} ===`);

  if (jsonReportPath) {
    const absolutePath = resolve(jsonReportPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\njson report: ${jsonReportPath}`);
  }

  process.exit(report.go_no_go === "GO" ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
