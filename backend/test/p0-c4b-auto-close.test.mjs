import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOperationEvidence } from '../src/evidence/evidence-normalizer.mjs';
import { getDefaultAcceptanceContractProfile } from '../src/acceptance/contract-profiles.mjs';
import { verifyAcceptanceContract } from '../src/acceptance/contract-verifier.mjs';
import { decideTaskClosure } from '../src/closure/task-closure-decider.mjs';
import { getRequirementCheck } from '../src/evidence/operation-evidence-profiles.mjs';

// ---------------------------------------------------------------------------
// Helper: build a verified contract for the given operation kind
// ---------------------------------------------------------------------------

function buildContractVerification(contract, resultOverrides = {}) {
  return verifyAcceptanceContract({
    contract,
    result: {
      status: 'completed',
      ...resultOverrides,
    },
    task: { id: `task_${contract.intent?.operation_kind || 'test'}` },
  });
}

// ---------------------------------------------------------------------------
// E2E: No-change closure path — readonly_validation
// ---------------------------------------------------------------------------

test('P0-C4b: readonly_validation with validation_evidence auto-closes', () => {
  const contract = getDefaultAcceptanceContractProfile('readonly_validation');
  const result = {
    status: 'completed',
    summary: 'validated queue health',
    operation_kind: 'readonly_validation',
    validation_evidence: { summary: 'queue healthy', repo_mutated: false },
    no_mutation: true,
  };

  // 1. Evidence normalizer should not produce changed_files/commit blockers
  const normalized = normalizeOperationEvidence({ result, contract });
  assert.equal(normalized.operation_kind, 'readonly_validation');
  const fileCommitBlockers = normalized.blockers.filter(b =>
    b.code && (b.code.includes('changed_files') || b.code.includes('commit'))
  );
  assert.equal(fileCommitBlockers.length, 0,
    'readonly_validation should not have changed_files/commit blockers');

  // 2. Contract verification should pass (blocking satisfied)
  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.contract_valid, true);
  assert.equal(contractResult.blocking_passed, true,
    'readonly_validation contract should pass blocking');
  assert.equal(contractResult.requires_review, false,
    'readonly_validation should not require review');
  assert.equal(contractResult.completion_eligible, true,
    'readonly_validation should be completion eligible');

  // 3. Task closure decider should auto-complete
  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [] },
    result,
    task: { id: 'task_readonly_validation' },
  });
  assert.match(closure.status, /auto_completed/,
    `readonly_validation should auto-complete, got ${closure.status}`);
  assert.equal(closure.blocking_passed, true);
});

test('P0-C4b: readonly_validation without no_mutation flag still auto-closes via validation_evidence.repo_mutated', () => {
  const contract = getDefaultAcceptanceContractProfile('readonly_validation');
  const result = {
    status: 'completed',
    summary: 'validated',
    operation_kind: 'readonly_validation',
    validation_evidence: { summary: 'ok', repo_mutated: false },
    // no no_mutation: true — relies on validation_evidence.repo_mutated
  };

  // no_mutation_evidence requirement should pass via validation_evidence.repo_mutated
  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, true,
    'readonly_validation should pass blocking via validation_evidence.repo_mutated');
  assert.equal(contractResult.requires_review, false);
});

// ---------------------------------------------------------------------------
// E2E: Already-integrated closure path
// ---------------------------------------------------------------------------

test('P0-C4b: already_integrated with already_integrated_evidence auto-closes', () => {
  const contract = getDefaultAcceptanceContractProfile('already_integrated');
  const result = {
    status: 'completed',
    summary: 'task was already integrated',
    operation_kind: 'already_integrated',
    already_integrated_evidence: { already_integrated: true, repo_mutated: false },
    no_mutation: true,
  };

  // 1. Evidence normalizer
  const normalized = normalizeOperationEvidence({ result, contract });
  assert.equal(normalized.operation_kind, 'already_integrated');
  const fileCommitBlockers = normalized.blockers.filter(b =>
    b.code && (b.code.includes('changed_files') || b.code.includes('commit'))
  );
  assert.equal(fileCommitBlockers.length, 0,
    'already_integrated should not have changed_files/commit blockers');

  // 2. Contract verification
  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.contract_valid, true);
  assert.equal(contractResult.blocking_passed, true,
    'already_integrated contract should pass blocking');
  assert.equal(contractResult.requires_review, false);
  assert.equal(contractResult.completion_eligible, true);

  // 3. Task closure decider
  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [] },
    result,
    task: { id: 'task_already_integrated' },
  });
  assert.match(closure.status, /auto_completed/,
    `already_integrated should auto-complete, got ${closure.status}`);
  assert.equal(closure.blocking_passed, true);
});

test('P0-C4b: already_integrated without explicit no_mutation flag still passes via already_integrated_evidence.repo_mutated', () => {
  const contract = getDefaultAcceptanceContractProfile('already_integrated');
  const result = {
    status: 'completed',
    summary: 'already integrated',
    operation_kind: 'already_integrated',
    already_integrated_evidence: { files_match_canonical: true, repo_mutated: false },
    // no no_mutation: true — relies on already_integrated_evidence.repo_mutated
  };

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, true,
    'already_integrated should pass blocking via already_integrated_evidence.repo_mutated');
});

// ---------------------------------------------------------------------------
// E2E: Noop closure path
// ---------------------------------------------------------------------------

test('P0-C4b: noop with no_mutation flag auto-closes', () => {
  const contract = getDefaultAcceptanceContractProfile('noop');
  const result = {
    status: 'completed',
    summary: 'no action needed',
    operation_kind: 'noop',
    no_mutation: true,
  };

  // 1. Evidence normalizer
  const normalized = normalizeOperationEvidence({ result, contract });
  assert.equal(normalized.operation_kind, 'noop');
  assert.equal(normalized.blockers.length, 0,
    'noop should have no evidence blockers');

  // 2. Contract verification
  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.contract_valid, true);
  assert.equal(contractResult.blocking_passed, true,
    'noop contract should pass blocking');
  assert.equal(contractResult.requires_review, false);

  // 3. Task closure decider
  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [] },
    result,
    task: { id: 'task_noop' },
  });
  assert.match(closure.status, /auto_completed/,
    `noop should auto-complete, got ${closure.status}`);
  assert.equal(closure.blocking_passed, true);
});

// ---------------------------------------------------------------------------
// E2E: Diagnostic auto-closure also works (regression check)
// ---------------------------------------------------------------------------

test('P0-C4b: diagnostic with diagnostic_evidence and no_mutation auto-closes', () => {
  const contract = getDefaultAcceptanceContractProfile('diagnostic');
  const result = {
    status: 'completed',
    summary: 'diagnostic passed',
    operation_kind: 'diagnostic',
    diagnostic_evidence: { summary: 'all ok', repo_mutated: false },
    no_mutation: true,
  };

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, true,
    'diagnostic contract should pass blocking');
  assert.equal(contractResult.requires_review, false);

  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [] },
    result,
    task: { id: 'task_diagnostic' },
  });
  assert.match(closure.status, /auto_completed/,
    `diagnostic should auto-complete, got ${closure.status}`);
});

// ---------------------------------------------------------------------------
// Mutation tasks still require mutation evidence
// ---------------------------------------------------------------------------

test('P0-C4b: code_change with all required evidence auto-closes (no_mutation not required)', () => {
  const contract = getDefaultAcceptanceContractProfile('code_change');
  const result = {
    status: 'completed',
    summary: 'code changed',
    changed_files: ['file.js'],
    commit: 'abc123',
    verification: { passed: true, commands: ['npm test'] },
    integration: { status: 'ff_only_merged', satisfied: true, merged: true },
  };

  // Provide integration so requires_integration is satisfied
  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, true,
    'code_change with commit, files, verification, and integration should pass');
  assert.equal(contractResult.requires_review, false);

  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [{ cmd: 'npm test', exit_code: 0 }] },
    integration: { status: 'ff_only_merged', satisfied: true, post_merge_verification: { passed: true } },
    result,
    task: { id: 'task_code_change' },
  });
  assert.match(closure.status, /auto_completed/,
    `code_change should auto-complete, got ${closure.status}`);
});

test('P0-C4b: code_change without commit still blocks', () => {
  const contract = getDefaultAcceptanceContractProfile('code_change');
  const result = {
    status: 'completed',
    summary: 'code changed',
    changed_files: ['file.js'],  // has changed files but no commit
    verification: { passed: true, commands: ['npm test'] },
  };

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, false,
    'code_change without commit should not pass blocking');
  assert.ok(contractResult.blockers.some(b => b.code === 'commit_present_missing'),
    'should have commit_present_missing blocker');
});

test('P0-C4b: code_change without changed_files blocks', () => {
  const contract = getDefaultAcceptanceContractProfile('code_change');
  const result = {
    status: 'completed',
    summary: 'nothing changed',
    commit: 'abc123',  // has commit but no changed_files
    verification: { passed: true, commands: ['npm test'] },
  };

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, false,
    'code_change without changed_files should not pass blocking');
  assert.ok(contractResult.blockers.some(b => b.code === 'changed_files_reported_missing' || b.code === 'changed_files_missing'),
    'should have changed_files blocker');
});

test('P0-C4b: repair without changed_files blocks', () => {
  const contract = getDefaultAcceptanceContractProfile('repair');
  const result = {
    status: 'completed',
    summary: 'repair attempted',
    commit: 'abc123',
    verification: { passed: true, commands: ['npm test'] },
    // no changed_files — mutation tasks still require it
  };

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, false,
    'repair without changed_files should not pass blocking');
});

// ---------------------------------------------------------------------------
// no_mutation_evidence model correctly handles all evidence fields
// ---------------------------------------------------------------------------

test('P0-C4b: no_mutation_evidence satisfied by validation_evidence.repo_mutated', () => {
  const check = getRequirementCheck('no_mutation_evidence');
  assert.ok(check, 'no_mutation_evidence check should exist');

  // Test with validation_evidence.repo_mutated === false
  assert.equal(check.satisfied({
    operation_kind: 'readonly_validation',
    validation_evidence: { summary: 'ok', repo_mutated: false },
  }), true);
});

test('P0-C4b: no_mutation_evidence satisfied by already_integrated_evidence.repo_mutated', () => {
  const check = getRequirementCheck('no_mutation_evidence');

  // Test with already_integrated_evidence.repo_mutated === false
  assert.equal(check.satisfied({
    operation_kind: 'already_integrated',
    already_integrated_evidence: { already_integrated: true, repo_mutated: false },
  }), true);
});

test('P0-C4b: no_mutation_evidence satisfied by diagnostic_evidence.repo_mutated', () => {
  const check = getRequirementCheck('no_mutation_evidence');

  assert.equal(check.satisfied({
    operation_kind: 'diagnostic',
    diagnostic_evidence: { summary: 'ok', repo_mutated: false },
  }), true);
});

test('P0-C4b: no_mutation_evidence satisfied by no_mutation flag alone', () => {
  const check = getRequirementCheck('no_mutation_evidence');

  assert.equal(check.satisfied({ no_mutation: true }), true);
  assert.equal(check.satisfied({ repo_mutated: false }), true);
});

test('P0-C4b: no_mutation_evidence not satisfied when missing and no evidence fields', () => {
  const check = getRequirementCheck('no_mutation_evidence');

  assert.equal(check.satisfied({ operation_kind: 'readonly_validation', validation_evidence: {} }), false);
  assert.equal(check.satisfied({}), false);
});

// ---------------------------------------------------------------------------
// Result should not fall into manual review solely because there are no changed files
// ---------------------------------------------------------------------------

test('P0-C4b: noop with only no_mutation:true and no changed files reaches auto-complete', () => {
  const contract = getDefaultAcceptanceContractProfile('noop');
  const result = {
    status: 'completed',
    summary: 'already in main',
    operation_kind: 'noop',
    no_mutation: true,
    // intentionally no changed_files, no commit, no validation_evidence
  };

  const normalized = normalizeOperationEvidence({ result, contract });
  // Should not be forced into review by evidence normalizer
  assert.equal(normalized.requires_review, false,
    'noop should not require review from evidence normalizer');

  const contractResult = buildContractVerification(contract, result);
  assert.equal(contractResult.blocking_passed, true,
    'noop with no_mutation should pass blocking');
  assert.equal(contractResult.requires_review, false,
    'noop should not require review from contract verifier');

  const closure = decideTaskClosure({
    contract,
    contractVerification: contractResult,
    verification: { passed: true, findings: [], commands: [] },
    result,
    task: { id: 'task_noop_nofiles' },
  });
  assert.match(closure.status, /auto_completed/,
    `noop should auto-complete, got ${closure.status}`);
});

test('P0-C4b: readonly_validation still blocks when validation_evidence is missing repo_mutated', () => {
  // This tests that the evidence requirements are meaningful
  // (we don't just auto-pass without actual evidence)
  const contract = getDefaultAcceptanceContractProfile('readonly_validation');
  const result = {
    status: 'completed',
    summary: 'checked something',
    operation_kind: 'readonly_validation',
    validation_evidence: { summary: 'done' },  // no repo_mutated flag
    // no no_mutation either
  };

  const contractResult = buildContractVerification(contract, result);
  // Even though validation_evidence exists, no_mutation_evidence requirement fails
  // because no evidence field states no mutation occurred
  assert.equal(contractResult.blocking_passed, false,
    'readonly_validation without no-mutation evidence should not pass blocking');
  assert.ok(contractResult.blockers.some(b => b.code === 'no_mutation_evidence_missing'),
    'should have no_mutation_evidence_missing blocker');
});
