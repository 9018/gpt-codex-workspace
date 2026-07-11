/**
 * review-backlog-convergence.mjs — Review Backlog Convergence Runner
 *
 * Loads gptwork state, runs the review-backlog-reconciler against all
 * non-terminal review items, and writes structured evidence that can be
 * inspected by the acceptance gate.
 *
 * This script produces:
 *   data/review-backlog-convergence.json   — machine-readable census
 *   docs/review-backlog-convergence-YYYY-MM-DD.md — human-readable summary
 *
 * Usage:
 *   node backend/scripts/review-backlog-convergence.mjs
 *
 * @module scripts/review-backlog-convergence
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Dynamic imports to avoid cyclic or early-load issues
// ---------------------------------------------------------------------------

async function main() {
  // 1. Determine state.json path
  const workspaceRoot = process.env.GPTWORK_WORKSPACE_ROOT
    || resolve(REPO_ROOT, "..", "..", "..");
  const statePath = process.env.GPTWORK_STATE_PATH
    || resolve(workspaceRoot, ".gptwork", "state.json");

  if (!existsSync(statePath)) {
    console.error("state.json not found at:", statePath);
    console.error("Try setting GPTWORK_STATE_PATH or running from the gptwork context.");
    process.exit(1);
  }

  // 2. Load StateStore
  const { StateStore } = await import("../src/state-store.mjs");
  const { reconcileReviewBacklog } = await import("../src/review/review-backlog-reconciler.mjs");

  const store = new StateStore({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
  });
  await store.load();
  console.log("State loaded from:", statePath);

  // 3. Run reconciliation
  console.log("Scanning review backlog...");
  const result = await reconcileReviewBacklog({ store });

  // 4. Augment with typed counts
  const state = store.state;
  const allTasks = state.tasks || [];

  const byStatus = {};
  for (const t of allTasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }

  // 5. Build structured census
  const census = {
    scanned_at: result.scanned_at || new Date().toISOString(),
    total_tasks_in_state: allTasks.length,
    scanned_tasks: result.total_scanned || 0,
    reconciled_count: result.reconciled_count || 0,
    still_blocked_count: result.still_blocked_count || 0,
    human_review_count: result.human_review_count || 0,
    typed_recovery_counts: result.typed_recovery_counts || {},
    status_distribution: byStatus,
    tasks: (result.tasks || []).map((t) => ({
      task_id: t.task_id,
      status: t.status,
      reconciled: t.reconciled,
      reconciled_count: t.reconciled_count,
      still_blocking_count: t.still_blocking_count,
      bundle_status: t.bundle_status,
      still_blocking: (t.still_blocking || []).map((b) => ({
        code: b.code,
        severity: b.severity,
        message: b.message?.substring(0, 200),
      })),
      reconciled_findings: (t.reconciled_findings || []).map((f) => ({
        code: f.code,
        message: f.message?.substring(0, 200),
        resolved_by: f.resolved_by,
      })),
    })),
    witness: {
      runner: "review-backlog-convergence.mjs",
      state_path: statePath,
      workspace: workspaceRoot,
      generated_by: "repair_task_4726ea9d",
    },
  };

  // 6. Write data/review-backlog-convergence.json
  const dataDir = resolve(REPO_ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const jsonPath = resolve(dataDir, "review-backlog-convergence.json");
  writeFileSync(jsonPath, JSON.stringify(census, null, 2), "utf-8");
  console.log("Wrote:", jsonPath);

  // 7. Write docs summary
  const docsDir = resolve(REPO_ROOT, "docs");
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

  const dateLabel = new Date().toISOString().split("T")[0];
  const mdPath = resolve(
    docsDir,
    `review-backlog-convergence-${dateLabel}.md`
  );

  const lines = [
    `# Review Backlog Convergence Report — ${dateLabel}`,
    "",
    `Scanned at: ${census.scanned_at}`,
    "",
    "## Summary",
    "",
    `| Metric | Count |`,
    `|---|---|`,
    `| Total tasks in state | ${census.total_tasks_in_state} |`,
    `| Scanned (review-relevant) | ${census.scanned_tasks} |`,
    `| Reconciled | ${census.reconciled_count} |`,
    `| Still blocked | ${census.still_blocked_count} |`,
    `| Human review required | ${census.human_review_count} |`,
    "",
    "## Typed Recovery Counts",
    "",
  ];

  const tcs = census.typed_recovery_counts;
  if (Object.keys(tcs).length > 0) {
    for (const [code, count] of Object.entries(tcs).sort()) {
      lines.push(`- ${code}: ${count}`);
    }
  } else {
    lines.push("(no typed recovery counts recorded)");
  }

  lines.push("", "## Status Distribution", "");
  const sd = census.status_distribution;
  for (const [status, count] of Object.entries(sd).sort()) {
    lines.push(`- ${status}: ${count}`);
  }

  lines.push(
    "",
    "## Still-Blocked Tasks",
    "",
  );

  const blockedTasks = (census.tasks || []).filter(
    (t) => t.still_blocking_count > 0
  );
  if (blockedTasks.length > 0) {
    for (const t of blockedTasks) {
      lines.push(`### ${t.task_id} (bundle: ${t.bundle_status})`);
      for (const b of t.still_blocking) {
        lines.push(`- **${b.code}** (${b.severity}): ${b.message}`);
      }
    }
  } else {
    lines.push("No still-blocked tasks remaining.");
  }

  lines.push(
    "",
    "## Witness",
    "",
    `- Runner: \`${census.witness.runner}\``,
    `- State path: \`${census.witness.state_path}\``,
    `- Generated by: \`${census.witness.generated_by}\``,
    "",
  );

  writeFileSync(mdPath, lines.join("\n"), "utf-8");
  console.log("Wrote:", mdPath);

  // 8. Print summary to stdout
  console.log("\n=== Convergence Summary ===");
  console.log(`Scanned: ${census.scanned_tasks}`);
  console.log(`Reconciled: ${census.reconciled_count}`);
  console.log(`Still blocked: ${census.still_blocked_count}`);
  console.log(`Human review: ${census.human_review_count}`);
}

main().catch((err) => {
  console.error("Convergence script failed:", err);
  process.exit(1);
});
