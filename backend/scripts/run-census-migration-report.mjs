/**
 * run-census-migration-report.mjs — P0-MA1 Backlog Census Migration Report
 *
 * Dry-run report covering: backup, dry_run, before/after counts, apply, rollback.
 * Never modifies task state.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadStateStore() {
  const candidates = [
    resolve(__dirname, '..', 'data', 'state.json'),
    resolve(__dirname, '..', 'data', 'workspaces', 'default', '.gptwork', 'state.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf-8');
      const data = JSON.parse(raw);
      const tasks = data.tasks || [];
      return { path: p, state: data, tasks };
    } catch { continue; }
  }
  return { path: null, state: null, tasks: [] };
}

function gitBackupReport() {
  try {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const status = execSync('git status --short', { encoding: 'utf-8' });
    return {
      backup_type: 'git_commit_snapshot',
      head_sha: head,
      working_tree_clean: status.trim().length === 0,
      restore_command: `git checkout ${head}`,
      backup_location: 'canonical repository .git/objects',
    };
  } catch (e) {
    return {
      backup_type: 'file_backup',
      error: e.message,
      backup_location: 'state.json',
      restore_command: 'git checkout -- backend/data/state.json',
    };
  }
}

function buildRollbackPlan() {
  return {
    rollback_strategy: 'git_revert',
    steps: [
      '1. Verify backup commit: git rev-parse HEAD',
      '2. If state modified: git checkout HEAD -- backend/data/state.json',
      '3. If manifest modified: git checkout HEAD -- .gptwork/goals/<goal_id>/manifest.json',
      '4. Verify state integrity: compare task counts with backup',
    ],
    verification_command: 'node --test test/backlog-census.test.mjs',
    risk_level: 'low',
    fallback: 'manual review if automated rollback fails',
  };
}

function buildApplyPlan(censusResult) {
  return {
    migration_tool: 'backlog-census.mjs (classifyBlocker + scanBacklogCensus)',
    execution_mode: 'dry_run',
    affected_blockers: censusResult.convergence_report?.total_blockers || 0,
    recommended_actions: Object.entries(censusResult.classification_summary || {}).map(
      ([cls, count]) => `${cls}: ${count} tasks`
    ),
    state_modification: false,
    note: 'Read-only census. Use typed review taxonomy to apply status migrations.',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== P0-MA1: Typed Backlog Census Migration Report ===\n');

  // 1. Load state
  const store = loadStateStore();
  console.log(`State path: ${store.path || 'not found'}`);
  console.log(`Total tasks in store: ${store.tasks.length}`);

  // 2. Backup evidence
  console.log('\n--- [EVIDENCE: backup] ---');
  const backup = gitBackupReport();
  console.log(JSON.stringify(backup, null, 2));

  // 3. Before counts
  console.log('\n--- [EVIDENCE: before_count] ---');
  const codexTasks = store.tasks.filter(t => t.assignee === 'codex');
  const byStatus = {};
  for (const t of codexTasks) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; }
  const backlogStatuses = ['waiting_for_review','waiting_for_repair','waiting_for_integration','failed','timed_out','blocked'];
  const backlogBefore = codexTasks.filter(t => backlogStatuses.includes(t.status)).length;
  console.log(`Codex tasks before: ${codexTasks.length}`);
  console.log(`Backlog tasks before: ${backlogBefore}`);
  console.log(`Status breakdown: ${JSON.stringify(byStatus)}`);

  // 4. Dry-run: run backlog census
  console.log('\n--- [EVIDENCE: dry_run] ---');
  const { runBacklogCensus } = await import('../src/backlog-census.mjs');
  const tasksToScan = store.tasks.length > 0 ? store.tasks : [];
  const censusResult = await runBacklogCensus(tasksToScan);
  console.log(JSON.stringify(censusResult, null, 2));

  console.log('\n--- Census Summary ---');
  console.log(`Scanned at: ${censusResult.scanned_at}`);
  console.log(`Total tasks: ${censusResult.total_tasks} | Backlog: ${censusResult.backlog_tasks}`);

  if (censusResult.classification_summary) {
    console.log(`Classifications:`);
    for (const [cls, count] of Object.entries(censusResult.classification_summary)) {
      console.log(`  ${cls}: ${count}`);
    }
  }
  if (censusResult.convergence_report) {
    console.log(`Convergence: ${censusResult.convergence_report.total_blockers} blockers`);
    console.log(`  Actions: ${JSON.stringify(censusResult.convergence_report.recommended_actions)}`);
  }

  // 5. Apply plan
  console.log('\n--- [EVIDENCE: apply] ---');
  const applyPlan = buildApplyPlan(censusResult);
  console.log(JSON.stringify(applyPlan, null, 2));

  // 6. After counts (same as before — dry-run)
  console.log('\n--- [EVIDENCE: after_count] ---');
  console.log(`Backlog tasks after: ${backlogBefore} (unchanged, dry-run)`);

  // 7. Rollback plan
  console.log('\n--- [EVIDENCE: rollback] ---');
  const rollback = buildRollbackPlan();
  console.log(JSON.stringify(rollback, null, 2));

  // 8. Structured report
  const report = {
    report_type: 'p0_ma1_census_migration',
    generated_at: new Date().toISOString(),
    state_path: store.path,
    evidence: {
      backup,
      before_count: { codex_tasks: codexTasks.length, backlog_tasks: backlogBefore, status_breakdown: byStatus },
      dry_run: censusResult,
      apply: applyPlan,
      after_count: { codex_tasks: codexTasks.length, backlog_tasks: backlogBefore, state_unchanged: true },
      rollback,
    },
  };

  const reportPath = resolve(__dirname, '..', 'data', 'census-migration-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nReport written to: ${reportPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
