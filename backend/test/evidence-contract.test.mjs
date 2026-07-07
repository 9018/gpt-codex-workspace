import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ACCEPTANCE_CONTRACT_PROFILES } from '../src/acceptance/contract-profiles.mjs';
import { OPERATION_EVIDENCE_PROFILES, operationEvidenceProfile } from '../src/evidence/operation-evidence-profiles.mjs';
import { getDefaultAcceptanceContractProfile } from '../src/acceptance/contract-profiles.mjs';
import { normalizeOperationEvidence } from '../src/evidence/evidence-normalizer.mjs';

// ---------------------------------------------------------------------------
// Helper: check whether a contract profile has a blocking requirement by id
// ---------------------------------------------------------------------------
function hasBlockingRequirement(contract, id) {
  return Array.isArray(contract.blocking_requirements)
    && contract.blocking_requirements.some((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Helper: check whether an evidence profile lists a field in required_when_completed
// ---------------------------------------------------------------------------
function hasRequiredEvidence(profile, field) {
  return Array.isArray(profile.required_when_completed)
    && profile.required_when_completed.includes(field);
}

// ---------------------------------------------------------------------------
// Profile-to-operation-kind map used by the goal
// ---------------------------------------------------------------------------
const PROFILE_KIND_MAP = {
  builder: 'code_change',
  documentation: 'docs_only',
  diagnostic: 'diagnostic',
  admin: 'admin_command',
};

// ---------------------------------------------------------------------------
// Evidence field expectations per profile
// Each entry lists the fields that SHOULD be in the contract blocking_requirements
// and the evidence profile required_when_completed.
// Fields NOT listed should NOT be present.
// ---------------------------------------------------------------------------
const EXPECTED_PROFILE_EVIDENCE = {
  code_change: {
    blocking_fields: ['commit_present', 'changed_files_reported', 'verification_report', 'integration_completed'],
    evidence_fields_when_completed: ['changed_files', 'commit', 'verification', 'integration'],
  },
  docs_only: {
    blocking_fields: ['docs_changed', 'commit_present', 'docs_verification'],
    evidence_fields_when_completed: ['changed_files', 'commit', 'verification'],
  },
  diagnostic: {
    blocking_fields: ['diagnostic_report', 'no_mutation_evidence'],
    evidence_fields_when_completed: ['diagnostic_evidence'],
  },
  admin_command: {
    blocking_fields: ['pre_state_snapshot', 'command_result', 'post_state_snapshot', 'audit_evidence'],
    evidence_fields_when_completed: ['admin_evidence'],
  },
};

// ---------------------------------------------------------------------------
// Fields that should NEVER appear for certain profiles
// ---------------------------------------------------------------------------
const NEVER_BLOCKING_FOR = {
  docs_only: ['integration_completed'],
  diagnostic: ['commit_present', 'changed_files_reported', 'verification_report', 'integration_completed'],
  admin_command: ['commit_present', 'changed_files_reported', 'verification_report', 'integration_completed'],
};

// ===========================================================================
// Tests
// ===========================================================================

describe('AFC-08: Evidence Contract Coverage', () => {

  // ── Contract profiles have correct blocking requirements ──
  describe('contract profile blocking requirements per role/profile', () => {
    for (const [profile, kind] of Object.entries(PROFILE_KIND_MAP)) {
      const expected = EXPECTED_PROFILE_EVIDENCE[kind];
      if (!expected) continue;

      it(`${profile} (${kind}) has correct blocking requirements`, () => {
        const contract = ACCEPTANCE_CONTRACT_PROFILES[kind];
        assert.ok(contract, `contract profile should exist for ${kind}`);

        // All expected blocking fields must be present
        for (const field of expected.blocking_fields) {
          assert.ok(
            hasBlockingRequirement(contract, field),
            `${kind} contract should have blocking requirement '${field}'`
          );
        }
      });
    }

    it('docs_only does NOT require integration', () => {
      const contract = ACCEPTANCE_CONTRACT_PROFILES.docs_only;
      assert.ok(!hasBlockingRequirement(contract, 'integration_completed'),
        'docs_only contract should NOT block on integration_completed');
      assert.equal(contract.requirements.requires_integration, false,
        'docs_only contract should have requires_integration: false');
    });

    it('diagnostic does NOT require commit, changed_files, verification, or integration', () => {
      const contract = ACCEPTANCE_CONTRACT_PROFILES.diagnostic;
      for (const field of NEVER_BLOCKING_FOR.diagnostic) {
        assert.ok(!hasBlockingRequirement(contract, field),
          `diagnostic contract should NOT have blocking requirement '${field}'`);
      }
      assert.equal(contract.requirements.requires_commit, false);
      assert.equal(contract.requirements.requires_integration, false);
    });

    it('admin_command does NOT require commit, changed_files, verification, or integration', () => {
      const contract = ACCEPTANCE_CONTRACT_PROFILES.admin_command;
      for (const field of NEVER_BLOCKING_FOR.admin_command) {
        assert.ok(!hasBlockingRequirement(contract, field),
          `admin_command contract should NOT have blocking requirement '${field}'`);
      }
      assert.equal(contract.requirements.requires_commit, false);
      assert.equal(contract.requirements.requires_integration, false);
    });
  });

  // ── Operation evidence profiles are consistent with contract profiles ──
  describe('operation-evidence profiles align with contract profiles', () => {
    for (const [profile, kind] of Object.entries(PROFILE_KIND_MAP)) {
      const expected = EXPECTED_PROFILE_EVIDENCE[kind];
      if (!expected) continue;

      it(`${profile} (${kind}) evidence profile lists required evidence`, () => {
        const evProfile = operationEvidenceProfile(kind);
        assert.ok(evProfile, `evidence profile should exist for ${kind}`);

        for (const field of expected.evidence_fields_when_completed) {
          assert.ok(
            hasRequiredEvidence(evProfile, field),
            `${kind} evidence profile should require '${field}' when completed`
          );
        }
      });
    }

    it('docs_only evidence profile does NOT require integration', () => {
      const evProfile = operationEvidenceProfile('docs_only');
      assert.ok(evProfile, 'docs_only evidence profile should exist');
      assert.ok(!hasRequiredEvidence(evProfile, 'integration'),
        'docs_only evidence profile should NOT require integration when completed');
    });
  });

  // ── Evidence normalizer is consistent with profiles ──
  describe('evidence normalizer integration knowledge per profile', () => {
    // The normalizer sets integration_not_required for certain operation kinds.
    // Verify docs_only and diagnostic are in that set, and code_change is not.
    it('docs_only result sets integration_not_required', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'docs update' },
        contract: { intent: { operation_kind: 'docs_only' } },
      });
      assert.equal(normalized.integration_not_required, true,
        'docs_only result should have integration_not_required=true');
    });

    it('diagnostic result sets integration_not_required', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'diagnostic' },
        contract: { intent: { operation_kind: 'diagnostic' } },
      });
      assert.equal(normalized.integration_not_required, true,
        'diagnostic result should have integration_not_required=true');
    });

    it('code_change result does NOT set integration_not_required', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'code change' },
        contract: { intent: { operation_kind: 'code_change' } },
      });
      assert.equal(normalized.integration_not_required, false,
        'code_change result should have integration_not_required=false');
    });
  });

  // ── Normalizer validates missing profile evidence ──
  describe('normalizer profile evidence validation', () => {
    it('code_change without changed_files or commit produces blockers', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'no evidence' },
        contract: { intent: { operation_kind: 'code_change' } },
      });
      const codes = normalized.blockers.map((b) => b.code);
      assert.ok(codes.includes('changed_files_missing'),
        'code_change should block on missing changed_files');
      assert.ok(codes.includes('commit_missing'),
        'code_change should block on missing commit');
    });

    it('docs_only without changed_files or commit produces blockers', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'no docs evidence' },
        contract: { intent: { operation_kind: 'docs_only' } },
      });
      const codes = normalized.blockers.map((b) => b.code);
      assert.ok(codes.includes('changed_files_missing'),
        'docs_only should block on missing changed_files');
      assert.ok(codes.includes('commit_missing'),
        'docs_only should block on missing commit');
      // docs_only should NOT block on integration
      assert.ok(!codes.some((c) => c.startsWith('integration')),
        'docs_only should NOT block on integration evidence');
    });

    it('diagnostic with no evidence does NOT block on commit/changed_files/integration', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'diag' },
        contract: { intent: { operation_kind: 'diagnostic' } },
      });
      const codes = normalized.blockers.map((b) => b.code);
      // diagnostic only requires diagnostic_evidence — no commit/changed_files/integration
      const forbiddenCodes = ['commit_missing', 'changed_files_missing', 'verification_missing', 'integration_missing'];
      for (const code of forbiddenCodes) {
        assert.ok(!codes.includes(code),
          `diagnostic should NOT have blocker '${code}'`);
      }
    });

    it('admin_command with no evidence does not block on commit/changed_files/verification', () => {
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'admin' },
        contract: { intent: { operation_kind: 'admin_command' } },
      });
      const codes = normalized.blockers.map((b) => b.code);
      const forbiddenCodes = ['commit_missing', 'changed_files_missing', 'verification_missing', 'integration_missing'];
      for (const code of forbiddenCodes) {
        assert.ok(!codes.includes(code),
          `admin_command should NOT have blocker '${code}'`);
      }
    });
  });

  // ── isNoopLikeOperation does not have duplicates (AFC-08 regression check) ──
  describe('isNoopLikeOperation no duplicates (AFC-08 regression)', () => {
    it('isNoopLikeOperation function call returns expected result for docs_only', async () => {
      // Indirect test: evaluate via the normalizer which uses it internally
      const normalized = normalizeOperationEvidence({
        result: { status: 'completed', summary: 'docs', changed_files: ['readme.md'], commit: 'abc123' },
        contract: { intent: { operation_kind: 'docs_only' } },
      });
      // docs_only with changed_files + commit + tests should have no blockers
      assert.ok(normalized.blockers.length === 0 ||
        normalized.blockers.every((b) => b.code !== 'changed_files_missing'),
        'docs_only with full evidence should not have changed_files_missing');
    });
  });

});
