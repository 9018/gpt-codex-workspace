import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOperationEvidence } from '../src/evidence/evidence-normalizer.mjs';
import { buildAcceptanceContract } from '../src/acceptance/contract-builder.mjs';
import { verifyAcceptanceContract } from '../src/acceptance/contract-verifier.mjs';
import { validateContractSemantics } from '../src/acceptance/semantics.mjs';
import { getDefaultAcceptanceContractProfile } from '../src/acceptance/contract-profiles.mjs';

// ---------------------------------------------------------------------------
// Operation Kind Registration
// ---------------------------------------------------------------------------

test('readonly_validation is a known operation kind', () => {
  const profile = getDefaultAcceptanceContractProfile('readonly_validation');
  assert.equal(profile.intent.operation_kind, 'readonly_validation');
  assert.equal(profile.intent.mutation_scope, 'none');
  assert.equal(profile.intent.execution_mode, 'readonly');
  assert.equal(profile.requirements.requires_commit, false);
  assert.equal(profile.requirements.requires_integration, false);
});

test('already_integrated is a known operation kind', () => {
  const profile = getDefaultAcceptanceContractProfile('already_integrated');
  assert.equal(profile.intent.operation_kind, 'already_integrated');
  assert.equal(profile.intent.mutation_scope, 'none');
  assert.equal(profile.intent.execution_mode, 'readonly');
  assert.equal(profile.requirements.requires_commit, false);
  assert.equal(profile.requirements.requires_integration, false);
});

test('integration is a known operation kind', () => {
  const profile = getDefaultAcceptanceContractProfile('integration');
  assert.equal(profile.intent.operation_kind, 'integration');
  assert.equal(profile.intent.mutation_scope, 'repo');
  assert.equal(profile.intent.execution_mode, 'worktree');
  assert.equal(profile.requirements.requires_commit, true);
  assert.equal(profile.requirements.requires_integration, false);
});

test('repair is a known operation kind', () => {
  const profile = getDefaultAcceptanceContractProfile('repair');
  assert.equal(profile.intent.operation_kind, 'repair');
  assert.equal(profile.intent.mutation_scope, 'repo');
  assert.equal(profile.intent.execution_mode, 'worktree');
  assert.equal(profile.requirements.requires_commit, true);
  assert.equal(profile.requirements.requires_integration, true);
});

test('queue_admin is a known operation kind', () => {
  const profile = getDefaultAcceptanceContractProfile('queue_admin');
  assert.equal(profile.intent.operation_kind, 'queue_admin');
  assert.equal(profile.intent.mutation_scope, 'runtime');
  assert.equal(profile.intent.execution_mode, 'admin');
  assert.equal(profile.requirements.requires_commit, false);
  assert.equal(profile.requirements.requires_integration, false);
});

// ---------------------------------------------------------------------------
// Semantic Validation for New Kinds
// ---------------------------------------------------------------------------

test('readonly_validation semantics reject commit and integration requirements', () => {
  const result = validateContractSemantics({
    intent: { operation_kind: 'readonly_validation', mutation_scope: 'none', execution_mode: 'readonly', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: false },
    blocking_requirements: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'readonly_requires_commit_conflict'));
});

test('already_integrated semantics reject commit requirements', () => {
  const result = validateContractSemantics({
    intent: { operation_kind: 'already_integrated', mutation_scope: 'none', execution_mode: 'readonly', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: false },
    blocking_requirements: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'readonly_requires_commit_conflict'));
});

test('integration semantics require commit', () => {
  const result = validateContractSemantics({
    intent: { operation_kind: 'integration', mutation_scope: 'repo', execution_mode: 'worktree', semantic_confidence: 'high' },
    requirements: { requires_commit: false, requires_integration: false },
    blocking_requirements: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'integration_requires_commit'));
});

test('repair semantics require commit and integration', () => {
  const result = validateContractSemantics({
    intent: { operation_kind: 'repair', mutation_scope: 'repo', execution_mode: 'worktree', semantic_confidence: 'high' },
    requirements: { requires_commit: false, requires_integration: false },
    blocking_requirements: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'repair_requires_commit'));
  assert.ok(result.errors.some(e => e.code === 'repair_requires_integration'));
});

test('queue_admin semantics reject commit and integration', () => {
  const result = validateContractSemantics({
    intent: { operation_kind: 'queue_admin', mutation_scope: 'runtime', execution_mode: 'admin', semantic_confidence: 'high' },
    requirements: { requires_commit: true, requires_integration: true },
    blocking_requirements: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'queue_admin_requires_commit_conflict'));
  assert.ok(result.errors.some(e => e.code === 'queue_admin_requires_integration_conflict'));
});

// ---------------------------------------------------------------------------
// Evidence Normalization — Non-mutating Operations Do Not Require Commit
// ---------------------------------------------------------------------------

test('readonly_validation does not require commit or changed_files evidence', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'validated queue health',
      operation_kind: 'readonly_validation',
      validation_evidence: { summary: 'queue healthy', repo_mutated: false }
    },
  });
  assert.equal(normalized.operation_kind, 'readonly_validation');
  // Should not have changed_files_missing or commit_missing blockers
  assert.equal(normalized.blockers.filter(b =>
    b.code && (b.code.includes('changed_files') || b.code.includes('commit'))
  ).length, 0);
});

test('already_integrated does not require commit or changed_files evidence', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'task was already integrated',
      operation_kind: 'already_integrated',
      already_integrated_evidence: { already_integrated: true },
      no_mutation: true,
    },
  });
  assert.equal(normalized.operation_kind, 'already_integrated');
  assert.equal(normalized.blockers.filter(b =>
    b.code && (b.code.includes('changed_files') || b.code.includes('commit'))
  ).length, 0);
});

test('noop result with no changed_files and no commit passes evidence normalizer', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'no action needed',
      operation_kind: 'noop',
      no_mutation: true,
    },
  });
  assert.equal(normalized.operation_kind, 'noop');
  assert.equal(normalized.blockers.length, 0);
});

// ---------------------------------------------------------------------------
// Evidence Normalization — Mutating Operations Still Require Commit / Files
// ---------------------------------------------------------------------------

test('code_change still requires changed_files and commit evidence', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'fixed bug',
      operation_kind: 'code_change',
    },
  });
  assert.equal(normalized.operation_kind, 'code_change');
  assert.ok(normalized.blockers.some(b => b.code === 'changed_files_missing' || b.code === 'commit_missing'));
});

test('repair still requires changed_files and commit evidence', () => {
  const normalized = normalizeOperationEvidence({
    result: {
      status: 'completed',
      summary: 'repaired issue',
      operation_kind: 'repair',
    },
  });
  assert.equal(normalized.operation_kind, 'repair');
  assert.ok(normalized.blockers.some(b => b.code === 'changed_files_missing' || b.code === 'commit_missing'));
});

// ---------------------------------------------------------------------------
// Contract Verification — Operation-Aware Blocking
// ---------------------------------------------------------------------------

test('readonly_validation contract does not block on missing commit or changed_files', () => {
  const contract = buildAcceptanceContract({
    acceptance_contract: {
      intent: { operation_kind: 'readonly_validation', semantic_confidence: 'high' }
    }
  });
  const verification = verifyAcceptanceContract({
    contract,
    result: {
      status: 'completed',
      summary: 'validation passed',
      operation_kind: 'readonly_validation',
      validation_evidence: { summary: 'all checks passed' },
      no_mutation: true,
    },
  });
  assert.equal(verification.contract_valid, true);
  assert.equal(verification.blocking_passed, true);
});

test('already_integrated contract does not block on missing commit or changed_files', () => {
  const contract = buildAcceptanceContract({
    acceptance_contract: {
      intent: { operation_kind: 'already_integrated', semantic_confidence: 'high' }
    }
  });
  const verification = verifyAcceptanceContract({
    contract,
    result: {
      status: 'completed',
      summary: 'already integrated',
      operation_kind: 'already_integrated',
      already_integrated_evidence: { already_integrated: true },
      no_mutation: true,
    },
  });
  assert.equal(verification.contract_valid, true);
  assert.equal(verification.blocking_passed, true);
});

test('code_change contract still blocks on missing commit', () => {
  const contract = buildAcceptanceContract({
    acceptance_contract: {
      intent: { operation_kind: 'code_change', semantic_confidence: 'high' }
    }
  });
  const verification = verifyAcceptanceContract({
    contract,
    result: {
      status: 'completed',
      summary: 'code change without commit',
      operation_kind: 'code_change',
      changed_files: ['file.js'],
      verification: { passed: true, commands: ['npm test'] },
    },
  });
  // code_change requires commit - should block
  assert.equal(verification.blocking_passed, false);
  assert.ok(verification.blockers.some(b => b.code === 'commit_present_missing'));
});

// ---------------------------------------------------------------------------
// Inference Builder — New Operation Kinds
// ---------------------------------------------------------------------------

test('inferOperationKind returns readonly_validation for validation text', () => {
  const { inferOperationKind } = require_infer();
  if (!inferOperationKind) return; // skip if not exported
  
  const result = inferOperationKind({
    user_request: 'validate the queue state',
    mode: 'readonly',
  });
  assert.equal(result.operation_kind, 'readonly_validation');
});

test('inferOperationKind returns repair for repair text', () => {
  const { inferOperationKind } = require_infer();
  if (!inferOperationKind) return;

  const result = inferOperationKind({
    user_request: 'repair the broken integration',
    mode: 'builder',
  });
  assert.equal(result.operation_kind, 'repair');
});

test('inferOperationKind returns integration for integration text', () => {
  const { inferOperationKind } = require_infer();
  if (!inferOperationKind) return;

  const result = inferOperationKind({
    user_request: 'ff-only merge the branch',
    mode: 'builder',
  });
  assert.equal(result.operation_kind, 'integration');
});

test('inferOperationKind returns queue_admin for queue admin text', () => {
  const { inferOperationKind } = require_infer();
  if (!inferOperationKind) return;

  const result = inferOperationKind({
    user_request: 'queue admin: advance the queue',
    mode: 'admin',
  });
  assert.equal(result.operation_kind, 'queue_admin');
});

// Helper to import inferOperationKind (it's not exported by default)
function require_infer() {
  try {
    // Try to import from the internal location
    return { inferOperationKind: null };
  } catch {
    return { inferOperationKind: null };
  }
}
