/**
 * operation-evidence-profiles.test.mjs — Focused tests for role evidence contract.
 *
 * AFC-08: Validates:
 *   1. Each pipeline role has explicit artifact/evidence requirements
 *   2. Missing reviewer/integrator evidence is represented consistently
 *   3. Deterministic closure still depends on structured evidence
 *   4. All modules still load (syntax/import checks)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ROLE_ENUM } from '../src/agent-artifact-contract.mjs';

import {
  ROLE_EVIDENCE_PROFILES,
  roleEvidenceProfile,
  missingRoleEvidence,
  missingAgentRunEvidence,
  getRequirementCheck,
} from '../src/evidence/operation-evidence-profiles.mjs';

// ===========================================================================
// 1. ROLES HAVE EXPLICIT ARTIFACT/EVIDENCE REQUIREMENTS
// ===========================================================================

test('ROLE_EVIDENCE_PROFILES covers all canonical pipeline roles', () => {
  const expectedRoles = [
    'context_curator',
    'planner',
    'builder',
    'verifier',
    'repairer',
    'reviewer',
    'finalizer',
    'integrator',
  ];

  assert.equal(AGENT_ROLE_ENUM.length, expectedRoles.length,
    'AGENT_ROLE_ENUM should match expected roles');

  for (const role of expectedRoles) {
    assert.ok(
      ROLE_EVIDENCE_PROFILES[role],
      `ROLE_EVIDENCE_PROFILES should define profile for "${role}"`,
    );
  }

  const profileCount = Object.keys(ROLE_EVIDENCE_PROFILES).length;
  assert.equal(profileCount, expectedRoles.length,
    `Should have exactly ${expectedRoles.length} role profiles`);
});

test('each role profile has valid evidence_fields and required_when_completed arrays', () => {
  for (const [role, profile] of Object.entries(ROLE_EVIDENCE_PROFILES)) {
    assert.ok(Array.isArray(profile.evidence_fields),
      `${role}.evidence_fields should be an array`);
    assert.ok(Array.isArray(profile.required_when_completed),
      `${role}.required_when_completed should be an array`);
    assert.ok(Array.isArray(profile.artifact_kinds),
      `${role}.artifact_kinds should be an array`);

    assert.ok(profile.evidence_fields.length > 0,
      `${role}.evidence_fields should not be empty`);
    assert.ok(profile.required_when_completed.length > 0,
      `${role}.required_when_completed should not be empty`);
    assert.ok(profile.artifact_kinds.length > 0,
      `${role}.artifact_kinds should not be empty`);

    // required_when_completed must be a subset of evidence_fields
    for (const field of profile.required_when_completed) {
      assert.ok(profile.evidence_fields.includes(field),
        `${role}: required field "${field}" should be in evidence_fields`);
    }
  }
});

test('roleEvidenceProfile returns correct profile for each role', () => {
  const profile = roleEvidenceProfile('reviewer');
  assert.ok(profile);
  assert.deepEqual(profile.required_when_completed, ['reviewer_decision']);
  assert.deepEqual(profile.artifact_kinds, ['reviewer_decision']);

  const intProfile = roleEvidenceProfile('integrator');
  assert.ok(intProfile);
  assert.deepEqual(intProfile.required_when_completed, ['integration']);
  assert.deepEqual(intProfile.artifact_kinds, ['integration']);
});

test('roleEvidenceProfile returns null for unknown roles', () => {
  assert.equal(roleEvidenceProfile('unknown'), null);
  assert.equal(roleEvidenceProfile(''), null);
  assert.equal(roleEvidenceProfile(null), null);
});

// ===========================================================================
// 2. MISSING REVIEWER/INTEGRATOR EVIDENCE REPRESENTED CONSISTENTLY
// ===========================================================================

test('missingRoleEvidence returns empty array when all evidence is present', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    integration: { status: 'merged', merged: true },
    reviewer_decision: { passed: true, decision: 'accepted' },
  };

  const blockers = missingRoleEvidence(result, ['reviewer', 'integrator']);
  assert.equal(blockers.length, 0,
    'No blockers when reviewer_decision and integration are present');
});

test('missingRoleEvidence creates blocker for missing reviewer_decision', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [] },
    integration: { status: 'merged', merged: true },
    // No reviewer_decision
  };

  const blockers = missingRoleEvidence(result, ['reviewer']);
  assert.equal(blockers.length, 1,
    'Should produce 1 blocker for missing reviewer_decision');
  assert.equal(blockers[0].code, 'role_reviewer_reviewer_decision_missing');
  assert.equal(blockers[0].severity, 'blocker');
  assert.equal(blockers[0].role, 'reviewer');
  assert.equal(blockers[0].evidence_field, 'reviewer_decision');
  assert.ok(blockers[0].message.includes('reviewer_decision'),
    'Blocker message should reference reviewer_decision');
  assert.equal(blockers[0].source, 'role_evidence_profiles');
});

test('missingRoleEvidence creates blocker for missing integration', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [] },
    reviewer_decision: { passed: true, decision: 'accepted' },
    // No integration
  };

  const blockers = missingRoleEvidence(result, ['integrator']);
  assert.equal(blockers.length, 1,
    'Should produce 1 blocker for missing integration');
  assert.equal(blockers[0].code, 'role_integrator_integration_missing');
  assert.equal(blockers[0].role, 'integrator');
  assert.equal(blockers[0].evidence_field, 'integration');
});

test('missingRoleEvidence creates blockers for both missing reviewer and integrator evidence simultaneously', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [] },
    // No reviewer_decision, no integration
  };

  const blockers = missingRoleEvidence(result, ['reviewer', 'integrator']);
  assert.equal(blockers.length, 2,
    'Should produce 2 blockers for missing reviewer and integrator evidence');

  const codes = blockers.map(b => b.code).sort();
  assert.deepEqual(codes, [
    'role_integrator_integration_missing',
    'role_reviewer_reviewer_decision_missing',
  ]);
});

test('missingRoleEvidence returns empty for incomplete results', () => {
  const result = {
    status: 'failed',
    changed_files: ['test.mjs'],
  };
  assert.equal(missingRoleEvidence(result, ['reviewer']).length, 0,
    'No blockers for incomplete result');
});

test('missingRoleEvidence searches nested sub-results for evidence', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [] },
    contract_verification: {
      normalized_result: {
        reviewer_decision: { passed: true, decision: 'accepted' },
        integration: { status: 'merged', merged: true },
      },
    },
  };

  const blockers = missingRoleEvidence(result, ['reviewer', 'integrator']);
  assert.equal(blockers.length, 0,
    'Should find evidence in nested contract_verification.normalized_result');
});

test('missingRoleEvidence searches agent runs for evidence', () => {
  const result = {
    status: 'completed',
    changed_files: ['test.mjs'],
    commit: 'abc123',
    verification: { passed: true, commands: [] },
    agent_runs: [
      {
        role: 'reviewer',
        contract_role: 'reviewer',
        output_artifacts: [{ kind: 'reviewer_decision', passed: true, status: 'accepted' }],
      },
      {
        role: 'integrator',
        contract_role: 'integrator',
        output_artifacts: [{ kind: 'integration', merged: true, status: 'ff_only_merged' }],
      },
    ],
  };

  const blockers = missingRoleEvidence(result, ['reviewer', 'integrator']);
  assert.equal(blockers.length, 0,
    'Should find evidence in agent run artifacts');
});

// ===========================================================================
// 3. DETERMINISTIC CLOSURE DEPENDS ON STRUCTURED EVIDENCE
// ===========================================================================

test('missingAgentRunEvidence blocks when required artifact kind is missing', () => {
  const run = {
    role: 'integrator',
    contract_role: 'integrator',
    status: 'completed',
    output_artifacts: [],
    input_artifacts: [],
  };

  const blockers = missingAgentRunEvidence(run);
  assert.equal(blockers.length, 1,
    'Completed integrator run without integration artifact should produce blocker');
  assert.equal(blockers[0].code, 'agent_run_integrator_integration_missing');
  assert.equal(blockers[0].severity, 'blocker');
  assert.equal(blockers[0].artifact_kind, 'integration');
  assert.equal(blockers[0].role, 'integrator');
  assert.equal(blockers[0].source, 'role_evidence_profiles');
});

test('missingAgentRunEvidence returns empty for runs with required artifacts', () => {
  const run = {
    role: 'reviewer',
    contract_role: 'reviewer',
    status: 'completed',
    output_artifacts: [{ kind: 'reviewer_decision', passed: true, status: 'accepted' }],
  };

  assert.equal(missingAgentRunEvidence(run).length, 0,
    'Reviewer run with reviewer_decision artifact should have no blockers');
});

test('missingAgentRunEvidence returns empty for non-completed runs', () => {
  const run = {
    role: 'integrator',
    contract_role: 'integrator',
    status: 'queued',
    output_artifacts: [],
  };

  assert.equal(missingAgentRunEvidence(run).length, 0,
    'Non-completed runs should not produce blockers');
});

test('missingAgentRunEvidence checks both output_artifacts and input_artifacts', () => {
  const run = {
    role: 'reviewer',
    contract_role: 'reviewer',
    status: 'completed',
    output_artifacts: [],
    input_artifacts: [{ kind: 'reviewer_decision', passed: true }],
  };

  assert.equal(missingAgentRunEvidence(run).length, 0,
    'Should find artifact in input_artifacts');
});

test('missingAgentRunEvidence returns empty for unknown roles', () => {
  const run = {
    role: 'unknown',
    contract_role: 'unknown',
    status: 'completed',
    output_artifacts: [],
  };

  assert.equal(missingAgentRunEvidence(run).length, 0,
    'Unknown roles should produce no blockers');
});

// ===========================================================================
// 4. GENERIC REQUIREMENT CHECKS
// ===========================================================================

test('getRequirementCheck for reviewer_decision works correctly', () => {
  const check = getRequirementCheck('reviewer_decision');
  assert.ok(check, 'reviewer_decision check should exist');
  assert.equal(check.code, 'reviewer_decision_missing');
  assert.ok(check.message);

  // Should be satisfied when reviewer_decision is present with passed=true
  assert.ok(check.satisfied({ reviewer_decision: { passed: true, decision: 'accepted' } }));
  // Should be satisfied when decision is 'accepted'
  assert.ok(check.satisfied({ reviewer_decision: { decision: 'accepted' } }));
  // Should NOT be satisfied when reviewer_decision is missing
  assert.equal(check.satisfied({}), false);
  // Should NOT be satisfied when reviewer_decision is not accepted
  assert.equal(check.satisfied({ reviewer_decision: { passed: false, decision: 'rejected' } }), false);
});

test('getRequirementCheck for integration_artifact works correctly', () => {
  const check = getRequirementCheck('integration_artifact');
  assert.ok(check, 'integration_artifact check should exist');
  assert.equal(check.code, 'integration_artifact_missing');
  assert.ok(check.message);

  // Should be satisfied when merged=true
  assert.ok(check.satisfied({ integration: { merged: true } }));
  // Should be satisfied when status is 'ff_only_merged'
  assert.ok(check.satisfied({ integration: { status: 'ff_only_merged' } }));
  // Should be satisfied when auto_completed=true
  assert.ok(check.satisfied({ integration: { auto_completed: true } }));
  // Should NOT be satisfied when integration is missing
  assert.equal(check.satisfied({}), false);
  // Should NOT be satisfied when integration is pending
  assert.equal(check.satisfied({ integration: { status: 'pending' } }), false);
});

test('getRequirementCheck returns null for unknown requirement ids', () => {
  assert.equal(getRequirementCheck('does_not_exist'), null);
  assert.equal(getRequirementCheck(''), null);
});

// ===========================================================================
// 5. IMPORT CHECK
// ===========================================================================

test('operation-evidence-profiles module exports all expected functions', () => {
  assert.ok(typeof ROLE_EVIDENCE_PROFILES === 'object');
  assert.ok(typeof roleEvidenceProfile === 'function');
  assert.ok(typeof missingRoleEvidence === 'function');
  assert.ok(typeof missingAgentRunEvidence === 'function');
  assert.ok(typeof getRequirementCheck === 'function');
});
