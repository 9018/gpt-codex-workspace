import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOperationEvidence } from '../src/evidence-normalizer.mjs';

test('normalizes code_change evidence with verification and integration fields', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'implemented contract verifier',
      operation_kind: 'code_change',
      acceptance_contract_id: 'schema-v1:abc',
      changed_files: ['backend/src/task-verifier.mjs'],
      commit: 'abc123',
      verification: { passed: true, profile: 'changed', commands: ['npm test'], report_path: '.gptwork/reports/release.json' },
      integration: { status: 'merged', merged: true, auto_completed: false },
    },
    contract: { id: 'schema-v1:abc', intent: { operation_kind: 'code_change' } },
  });

  assert.equal(normalized.operation_kind, 'code_change');
  assert.equal(normalized.acceptance_contract_id, 'schema-v1:abc');
  assert.deepEqual(normalized.changed_files, ['backend/src/task-verifier.mjs']);
  assert.equal(normalized.verification.passed, true);
  assert.equal(normalized.integration.merged, true);
  assert.deepEqual(normalized.blockers, []);
});

test('normalizes file_write evidence and reports missing blocking file evidence', () => {
  const ok = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'wrote file',
      operation_kind: 'file_write',
      file_evidence: [{ path: 'out.txt', exists: true, bytes: 10, sha256: 'abc', included_in_commit: true }],
      changed_files: ['out.txt'],
      commit: 'abc123',
    },
  });
  assert.equal(ok.operation_kind, 'file_write');
  assert.equal(ok.file_evidence[0].sha256, 'abc');
  assert.deepEqual(ok.blockers, []);

  const missing = normalizeOperationEvidence({ result: { status: 'completed', summary: 'wrote file', operation_kind: 'file_write' } });
  assert.ok(missing.blockers.some((blocker) => blocker.code === 'file_evidence_missing'));
});

test('normalizes restart, admin_command, diagnostic, and cleanup evidence profiles', () => {
  const restart = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'restart verified',
      operation_kind: 'restart',
      restart_evidence: {
        restart_marker: 'marker.json',
        before_pid: 10,
        after_pid: 11,
        pid_changed: true,
        health_check: { ok: true, status: 200, url: 'http://localhost:3000/health' },
        expected_commit: 'abc',
        running_commit: 'abc',
        runtime_commit_matches: true,
      },
    },
  });
  assert.equal(restart.restart_evidence.pid_changed, true);
  assert.deepEqual(restart.blockers, []);

  const admin = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'admin command done',
      operation_kind: 'admin_command',
      admin_evidence: {
        command_id: 'cmd-1',
        pre_state_snapshot: { queued: 3 },
        post_state_snapshot: { queued: 1 },
        state_delta: { queued: -2 },
        audit_log_written: true,
        exit_code: 0,
      },
    },
  });
  assert.equal(admin.admin_evidence.exit_code, 0);
  assert.deepEqual(admin.blockers, []);

  const diagnostic = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'diagnosed queue',
      operation_kind: 'diagnostic',
      diagnostic_evidence: { summary: 'queue healthy', commands_run: ['status'], report_path: 'report.md', repo_mutated: false },
    },
  });
  assert.equal(diagnostic.commit, null);
  assert.deepEqual(diagnostic.blockers, []);

  const cleanup = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'cleanup done',
      operation_kind: 'cleanup',
      cleanup_evidence: {
        dry_run_summary: 'would remove 2',
        apply_summary: 'removed 2',
        before_counts: { stale: 2, active: 5 },
        after_counts: { stale: 0, active: 5 },
        active_items_preserved: true,
        audit_log_written: true,
      },
    },
  });
  assert.equal(cleanup.cleanup_evidence.active_items_preserved, true);
  assert.deepEqual(cleanup.blockers, []);
});

test('operation kind mismatch and ambiguity require review without blocking quality notes', () => {
  const normalized = normalizeOperationEvidence({
    contract: { intent: { operation_kind: 'restart', semantic_confidence: 'low' } },
    result: {
      status: 'completed',
      summary: 'changed code',
      operation_kind: 'code_change',
      quality_notes: ['naming could improve'],
      followup_findings: [{ code: 'followup_docs', message: 'add docs later' }],
    },
  });

  assert.equal(normalized.requires_review, true);
  assert.ok(normalized.blockers.some((blocker) => blocker.code === 'operation_kind_mismatch'));
  assert.ok(normalized.blockers.some((blocker) => blocker.code === 'semantic_ambiguity'));
  assert.deepEqual(normalized.quality_notes, ['naming could improve']);
  assert.equal(normalized.non_blocking_followups[0].code, 'followup_docs');
});
