import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOperationEvidence } from '../src/evidence/evidence-normalizer.mjs';

test('normalizes code_change evidence with verification and integration fields', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'implemented contract verifier',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
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
      integration: { status: 'merged', merged: true },
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

// ===========================================================================
// P0-MA2: Tests Evidence from verification.commands
// ===========================================================================

test('P0-MA2: derives tests from verification.commands when tests is null', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'code change with null tests',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      tests: null,
      verification: {
        passed: true,
        commands: ['npm test', 'npm run lint'],
      },
    },
  });

  assert.equal(normalized.tests, 'npm test; npm run lint');
  assert.equal(normalized.tests_derived_from_verification, true);
  assert.equal(normalized.has_verification_commands, true);
  assert.deepEqual(normalized.blockers, []);
});

test('P0-MA2: derives tests from verification.commands when tests is "null" string', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'tests null string',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      tests: 'null',
      verification: {
        passed: true,
        commands: [{ cmd: 'npm test', exit_code: 0 }],
      },
    },
  });

  assert.equal(normalized.tests_derived_from_verification, true);
  assert.ok(normalized.tests.includes('npm test'));
});

test('P0-MA2: uses original tests field when present (not derived)', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'has tests',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      tests: 'npm test: passed 15/15',
      verification: {
        passed: true,
        commands: ['npm test'],
      },
    },
  });

  assert.equal(normalized.tests, 'npm test: passed 15/15');
  assert.equal(normalized.tests_derived_from_verification, false);
});

test('P0-MA2: uses verification.report_path as fallback tests evidence', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'report-based verification',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      tests: null,
      verification: {
        passed: true,
        report_path: '.gptwork/reports/verification.json',
      },
    },
  });

  assert.ok(normalized.tests.includes('verification report'));
  assert.equal(normalized.tests_derived_from_verification, true);
});

// ===========================================================================
// P0-MA2: Typed Evidence Booleans
// ===========================================================================

test('P0-MA2: noop_result typed boolean from operation_kind', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'noop task',
      operation_kind: 'noop',
    },
  });

  assert.equal(normalized.noop_result, true);
  assert.equal(normalized.integration_not_required, true);
});

test('P0-MA2: readonly_result typed boolean from operation_kind', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'readonly validation',
      operation_kind: 'readonly_validation',
      validation_evidence: { summary: 'ok' },
    },
  });

  assert.equal(normalized.readonly_result, true);
  assert.equal(normalized.integration_not_required, true);
});

test('P0-MA2: already_integrated_result typed boolean from operation_kind', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'already integrated',
      operation_kind: 'already_integrated',
      already_integrated_evidence: { already_integrated: true },
    },
  });

  assert.equal(normalized.already_integrated_result, true);
  assert.equal(normalized.integration_not_required, true);
});

// ===========================================================================
// P0-MA2: Typed Recovery Reasons
// ===========================================================================

test('P0-MA2: typed recovery reason for tests null + verification.commands present', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'tests null but verification commands',
      operation_kind: 'code_change',
      integration: { status: 'merged', merged: true },
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      tests: null,
      verification: {
        passed: true,
        commands: ['npm test'],
      },
    },
  });

  assert.equal(normalized.tests_derived_from_verification, true);
  assert.equal(normalized.typed_recovery_reason.code, 'tests_derived_from_verification_commands');
  assert.equal(normalized.needs_repair, false);
  assert.equal(normalized.needs_review, false);
});

test('P0-MA2: typed recovery reason for missing changed_files in code_change', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'code change without files',
      operation_kind: 'code_change',
      changed_files: [],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      integration: { status: 'merged', merged: true },
    },
  });

  assert.equal(normalized.typed_recovery_reason.code, 'changed_files_missing_recovery');
  assert.equal(normalized.needs_repair, true);
});

test('P0-MA2: typed recovery reason for missing commit in code_change', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'code change without commit',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: null,
      verification: { passed: true, commands: ['npm test'] },
      integration: { status: 'merged', merged: true },
    },
  });

  assert.equal(normalized.typed_recovery_reason.code, 'commit_missing_recovery');
  assert.equal(normalized.needs_repair, true);
});

test('P0-MA2: no typed recovery for noop-like operations with missing fields', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'readonly validation',
      operation_kind: 'readonly_validation',
      validation_evidence: { summary: 'ok' },
    },
  });

  // readonly_validation should not require changed_files or commit
  assert.equal(normalized.blockers.filter(b =>
    b.code && (b.code.includes('changed_files') || b.code.includes('commit'))
  ).length, 0);
  assert.equal(normalized.requires_review, false);
});

// ===========================================================================
// P0-MA2: VCS Head and Branch Fields
// ===========================================================================

test('P0-MA2: normalizes head and branch fields', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'with vcs metadata',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      branch: 'feature/test',
      remote_head: 'def456',
      verification: { passed: true, commands: ['npm test'] },
    },
  });

  assert.equal(normalized.head, 'def456');
  assert.equal(normalized.branch, 'feature/test');
});

// ===========================================================================
// P0-MA2: Acceptance and Integration Status Derivation
// ===========================================================================

test('P0-MA2: derives acceptance_status from contract_verification', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'accepted',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      contract_verification: {
        acceptance_status: 'satisfied',
        blocking_passed: true,
        completion_eligible: true,
      },
    },
  });

  assert.equal(normalized.acceptance_status, 'satisfied');
});

test('P0-MA2: derives integration_status from integration object', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'integrated',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      integration: { status: 'merged', merged: true },
    },
  });

  assert.equal(normalized.integration_status, 'merged');
});

test('P0-MA2: derives closure_terminal_reason from closure_decision', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'closed',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      closure_decision: { reason: 'blocking_gate_passed_clean', status: 'auto_completed_clean' },
    },
  });

  assert.equal(normalized.closure_terminal_reason, 'blocking_gate_passed_clean');
});

test('P0-MA2: derives closure_terminal_reason from finalizer_decision as fallback', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'finalized',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test'] },
      finalizer_decision: { reason: 'terminal_evidence_satisfied' },
    },
  });

  assert.equal(normalized.closure_terminal_reason, 'terminal_evidence_satisfied');
});

// ===========================================================================
// P0-MA2: Has Evidence Helper Fields
// ===========================================================================

test('P0-MA2: has_verification_commands, has_changed_files, has_commit helper fields', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'with helpers',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs', 'backend/src/lib.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: ['npm test', 'npm run lint'] },
    },
  });

  assert.equal(normalized.has_verification_commands, true);
  assert.equal(normalized.has_changed_files, true);
  assert.equal(normalized.has_commit, true);
});

test('P0-MA2: has_verification_commands false when commands empty', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'no commands',
      operation_kind: 'code_change',
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: [] },
    },
  });

  assert.equal(normalized.has_verification_commands, false);
});
