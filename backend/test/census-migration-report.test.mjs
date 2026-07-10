import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(__dirname, '..', 'data', 'census-migration-report.json');

// =========================================================================
// P0-MA1: Census Migration Report Test
// =========================================================================

describe('census-migration-report', () => {
  it('report file exists and is valid JSON', () => {
    assert.ok(existsSync(reportPath), `Report file not found at ${reportPath}`);
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    assert.equal(report.report_type, 'p0_ma1_census_migration');
    assert.ok(report.generated_at);
  });

  it('evidence has all required sections', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const evidenceKeys = Object.keys(report.evidence);
    
    const required = ['backup', 'dry_run', 'apply', 'counts', 'before_count', 'after_count', 'rollback'];
    for (const key of required) {
      assert.ok(evidenceKeys.includes(key), `Missing evidence key: ${key}`);
    }
  });

  it('backup evidence has valid git sha', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const backup = report.evidence.backup;
    assert.ok(backup.head_sha);
    assert.match(backup.head_sha, /^[0-9a-f]{7,40}$/);
    assert.ok(backup.restore_command);
  });

  it('dry_run evidence contains census result structure', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const dryRun = report.evidence.dry_run;
    assert.ok(dryRun.scanned_at);
    assert.equal(typeof dryRun.total_tasks, 'number');
    assert.equal(typeof dryRun.backlog_tasks, 'number');
    assert.ok(dryRun.legacy_review_migration);
    assert.ok(dryRun.convergence_report);
  });

  it('apply evidence is dry_run mode and read-only', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const apply = report.evidence.apply;
    assert.equal(apply.execution_mode, 'dry_run');
    assert.equal(apply.state_modification, false);
    assert.equal(apply.migration_tool, 'backlog-census.mjs (classifyBlocker + scanBacklogCensus)');
  });

  it('counts evidence has before/after/delta', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const counts = report.evidence.counts;
    assert.ok(counts.before);
    assert.ok(counts.after);
    assert.equal(typeof counts.delta, 'number');
  });

  it('before and after counts are consistent', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const before = report.evidence.before_count;
    const after = report.evidence.after_count;
    assert.equal(before.codex_tasks, after.codex_tasks);
    assert.equal(before.backlog_tasks, after.backlog_tasks);
    assert.equal(after.state_unchanged, true);
  });

  it('rollback plan has steps and strategy', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const rollback = report.evidence.rollback;
    assert.ok(rollback.rollback_strategy);
    assert.ok(Array.isArray(rollback.steps));
    assert.ok(rollback.steps.length > 0);
    assert.ok(rollback.risk_level);
  });

  it('convergence report is self-consistent', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    const convergence = report.evidence.dry_run.convergence_report || {};
    assert.equal(typeof convergence.total_blockers, 'number');
    if (convergence.recommended_actions) {
      assert.ok(Array.isArray(convergence.recommended_actions));
    }
  });

  it('state path is recorded', () => {
    const raw = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    assert.ok(report.state_path);
    assert.ok(report.state_path.includes('state.json'));
  });
});
