import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAcceptanceGate } from '../src/acceptance-gate-engine.mjs';

async function makeGoalDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, resultJsonPath: join(dir, 'result.json') };
}

function baseResult(overrides = {}) {
  return {
    status: 'completed',
    summary: 'implemented',
    changed_files: ['backend/src/app.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    ...overrides,
  };
}

function baseContract(overrides = {}) {
  return {
    intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: false, requires_deployment: false },
    completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    ...overrides,
  };
}

function verifierResult(overrides = {}) {
  return {
    passed: true,
    status: 'completed',
    commands: [{ cmd: 'npm test', exit_code: 0 }],
    changed_files: ['backend/src/app.mjs'],
    reason_no_tests: null,
    findings: [],
    contract_verification: {
      contract_valid: true,
      blocking_passed: true,
      acceptance_status: 'satisfied',
      completion_eligible: true,
      requires_review: false,
      blockers: [],
      non_blocking_followups: [],
      quality_notes: [],
      state_assertions: { passed: true, assertions: [], failures: [] },
    },
    ...overrides,
  };
}

test('runAcceptanceGate passes and writes acceptance.json when verification and blocking requirements pass', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_pass' },
    goal: { id: 'goal_pass', acceptance_contract: baseContract() },
    repoPath: dir,
    resultJson: baseResult(),
    resultJsonPath,
    verifyTaskCompletionFn: async () => verifierResult(),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'passed');
  assert.equal(gate.passed, true);
  assert.equal(gate.task_status, 'completed');
  assert.equal(gate.closure_decision.status, 'auto_completed_clean');

  const written = JSON.parse(await readFile(join(dir, 'acceptance.json'), 'utf8'));
  assert.equal(written.status, 'passed');
  assert.equal(written.verification.passed, true);
});

test('runAcceptanceGate fails closed and writes acceptance.json for terminal failed result', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_failed' },
    goal: { id: 'goal_failed', acceptance_contract: baseContract({ requirements: { requires_commit: false, requires_integration: false } }) },
    repoPath: dir,
    resultJson: baseResult({ status: 'failed', summary: 'implementation failed', changed_files: [], commit: null }),
    resultJsonPath,
    verifyTaskCompletionFn: async () => verifierResult({
      passed: true,
      contract_verification: {
        contract_valid: true,
        blocking_passed: true,
        acceptance_status: 'satisfied',
        completion_eligible: true,
        requires_review: false,
        blockers: [],
        non_blocking_followups: [],
        quality_notes: [],
        state_assertions: { passed: true, assertions: [], failures: [] },
      },
    }),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'failed');
  assert.equal(gate.passed, false);
  assert.equal(gate.task_status, 'failed');
  assert.equal(gate.closure_decision.status, 'failed');

  const written = JSON.parse(await readFile(join(dir, 'acceptance.json'), 'utf8'));
  assert.equal(written.status, 'failed');
  assert.ok(written.findings.some((finding) => finding.code === 'result_failed'));
});

test('runAcceptanceGate returns needs_action when verification fails before completion', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_continue' },
    goal: { id: 'goal_continue', acceptance_contract: baseContract() },
    repoPath: dir,
    resultJson: baseResult(),
    resultJsonPath,
    verifyTaskCompletionFn: async () => verifierResult({
      passed: false,
      status: 'waiting_for_review',
      findings: [{ severity: 'blocker', code: 'verification_not_passed', message: 'tests failed', source: 'test' }],
    }),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'needs_action');
  assert.equal(gate.passed, false);
  assert.equal(gate.task_status, 'waiting_for_repair');
  assert.equal(gate.closure_decision.status, 'waiting_for_repair');

  const written = JSON.parse(await readFile(join(dir, 'acceptance.json'), 'utf8'));
  assert.equal(written.status, 'needs_action');
  assert.ok(written.findings.some((finding) => finding.code === 'verification_not_passed'));
});
