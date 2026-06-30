import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyTaskCompletion } from '../src/task-verifier.mjs';

async function makeDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-task-verifier-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function codeChangeContract() {
  return {
    id: 'schema-v1:code',
    schema_version: 1,
    intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: true },
    blocking_requirements: [{ id: 'commit_present' }, { id: 'changed_files_reported' }, { id: 'verification_report' }, { id: 'integration_completed' }],
    state_assertions: [{ kind: 'result_has_changed_files' }, { kind: 'commit_present' }, { kind: 'integration_satisfied' }],
    verification_plan: { required_commands: ['npm test'], report_must_match_head: false, report_must_be_clean: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true, allow_completed_with_followups: true, do_not_block_on_quality_notes: true },
    review_policy: { requires_review_when: [] },
  };
}

test('verifyTaskCompletion emits satisfied contract_verification for contract-aware code_change result', async (t) => {
  const dir = await makeDir(t);
  const resultJsonPath = join(dir, 'result.json');
  const resultJson = {
    status: 'completed',
    summary: 'done',
    operation_kind: 'code_change',
    acceptance_contract_id: 'schema-v1:code',
    changed_files: ['src/app.mjs'],
    commit: 'abc123',
    verification: { passed: true, profile: 'changed', commands: ['npm test'] },
    integration: { status: 'merged', merged: true, auto_completed: false },
    quality_notes: ['small refactor later'],
  };

  const verification = await verifyTaskCompletion({
    task: { id: 'task_contract_code' },
    goal: { id: 'goal_contract_code', acceptance_contract: codeChangeContract() },
    repoPath: dir,
    resultJson,
    resultJsonPath,
    config: {
      verificationCommands: ['npm test'],
      repoStatusPorcelain: '',
      runCommand: async (command) => ({ cmd: command, exit_code: 0, stdout_tail: 'ok', stderr_tail: '' }),
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.contract_verification.acceptance_status, 'satisfied');
  assert.equal(verification.contract_verification.requires_review, false);
  assert.deepEqual(verification.contract_verification.quality_notes, ['small refactor later']);

  const written = JSON.parse(await readFile(join(dir, 'verification.json'), 'utf8'));
  assert.equal(written.contract_verification.acceptance_status, 'satisfied');
});

test('verifyTaskCompletion requires review when blocking contract evidence is missing', async (t) => {
  const dir = await makeDir(t);
  const verification = await verifyTaskCompletion({
    goal: { id: 'goal_contract_missing', acceptance_contract: codeChangeContract() },
    repoPath: dir,
    resultJson: {
      status: 'completed',
      summary: 'claims done',
      operation_kind: 'code_change',
      verification: { passed: true, commands: ['npm test'] },
      quality_notes: ['style followup'],
    },
    config: {
      verificationCommands: [],
      repoStatusPorcelain: '',
      runCommand: async (command) => ({ cmd: command, exit_code: 0, stdout_tail: '', stderr_tail: '' }),
    },
  });

  assert.equal(verification.passed, false);
  assert.equal(verification.status, 'waiting_for_review');
  assert.equal(verification.contract_verification.requires_review, true);
  assert.ok(verification.findings.some((finding) => finding.code === 'commit_present_missing'));
  assert.deepEqual(verification.contract_verification.quality_notes, ['style followup']);
});

test('verifyTaskCompletion keeps legacy no-contract fallback explicit', async (t) => {
  const dir = await makeDir(t);
  const verification = await verifyTaskCompletion({
    repoPath: dir,
    resultJson: { status: 'completed', summary: 'legacy', changed_files: [], verification: { passed: true } },
    config: {
      verificationCommands: [],
      runCommand: async (command) => ({ cmd: command, exit_code: 0, stdout_tail: '', stderr_tail: '' }),
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.contract_verification, null);
});

test('verifyTaskCompletion accepts restart contract evidence without code verification commands', async (t) => {
  const dir = await makeDir(t);
  const contract = {
    id: 'schema-v1:restart',
    schema_version: 1,
    intent: { operation_kind: 'restart', semantic_confidence: 'high' },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: true },
    blocking_requirements: [{ id: 'restart_performed' }, { id: 'process_status_evidence' }, { id: 'runtime_health_evidence' }],
    state_assertions: [{ kind: 'health_check_passed' }, { kind: 'process_restarted' }],
    verification_plan: { required_commands: [], report_must_match_head: false, report_must_be_clean: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true, allow_completed_with_followups: true, do_not_block_on_quality_notes: true },
    review_policy: { requires_review_when: [] },
  };

  const verification = await verifyTaskCompletion({
    goal: { id: 'goal_restart_contract', acceptance_contract: contract },
    repoPath: dir,
    resultJson: {
      status: 'completed',
      summary: 'restart verified',
      operation_kind: 'restart',
      restart_evidence: {
        restart_marker: 'marker.json',
        before_pid: 100,
        after_pid: 101,
        pid_changed: true,
        health_check: { ok: true, status: 200, url: 'http://localhost/health' },
      },
    },
    config: {
      verificationCommands: [],
      runCommand: async (command) => ({ cmd: command, exit_code: 0, stdout_tail: '', stderr_tail: '' }),
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.contract_verification.acceptance_status, 'satisfied');
});
