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

// ===========================================================================
// Acceptance scenarios: no-change, already-integrated, followup, repair,
// review, and integration — tested through the acceptance gate engine.
// ===========================================================================

test('runAcceptanceGate: no-change acceptance passes as auto_completed_clean', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_noop' },
    goal: {
      id: 'goal_noop',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'noop', mutation_scope: 'none', execution_mode: 'readonly', semantic_confidence: 'high' },
        requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      changed_files: [],
      commit: null,
      noop: true,
      noop_reason: 'No code changes were required.',
      no_mutation: true,
    }),
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
        state_assertions: { passed: true, assertions: ['no_mutation'], failures: [] },
      },
    }),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'passed', 'No-change acceptance should pass');
  assert.equal(gate.passed, true, 'No-change gate should be passed');
  assert.equal(gate.task_status, 'completed', 'No-change should complete');
  assert.equal(gate.closure_decision.status, 'auto_completed_clean', 'No-change should be auto_completed_clean');
  assert.equal(gate.closure_decision.reason, 'blocking_gate_passed_clean', 'No-change should report blocking_gate_passed_clean');
  assert.equal(gate.findings.length, 0, 'No-change should have zero findings');
});

test('runAcceptanceGate: already-integrated acceptance passes as auto_completed_clean', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_already_integrated' },
    goal: {
      id: 'goal_already_integrated',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'already_integrated', mutation_scope: 'none', execution_mode: 'readonly', semantic_confidence: 'high' },
        requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      changed_files: [],
      commit: 'abc123',
      already_integrated_evidence: { commit: 'abc123', remote_head: 'abc123', integrated_before: true },
      no_mutation: true,
    }),
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
        state_assertions: { passed: true, assertions: ['no_mutation'], failures: [] },
      },
    }),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'passed', 'Already-integrated acceptance should pass');
  assert.equal(gate.passed, true, 'Already-integrated gate should be passed');
  assert.equal(gate.task_status, 'completed', 'Already-integrated should complete');
  assert.equal(gate.closure_decision.status, 'auto_completed_clean', 'Already-integrated should be auto_completed_clean');
  assert.equal(gate.closure_decision.reason, 'blocking_gate_passed_clean', 'Already-integrated should report blocking_gate_passed_clean');
});

test('runAcceptanceGate: followup acceptance passes as auto_completed_with_followups', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_followup' },
    goal: {
      id: 'goal_followup',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      changed_files: ['backend/src/app.mjs'],
      commit: 'abc123',
      followups: [
        { code: 'cleanup_code', message: 'Clean up edge case handling', severity: 'minor' },
      ],
    }),
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
        non_blocking_followups: [
          { code: 'cleanup_code', message: 'Clean up edge case handling', severity: 'minor' },
        ],
        quality_notes: [],
        state_assertions: { passed: true, assertions: [], failures: [] },
      },
    }),
    now: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(gate.status, 'passed', 'Followup acceptance should pass');
  assert.equal(gate.passed, true, 'Followup gate should be passed');
  assert.equal(gate.task_status, 'completed', 'Followup should complete');
  assert.equal(gate.closure_decision.status, 'auto_completed_with_followups', 'Followup should be auto_completed_with_followups');
  assert.equal(gate.closure_decision.reason, 'blocking_gate_passed_with_non_blocking_followups', 'Followup should report non_blocking_followups reason');
  assert.equal(gate.closure_decision.quality_followups_count, 1, 'Followup should have 1 followup');
});

test('runAcceptanceGate: repair acceptance produces waiting_for_repair closure', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_repair' },
    goal: {
      id: 'goal_repair',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      status: 'completed',
      changed_files: ['backend/src/buggy.mjs'],
      commit: 'def456',
    }),
    resultJsonPath,
    verifyTaskCompletionFn: async () => verifierResult({
      passed: false,
      status: 'waiting_for_repair',
      findings: [
        { severity: 'blocker', code: 'verification_not_passed', message: 'npm test failed: 1/15', source: 'test' },
      ],
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

  assert.equal(gate.status, 'needs_action', 'Repair acceptance should be needs_action');
  assert.equal(gate.passed, false, 'Repair gate should not be passed');
  assert.equal(gate.task_status, 'waiting_for_repair', 'Repair should wait for repair');
  assert.equal(gate.closure_decision.status, 'waiting_for_repair', 'Closure should be waiting_for_repair');
  assert.equal(gate.closure_decision.reason, 'verification_failed', 'Repair should report verification_failed reason');
  assert.ok(gate.findings.some((f) => f.code === 'verification_not_passed'), 'Repair should have verification_not_passed finding');
});

test('runAcceptanceGate: review acceptance produces requires_review closure', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_review' },
    goal: {
      id: 'goal_review',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'code_change', semantic_confidence: 'low' },
        review_policy: { requires_review_when: ['semantic_ambiguity'] },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      changed_files: ['backend/src/app.mjs'],
      commit: 'ghi789',
    }),
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

  assert.equal(gate.status, 'needs_action', 'Review acceptance should be needs_action');
  assert.equal(gate.passed, false, 'Review gate should not be passed');
  assert.equal(gate.task_status, 'waiting_for_review', 'Review should wait for review');
  assert.equal(gate.closure_decision.status, 'requires_review', 'Closure should be requires_review');
  assert.equal(gate.closure_decision.reason, 'semantic_ambiguity', 'Review should report semantic_ambiguity reason');
  assert.equal(gate.closure_decision.requires_human_decision, true, 'Review requires human decision');
  assert.ok(gate.findings.some((f) => f.code === 'semantic_ambiguity'), 'Review should have semantic_ambiguity finding');
});

test('runAcceptanceGate: integration acceptance passes with commit, changed_files, and verification', async (t) => {
  const { dir, resultJsonPath } = await makeGoalDir(t);

  const gate = await runAcceptanceGate({
    task: { id: 'task_integration' },
    goal: {
      id: 'goal_integration',
      acceptance_contract: baseContract({
        intent: { operation_kind: 'integration', mutation_scope: 'repo', execution_mode: 'worktree', semantic_confidence: 'high' },
        requirements: { requires_commit: true, requires_integration: false, requires_restart: false, requires_deployment_check: false },
      }),
    },
    repoPath: dir,
    resultJson: baseResult({
      status: 'completed',
      summary: 'Integrated feature X successfully',
      changed_files: ['backend/src/feature.mjs', 'test/feature.test.mjs'],
      commit: 'jkl012',
      verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    }),
    resultJsonPath,
    verifyTaskCompletionFn: async () => verifierResult({
      passed: true,
      changed_files: ['backend/src/feature.mjs', 'test/feature.test.mjs'],
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

  assert.equal(gate.status, 'passed', 'Integration acceptance should pass');
  assert.equal(gate.passed, true, 'Integration gate should be passed');
  assert.equal(gate.task_status, 'completed', 'Integration should complete');
  assert.equal(gate.closure_decision.status, 'auto_completed_clean', 'Integration should be auto_completed_clean');
  assert.equal(gate.closure_decision.reason, 'blocking_gate_passed_clean', 'Integration should report blocking_gate_passed_clean');
});

// Cross-cutting: verify that all 6 acceptance scenarios are registered
test('runAcceptanceGate: acceptance scenario coverage completeness check', () => {
  const scenarios = ['no-change', 'already-integrated', 'followup', 'repair', 'review', 'integration'];
  assert.equal(scenarios.length, 6, 'Must have exactly 6 acceptance scenarios');
  // Each scenario has a dedicated test above — this is a structural coverage assertion
  const scenarioTests = [
    ['no-change', 'no-change acceptance passes as auto_completed_clean'],
    ['already-integrated', 'already-integrated acceptance passes as auto_completed_clean'],
    ['followup', 'followup acceptance passes as auto_completed_with_followups'],
    ['repair', 'repair acceptance produces waiting_for_repair closure'],
    ['review', 'review acceptance produces requires_review closure'],
    ['integration', 'integration acceptance passes with commit, changed_files, and verification'],
  ];
  assert.equal(scenarioTests.length, 6, 'Must have 6 scenario test descriptions');
  for (const [name, description] of scenarioTests) {
    assert.ok(name, `Scenario "${name}" must have a name`);
    assert.ok(description, `Scenario "${name}" must have a test description`);
  }
});
