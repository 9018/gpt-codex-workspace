import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('normalizes durable audit evidence from acceptance.evidence.json paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-audit-evidence-'));
  try {
    const auditLogPath = join(dir, 'sync-audit.log');
    const acceptanceEvidencePath = join(dir, 'acceptance.evidence.json');
    writeFileSync(auditLogPath, '{"audit_id":"audit_1"}\n', 'utf8');
    writeFileSync(acceptanceEvidencePath, JSON.stringify({
      collected_at: '2026-07-06T19:03:15.486Z',
      result_json: {
        admin_evidence: {
          audit_log_written: true,
          audit_log_path: auditLogPath,
          pre_state_snapshot: { file: 'docs/run-evidence.md', commit: 'before' },
          post_state_snapshot: { file: 'docs/run-evidence.md', commit: 'after' },
          state_delta: { files_changed: 1 },
        },
      },
    }), 'utf8');

    const normalized = normalizeOperationEvidence({
      result: {
        status: 'completed',
        summary: 'external sync repair with durable evidence artifact',
        operation_kind: 'external_sync',
        changed_files: ['docs/run-evidence.md'],
        commit: '37bbf16258ce19a4c865cb3b6c702b4c97ad17eb',
        verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
        evidence_paths: { acceptance_evidence_json: acceptanceEvidencePath },
      },
    });

    assert.equal(normalized.admin_evidence.audit_log_written, true);
    assert.equal(normalized.admin_evidence.audit_log_path, auditLogPath);
    assert.deepEqual(normalized.admin_evidence.pre_state_snapshot, { file: 'docs/run-evidence.md', commit: 'before' });
    assert.deepEqual(normalized.blocking_evidence.admin_evidence, normalized.admin_evidence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes command and evidence-path based audit proof without trusting tests text alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-audit-command-'));
  try {
    const verificationLogPath = join(dir, 'verification.log');
    writeFileSync(verificationLogPath, '# Verification Evidence\nverify audit log exists: exit 0\n', 'utf8');

    const normalized = normalizeOperationEvidence({
      result: {
        status: 'completed',
        summary: 'external sync repair',
        operation_kind: 'external_sync',
        tests: 'audit evidence provided, state snapshots captured',
        verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
        evidence_paths: { verification_log: verificationLogPath },
        pre_state_snapshot: { queued: 2 },
        post_state_snapshot: { queued: 1 },
      },
    });

    assert.equal(normalized.admin_evidence.audit_log_written, true);
    assert.equal(normalized.admin_evidence.command_id, 'verify audit log exists');
    assert.equal(normalized.admin_evidence.audit_evidence_source, 'verification_command_with_artifact');
    assert.deepEqual(normalized.admin_evidence.pre_state_snapshot, { queued: 2 });

    const textOnly = normalizeOperationEvidence({
      result: {
        status: 'completed',
        summary: 'external sync repair',
        operation_kind: 'external_sync',
        tests: 'audit evidence provided, state snapshots captured',
      },
    });

    assert.equal(textOnly.admin_evidence.audit_log_written, false);
    assert.equal(textOnly.blocking_evidence.admin_evidence, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes durable audit proof discovered through events.jsonl acceptance artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-audit-events-'));
  try {
    const acceptanceEvidencePath = join(dir, 'acceptance.evidence.json');
    const eventsPath = join(dir, 'events.jsonl');
    writeFileSync(acceptanceEvidencePath, JSON.stringify({
      result_json: {
        admin_evidence: {
          audit_log_written: true,
          audit_id: 'audit_event_1',
          pre_state_snapshot: { count: 1 },
          post_state_snapshot: { count: 0 },
        },
      },
    }), 'utf8');
    writeFileSync(eventsPath, JSON.stringify({
      type: 'run_evidence.acceptance_evidence',
      artifact: { kind: 'acceptance_evidence_json', path: acceptanceEvidencePath },
      data: { findings_count: 0 },
    }) + '\n', 'utf8');

    const normalized = normalizeOperationEvidence({
      result: {
        status: 'completed',
        summary: 'external sync repair',
        operation_kind: 'external_sync',
        evidence_paths: { events_jsonl: eventsPath },
        verification: { passed: true, commands: [{ cmd: 'validate contract requirements', exit_code: 0 }] },
      },
    });

    assert.equal(normalized.admin_evidence.audit_log_written, true);
    assert.equal(normalized.admin_evidence.audit_id, 'audit_event_1');
    assert.equal(normalized.admin_evidence.audit_evidence_source, 'acceptance_evidence_json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ===========================================================================
// P0-AFC10: Docs-only evidence normalization
// ===========================================================================

test('P0-AFC10: docs_only operation_kind from contract intent', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'updated project status document',
      changed_files: ['docs/current-status.md'],
      commit: 'def456',
      verification: { passed: true, commands: [{ cmd: 'node scripts/release-delivery-check.mjs --fast', exit_code: 0, passed: true }] },
    },
    contract: { id: 'docs-contract', intent: { operation_kind: 'docs_only' } },
  });

  assert.equal(normalized.operation_kind, 'docs_only');
  assert.equal(normalized.integration_not_required, true);
  assert.equal(normalized.noop_result, false);
  assert.equal(normalized.readonly_result, false);
  assert.equal(normalized.already_integrated_result, false);
  assert.equal(normalized.has_changed_files, true);
  assert.equal(normalized.has_commit, true);
});

test('P0-AFC10: docs_only with commit sets has_commit and uses changed_files', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'updated project status document',
      changed_files: ['docs/current-status.md'],
      commit: 'def456',
      verification: { passed: true, commands: [{ cmd: 'node scripts/release-delivery-check.mjs --fast', exit_code: 0, passed: true }] },
    },
    contract: { id: 'docs-contract', intent: { operation_kind: 'docs_only' } },
  });

  assert.equal(normalized.operation_kind, 'docs_only');
  assert.equal(normalized.integration_not_required, true);
  assert.equal(normalized.has_changed_files, true);
  assert.equal(normalized.has_commit, true);
  assert.equal(normalized.commit, 'def456');
  assert.deepEqual(normalized.changed_files, ['docs/current-status.md']);
  assert.equal(normalized.integration.merged, false);
});

test('P0-AFC10: docs_only no profile-level blockers', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'docs update',
      changed_files: ['docs/readme.md'],
      commit: 'ghi789',
      verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0, passed: true }] },
    },
    contract: { id: 'docs-contract-2', intent: { operation_kind: 'docs_only' } },
  });

  const profileBlockers = normalized.blockers.filter(
    (b) => b.code === 'integration_missing' || b.code === 'changed_files_missing' || b.code === 'commit_missing'
  );
  assert.equal(profileBlockers.length, 0);
});

test('P0-AFC10: docs_only operation_kind not mismatched with contract', () => {
  // When the contract says docs_only and the normalizer infers docs_only,
  // there should be NO operation_kind_mismatch blocker.
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'update documentation',
      changed_files: ['docs/guide.md'],
      commit: 'jkl012',
      verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0 }] },
    },
    contract: { id: 'docs-3', intent: { operation_kind: 'docs_only' } },
  });

  const mismatchBlockers = normalized.blockers.filter((b) => b.code === 'operation_kind_mismatch');
  assert.equal(mismatchBlockers.length, 0);
  assert.equal(normalized.operation_kind, 'docs_only');
});

test('P0-AFC10: docs_only isNoopLikeOperation returns true for docs_only', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'docs only',
      changed_files: ['docs/changelog.md'],
      commit: 'mno345',
      verification: { passed: true },
    },
    contract: { id: 'docs-4', intent: { operation_kind: 'docs_only' } },
  });

  // Recovery reason should not include needs_repair for changed_files missing
  // for docs-only (docs_only is in isNoopLikeOperation fallback set)
  assert.equal(normalized.operation_kind, 'docs_only');
});

// ============================================================
// P0-MA22: Verification-Only / No-Mutation Integration Not Required
// ============================================================

test('P0-MA22: verification_only operation_kind sets integration_not_required=true', () => {

  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'verification-only',
      operation_kind: 'verification_only',
      changed_files: [],
      verification: { passed: true },
    },
  });
  assert.equal(normalized.operation_kind, 'verification_only');
  assert.equal(normalized.integration_not_required, true, 'verification_only should set integration_not_required=true');
  assert.equal(normalized.verification_only_result, true, 'verification_only_result boolean should be true');
});

test('P0-MA22: sync_only operation_kind sets integration_not_required=true', () => {

  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'sync-only',
      operation_kind: 'sync_only',
      changed_files: [],
      verification: { passed: true },
    },
  });
  assert.equal(normalized.operation_kind, 'sync_only');
  assert.equal(normalized.integration_not_required, true, 'sync_only should set integration_not_required=true');
});

test('P0-MA22: github_sync_only operation_kind sets integration_not_required=true', () => {

  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'github-sync',
      operation_kind: 'github_sync_only',
      changed_files: [],
      verification: { passed: true },
    },
  });
  assert.equal(normalized.operation_kind, 'github_sync_only');
  assert.equal(normalized.integration_not_required, true, 'github_sync_only should set integration_not_required=true');
});

test('P0-MA22: code_change operation_kind still sets integration_not_required=false', () => {

  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'code change',
      operation_kind: 'code_change',
      changed_files: ['src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true },
    },
  });
  assert.equal(normalized.operation_kind, 'code_change');
  assert.equal(normalized.integration_not_required, false, 'code_change should keep integration_not_required=false');
  assert.equal(normalized.verification_only_result, false, 'verification_only_result should be false for code_change');
});
