import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyAcceptanceContract } from '../src/acceptance/contract-verifier.mjs';

function contract(kind, extra = {}) {
  return {
    id: 'schema-v1:test',
    schema_version: 1,
    intent: { operation_kind: kind, semantic_confidence: 'high', ...(extra.intent || {}) },
    requirements: { requires_commit: false, requires_integration: false, ...(extra.requirements || {}) },
    blocking_requirements: extra.blocking_requirements || [],
    state_assertions: extra.state_assertions || [],
    verification_plan: extra.verification_plan || {},
    completion_policy: { auto_complete_when_blocking_requirements_pass: true, allow_completed_with_followups: true, do_not_block_on_quality_notes: true, ...(extra.completion_policy || {}) },
    review_policy: { requires_review_when: [], ...(extra.review_policy || {}) },
  };
}

test('code_change contract is satisfied when blocking evidence and assertions pass', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('code_change', {
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
    }),
    result: {
      status: 'completed',
      summary: 'done',
      operation_kind: 'code_change',
      changed_files: ['src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      integration: { merged: true, status: 'merged' },
      quality_notes: ['extract helper later'],
      followup_findings: [{ code: 'docs_followup', message: 'add docs' }],
    },
    verification: { passed: true },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.contract_valid, true);
  assert.equal(verification.blocking_passed, true);
  assert.equal(verification.acceptance_status, 'satisfied');
  assert.equal(verification.completion_eligible, true);
  assert.equal(verification.requires_review, false);
  assert.deepEqual(verification.blockers, []);
  assert.deepEqual(verification.quality_notes, ['extract helper later']);
  assert.equal(verification.non_blocking_followups[0].code, 'docs_followup');
});

test('operation-specific contracts accept file_write, restart, admin_command, diagnostic, and cleanup evidence', () => {
  const cases = [
    {
      kind: 'file_write',
      c: contract('file_write', { requirements: { requires_commit: true }, blocking_requirements: [{ id: 'file_exists' }, { id: 'file_checksum' }, { id: 'diff_reported' }, { id: 'commit_present' }] }),
      r: { status: 'completed', summary: 'file', operation_kind: 'file_write', file_evidence: [{ path: 'out.txt', exists: true, bytes: 3, sha256: 'abc' }], changed_files: ['out.txt'], commit: 'abc123' },
    },
    {
      kind: 'restart',
      c: contract('restart', { blocking_requirements: [{ id: 'restart_performed' }, { id: 'process_status_evidence' }, { id: 'runtime_health_evidence' }] }),
      r: { status: 'completed', summary: 'restart', operation_kind: 'restart', restart_evidence: { restart_marker: 'm', before_pid: 1, after_pid: 2, pid_changed: true, health_check: { ok: true, status: 200 } } },
    },
    {
      kind: 'admin_command',
      c: contract('admin_command', { blocking_requirements: [{ id: 'pre_state_snapshot' }, { id: 'command_result' }, { id: 'post_state_snapshot' }, { id: 'audit_evidence' }] }),
      r: { status: 'completed', summary: 'admin', operation_kind: 'admin_command', admin_evidence: { command_id: 'c', pre_state_snapshot: {}, post_state_snapshot: {}, state_delta: {}, audit_log_written: true, exit_code: 0 } },
    },
    {
      kind: 'diagnostic',
      c: contract('diagnostic', { blocking_requirements: [{ id: 'diagnostic_report' }, { id: 'no_mutation_evidence' }] }),
      r: { status: 'completed', summary: 'diag', operation_kind: 'diagnostic', diagnostic_evidence: { summary: 'ok', commands_run: ['status'], report_path: 'diag.md', repo_mutated: false } },
    },
    {
      kind: 'cleanup',
      c: contract('cleanup', { blocking_requirements: [{ id: 'dry_run_evidence' }, { id: 'apply_evidence' }, { id: 'before_after_counts' }, { id: 'active_items_preserved' }, { id: 'audit_evidence' }] }),
      r: { status: 'completed', summary: 'cleanup', operation_kind: 'cleanup', cleanup_evidence: { dry_run_summary: '2', apply_summary: '2', before_counts: { stale: 2 }, after_counts: { stale: 0 }, active_items_preserved: true, audit_log_written: true } },
    },
  ];

  for (const item of cases) {
    const verification = verifyAcceptanceContract({ contract: item.c, result: item.r, verification: { passed: true }, stateAssertions: { passed: true, assertions: [], failures: [] } });
    assert.equal(verification.acceptance_status, 'satisfied', item.kind);
    assert.equal(verification.requires_review, false, item.kind);
  }
});

test('missing blocking evidence and state assertion failures require review', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('code_change', {
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'integration_completed' }],
    }),
    result: { status: 'completed', summary: 'done', operation_kind: 'code_change', verification: { passed: true } },
    verification: { passed: true },
    stateAssertions: { passed: false, failures: [{ kind: 'repo_clean', evidence: { status: ' M file' } }] },
  });

  assert.equal(verification.blocking_passed, false);
  assert.equal(verification.acceptance_status, 'unsatisfied');
  assert.equal(verification.completion_eligible, false);
  assert.equal(verification.requires_review, true);
  assert.ok(verification.blockers.some((blocker) => blocker.code === 'commit_present_missing'));
  assert.ok(verification.blockers.some((blocker) => blocker.code === 'state_assertion_failed'));
});

test('semantic ambiguity and legacy missing contract are indeterminate review cases', () => {
  const ambiguous = verifyAcceptanceContract({
    contract: contract('restart', { intent: { semantic_confidence: 'low' }, review_policy: { requires_review_when: ['semantic_ambiguity'] } }),
    result: { status: 'completed', summary: 'restart', operation_kind: 'restart', restart_evidence: { restart_marker: 'm', before_pid: 1, after_pid: 2, pid_changed: true, health_check: { ok: true } } },
    verification: { passed: true },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });
  assert.equal(ambiguous.acceptance_status, 'indeterminate');
  assert.equal(ambiguous.requires_review, true);

  const legacy = verifyAcceptanceContract({ result: { status: 'completed', summary: 'legacy', verification: { passed: true } }, verification: { passed: true } });
  assert.equal(legacy.contract_valid, false);
  assert.equal(legacy.acceptance_status, 'indeterminate');
  assert.equal(legacy.requires_review, true);
  assert.ok(legacy.blockers.some((blocker) => blocker.code === 'acceptance_contract_missing'));
});
