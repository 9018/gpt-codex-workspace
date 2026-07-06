import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('docs_check required command is satisfied by concrete backend verification command evidence', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('docs_only', {
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
      verification_plan: { required_commands: ['docs_check'] },
    }),
    result: {
      status: 'completed',
      summary: 'docs updated',
      operation_kind: 'docs_only',
      changed_files: ['docs/guide.md'],
      commit: 'abc123',
      verification: { passed: true, commands: [{ name: 'check:imports', cmd: 'npm', args: ['run', 'check:imports'], cwd: '/repo/backend', exit_code: 0 }] },
      integration: { merged: true, status: 'merged' },
    },
    verification: { passed: true, commands: [{ name: 'check:imports', cmd: 'npm', args: ['run', 'check:imports'], cwd: '/repo/backend', exit_code: 0 }] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.blocking_passed, true);
  assert.equal(verification.acceptance_status, 'satisfied');
  assert.deepEqual(verification.blockers, []);
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

test('external sync contract accepts durable audit evidence from acceptance.evidence.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-contract-audit-'));
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
      acceptance_findings: [],
    }), 'utf8');

    const verification = verifyAcceptanceContract({
      contract: contract('external_sync', {
        blocking_requirements: [{ id: 'audit_evidence' }],
      }),
      result: {
        status: 'completed',
        summary: 'Repair acceptance evidence for docs sync',
        operation_kind: 'external_sync',
        tests: 'audit evidence provided, state snapshots captured',
        verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
        evidence_paths: { acceptance_evidence_json: acceptanceEvidencePath },
      },
      verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
      stateAssertions: { passed: true, assertions: [], failures: [] },
    });

    assert.equal(verification.blocking_passed, true);
    assert.equal(verification.acceptance_status, 'satisfied');
    assert.ok(!verification.blockers.some((entry) => entry.code === 'audit_evidence_missing'));
    assert.equal(verification.normalized_result.admin_evidence.audit_log_written, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('external sync contract rejects text-only audit claims without durable proof', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('external_sync', {
      blocking_requirements: [{ id: 'audit_evidence' }],
    }),
    result: {
      status: 'completed',
      summary: 'Repair acceptance evidence for docs sync',
      operation_kind: 'external_sync',
      tests: 'audit evidence provided, state snapshots captured',
      verification: { passed: true, commands: [{ cmd: 'validate contract requirements', exit_code: 0 }] },
    },
    verification: { passed: true, commands: [{ cmd: 'validate contract requirements', exit_code: 0 }] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.blocking_passed, false);
  assert.ok(verification.blockers.some((entry) => entry.code === 'audit_evidence_missing'));
  assert.equal(verification.normalized_result.admin_evidence.audit_log_written, false);
});

test('code-change docs repair keeps not_required integration terminal while audit evidence is normalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-docs-terminal-'));
  try {
    const acceptanceEvidencePath = join(dir, 'acceptance.evidence.json');
    writeFileSync(acceptanceEvidencePath, JSON.stringify({
      result_json: {
        admin_evidence: {
          audit_log_written: true,
          pre_state_snapshot: { file: 'docs/run-evidence.md' },
          post_state_snapshot: { file: 'docs/run-evidence.md' },
        },
      },
    }), 'utf8');

    const verification = verifyAcceptanceContract({
      contract: contract('code_change', {
        requirements: { requires_commit: true, requires_integration: true },
        blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }, { id: 'audit_evidence' }],
      }),
      result: {
        status: 'completed',
        summary: 'docs-only repair with audit evidence',
        operation_kind: 'code_change',
        changed_files: ['docs/run-evidence.md'],
        commit: '37bbf16258ce19a4c865cb3b6c702b4c97ad17eb',
        tests: 'audit evidence provided, state snapshots captured',
        verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
        evidence_paths: { acceptance_evidence_json: acceptanceEvidencePath },
        integration: { status: 'not_required', required: false, terminal: true, merged: false },
        delivery_result_recovery: { reason: 'already_integrated', recovered: true, commit_integrated: true, commit: '37bbf16258ce19a4c865cb3b6c702b4c97ad17eb' },
      },
      verification: { passed: true, commands: [{ cmd: 'verify audit log exists', exit_code: 0 }] },
      stateAssertions: { passed: true, assertions: [], failures: [] },
    });

    assert.equal(verification.blocking_passed, true);
    assert.equal(verification.acceptance_status, 'satisfied');
    assert.equal(verification.normalized_result.integration.status, 'not_required');
    assert.equal(verification.normalized_result.admin_evidence.audit_log_written, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical repo reachable commit can satisfy stale worktree integration evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-canonical-reach-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'base\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    const verification = verifyAcceptanceContract({
      contract: contract('code_change', {
        requirements: { requires_commit: true, requires_integration: true },
        blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
      }),
      result: {
        status: 'completed',
        summary: 'docs repair already integrated in canonical repo',
        operation_kind: 'code_change',
        changed_files: ['README.md'],
        commit: head,
        tests: 'check:syntax pass',
        verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0 }] },
        repo_resolution: { canonical_repo_path: dir },
      },
      verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0 }] },
      stateAssertions: { passed: true, assertions: [], failures: [] },
    });

    assert.equal(verification.blocking_passed, true);
    assert.equal(verification.normalized_result.integration.status, 'already_integrated');
    assert.equal(verification.normalized_result.delivery_result_recovery.commit_integrated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test('no-change repair satisfies code-change contract when canonical target evidence is present', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('code_change', {
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'diff_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
    }),
    task: { id: 'task_repair_contract', repair_of_task_id: 'task_original', title: 'Repair: already integrated' },
    result: {
      status: 'completed',
      summary: 'No code changes needed because the original target is already integrated in main.',
      operation_kind: 'code_change',
      changed_files: [],
      repair_noop: true,
      already_integrated: true,
      no_change_repair_evidence: {
        affected_files: ['backend/src/auto-integration-completion.mjs'],
        files_match_canonical: true,
        diff_empty: true,
      },
      verification: { passed: true, commands: ['npm --prefix backend run check:syntax'] },
      reviewer_decision: { status: 'accepted', passed: true },
      integration: { status: 'not_required', required: false },
      needs_integration: false,
    },
    verification: { passed: true, commands: ['npm --prefix backend run check:syntax'] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.blocking_passed, true);
  assert.equal(verification.acceptance_status, 'satisfied');
  assert.equal(verification.completion_eligible, true);
  assert.equal(verification.requires_review, false);
  assert.equal(verification.no_change_repair_completion.completion_eligible, true);
  assert.deepEqual(verification.blockers, []);
});

test('no-change repair contract remains blocked when verification is missing', () => {
  const verification = verifyAcceptanceContract({
    contract: contract('code_change', {
      requirements: { requires_commit: true, requires_integration: true },
      blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
    }),
    task: { id: 'task_repair_missing_verification', repair_of_task_id: 'task_original', title: 'Repair: already integrated' },
    result: {
      status: 'completed',
      summary: 'No code changes needed because the original target is already integrated in main.',
      operation_kind: 'code_change',
      changed_files: [],
      repair_noop: true,
      already_integrated: true,
      no_change_repair_evidence: { affected_files: ['backend/src/x.mjs'], files_match_canonical: true },
      reviewer_decision: { status: 'accepted', passed: true },
      integration: { status: 'not_required', required: false },
      needs_integration: false,
    },
    verification: { passed: null, commands: [] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.blocking_passed, false);
  assert.equal(verification.requires_review, true);
  assert.ok(verification.blockers.some((entry) => entry.code === 'changed_files_reported_missing'));
  assert.ok(verification.blockers.some((entry) => entry.code === 'verification_report_missing'));
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


// P0-AutoTerm: Integration evidence from delivery_result_recovery satisfies
// integration_completed requirement so the contract verifier does not produce
// a false integration_completed_missing blocker.
test("contract verifier passes integration check when delivery_result_recovery indicates already_integrated", () => {
  // Use the local contract() helper with requires_integration: true and an
  // integration_completed blocking requirement.
  const c = contract("code_change", {
    requirements: { requires_commit: true, requires_integration: true },
    blocking_requirements: [
      { id: "integration_completed", description: "Required local integration or ff-only handoff is completed when applicable.", evidence: ["integration", "remote_head"] }
    ],
  });

  // Result has delivery_result_recovery with already_integrated evidence but
  // no top-level integration field (simulating the stuck-task scenario).
  // The evidence normalizer propagates delivery_result_recovery.integration
  // to the normalized integration field, which satisfies the blocker.
  const verification = verifyAcceptanceContract({
    contract: c,
    result: {
      status: "completed",
      summary: "docs task with already integrated commit",
      operation_kind: "code_change",
      changed_files: ["README.zh-CN.md"],
      commit: "c8c4847",
      tests: "check:syntax pass; check:imports pass",
      verification: { passed: true, commands: [{ cmd: "npm run check:syntax", exit_code: 0 }] },
      delivery_result_recovery: {
        reason: "already_integrated",
        commit_integrated: true,
        integration: { mode: "ff_only", merged: true, status: "already_integrated", commit: "c8c4847" },
        recovered: true,
      },
    },
    verification: { passed: true, commands: [{ cmd: "npm run check:syntax", exit_code: 0 }] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.contract_valid, true);
  assert.equal(verification.blocking_passed, true);
  assert.ok(!verification.blockers.some(b => b.code === "integration_completed_missing"), "should not have integration_completed_missing blocker");
});


// P0-Fix: integration.status=not_required satisfies integration_completed check
// for docs-only tasks where integration evidence is present but status is
// not_required (not merged, not auto_completed).
test("contract verifier passes integration check when integration.status is not_required", () => {
  const c = contract("code_change", {
    requirements: { requires_commit: true, requires_integration: true },
    blocking_requirements: [
      { id: "integration_completed", description: "Required local integration or ff-only handoff is completed when applicable.", evidence: ["integration", "remote_head"] }
    ],
  });

  const verification = verifyAcceptanceContract({
    contract: c,
    result: {
      status: "completed",
      summary: "docs-only task with integration not_required",
      operation_kind: "code_change",
      changed_files: ["docs/operations.md"],
      commit: "876d4b0",
      tests: "check:syntax pass",
      verification: { passed: true, commands: [{ cmd: "npm run check:syntax", exit_code: 0 }] },
      integration: { status: "not_required", required: false, terminal: true, merged: false },
    },
    verification: { passed: true, commands: [{ cmd: "npm run check:syntax", exit_code: 0 }] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.equal(verification.contract_valid, true);
  assert.equal(verification.blocking_passed, true);
  assert.equal(verification.acceptance_status, "satisfied");
  assert.ok(!verification.blockers.some(b => b.code === "integration_completed_missing"), "should not have integration_completed_missing blocker when status=not_required");
});

// P0-Fix-Negative: contract verifier correctly blocks when integration is missing
// and integration is required (ensures genuine blockers are preserved).
test("contract verifier blocks when integration is missing and requires_integration is true", () => {
  const c = contract("code_change", {
    requirements: { requires_commit: true, requires_integration: true },
    blocking_requirements: [
      { id: "integration_completed", description: "Required local integration or ff-only handoff is completed when applicable.", evidence: ["integration", "remote_head"] }
    ],
  });

  const verification = verifyAcceptanceContract({
    contract: c,
    result: {
      status: "completed",
      summary: "task with missing integration",
      operation_kind: "code_change",
      changed_files: ["src/app.mjs"],
      commit: "abc123",
      tests: "npm test",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      // No integration field at all
    },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    stateAssertions: { passed: true, assertions: [], failures: [] },
  });

  assert.ok(verification.blockers.some(b => b.code === "integration_completed_missing"), "should have integration_completed_missing blocker when integration is missing and required");
});
