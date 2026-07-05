import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeVerificationPassed,
  normalizeAcceptanceGate,
  normalizeContractBlockingPassed,
  normalizeDeliveryResultRecovery,
  normalizeIntegration,
  normalizeResultContract,
} from '../src/codex-result-contract-normalizer.mjs';

// =========================================================================
// normalizeVerificationPassed -- tests field normalization
// =========================================================================

test('normalizeVerificationPassed: tests field with pass indicator normalizes to passed=true', () => {
  const result = normalizeVerificationPassed({
    tests: 'npm test: passed 15/15, 0 failed',
    exitCode: 0,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'exit_code_zero_and_tests_pass');
  assert.ok(result.commands.length > 0);
});

test('normalizeVerificationPassed: command exit_code=0 with tests pass normalizes to passed=true', () => {
  const result = normalizeVerificationPassed({
    tests: 'all checks passed',
    exitCode: 0,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'exit_code_zero_and_tests_pass');
});

test('normalizeVerificationPassed: summary-only (no tests, no exitCode) normalizes to passed=null', () => {
  const result = normalizeVerificationPassed({
    summary: 'Task completed successfully with all work done',
    changedFiles: [],
  });
  assert.equal(result.passed, null);
  assert.equal(result.reason, 'no_structured_evidence_summary_only');
  assert.deepEqual(result.commands, []);
});

test('normalizeVerificationPassed: tests field with failure text normalizes to passed=false', () => {
  const result = normalizeVerificationPassed({
    tests: '2 tests failed, 1 error',
    exitCode: 1,
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'non_zero_exit_code_1');
});

test('normalizeVerificationPassed: explicit verification failure in delivery_result_recovery remains blocking', () => {
  const result = normalizeVerificationPassed({
    deliveryResultRecovery: {
      verification: { passed: false, commands: [{ cmd: 'npm test', exit_code: 1 }] },
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'delivery_result_recovery_verification_failed');
});

test('normalizeVerificationPassed: release report with passed=true and commands normalizes to passed=true', () => {
  const result = normalizeVerificationPassed({
    releaseReport: { passed: true, commands: [{ cmd: 'check:syntax', exit_code: 0 }] },
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'release_report_passed_with_commands');
});

test('normalizeVerificationPassed: summary-only rejection - free-form text alone never marks passed', () => {
  // Even with a very persuasive summary, no structured evidence -> null
  const result = normalizeVerificationPassed({
    summary: 'Everything passed perfectly, all tests green, deployment successful!',
    exitCode: null,
    changedFiles: [],
  });
  assert.equal(result.passed, null);
  assert.equal(result.reason, 'no_structured_evidence_summary_only');
});

test('normalizeVerificationPassed: changed_files without tests is not sufficient for passed', () => {
  const result = normalizeVerificationPassed({
    changedFiles: ['src/main.js'],
    tests: null,
    exitCode: 0,
  });
  assert.equal(result.passed, null);
  assert.equal(result.reason, 'changed_files_only_no_verification_evidence');
});

// =========================================================================
// normalizeAcceptanceGate
// =========================================================================

test('normalizeAcceptanceGate: follows verification.passed=true', () => {
  const result = normalizeAcceptanceGate({
    tests: 'all tests passed',
    exitCode: 0,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'verification_passed_acceptance_gate_passed');
});

test('normalizeAcceptanceGate: follows verification.passed=false', () => {
  const result = normalizeAcceptanceGate({
    tests: '3 failures',
    exitCode: 1,
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'verification_failed_acceptance_gate_failed');
});

test('normalizeAcceptanceGate: summary-only returns null', () => {
  const result = normalizeAcceptanceGate({
    summary: 'All good',
    changedFiles: [],
  });
  assert.equal(result.passed, null);
  assert.equal(result.reason, 'no_verification_evidence_acceptance_gate_not_determined');
});

test('normalizeAcceptanceGate: already_integrated recovery passes acceptance gate', () => {
  const result = normalizeAcceptanceGate({
    deliveryResultRecovery: { reason: 'already_integrated', commit_integrated: true },
  });
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'already_integrated_acceptance_gate_passed');
});

// =========================================================================
// normalizeContractBlockingPassed -- commit/local_head reachability
// =========================================================================

test('normalizeContractBlockingPassed: reachable local_head already-integrated normalizes to blocking_passed=true', () => {
  const result = normalizeContractBlockingPassed({
    commitReachability: { reachable: true, local_head: 'abc123', canonical_clean: true },
    integration: { already_integrated: true },
  });
  assert.equal(result.blocking_passed, true);
  assert.equal(result.reason, 'integration_merged_or_already_integrated');
});

test('normalizeContractBlockingPassed: unreachable local_head normalizes to blocking_passed=false', () => {
  const result = normalizeContractBlockingPassed({
    commitReachability: { reachable: false, local_head: 'def456' },
  });
  assert.equal(result.blocking_passed, false);
  assert.equal(result.reason, 'local_head_unreachable_not_integrated');
});

test('normalizeContractBlockingPassed: delivery recovery with commit_integrated=true passes blocking', () => {
  const result = normalizeContractBlockingPassed({
    deliveryResultRecovery: { commit_integrated: true, reason: 'already_integrated' },
  });
  assert.equal(result.blocking_passed, true);
  assert.equal(result.reason, 'delivery_recovery_already_integrated');
});

test('normalizeContractBlockingPassed: summary-only defaults to blocking_passed=false', () => {
  const result = normalizeContractBlockingPassed({
    summary: 'Task completed',
  });
  assert.equal(result.blocking_passed, false);
  assert.equal(result.reason, 'no_contract_verification_evidence');
});

test('normalizeContractBlockingPassed: explicit verification failure remains blocking', () => {
  const result = normalizeContractBlockingPassed({
    deliveryResultRecovery: { verification: { passed: false } },
    commitReachability: { reachable: false },
  });
  assert.equal(result.blocking_passed, false);
  assert.equal(result.reason, 'local_head_unreachable_not_integrated');
});

// =========================================================================
// normalizeDeliveryResultRecovery
// =========================================================================

test('normalizeDeliveryResultRecovery: null when no recovery', () => {
  const result = normalizeDeliveryResultRecovery({});
  assert.equal(result, null);
});

test('normalizeDeliveryResultRecovery: recovery with commit_integrated carries through', () => {
  const result = normalizeDeliveryResultRecovery({
    deliveryResultRecovery: {
      reason: 'already_integrated',
      commit_integrated: true,
      commit: 'abc123',
      local_head: 'abc123',
      remote_head: 'abc123',
    },
  });
  assert.equal(result.reason, 'already_integrated');
  assert.equal(result.commit_integrated, true);
  assert.equal(result.commit, 'abc123');
});

test('normalizeDeliveryResultRecovery: recovery reason preserved', () => {
  const result = normalizeDeliveryResultRecovery({
    deliveryResultRecovery: { reason: 'recovered_dirty_worktree_delivery', commit_integrated: true },
    commitReachability: { commit: 'def456', local_head: 'def456' },
  });
  assert.equal(result.reason, 'recovered_dirty_worktree_delivery');
  assert.equal(result.commit_integrated, true);
  assert.equal(result.commit, 'def456');
});

// =========================================================================
// normalizeIntegration
// =========================================================================

test('normalizeIntegration: merged integration normalizes correctly', () => {
  const result = normalizeIntegration({
    integration: { status: 'merged', merged: true },
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.merged, true);
});

test('normalizeIntegration: already_integrated flag sets status', () => {
  const result = normalizeIntegration({
    integration: { already_integrated: true },
    commitReachability: { reachable: true, canonical_clean: true },
  });
  assert.equal(result.status, 'already_integrated');
  assert.equal(result.already_integrated, true);
});

test('normalizeIntegration: not merged, not integrated returns null status', () => {
  const result = normalizeIntegration({
    integration: {},
    commitReachability: { reachable: false },
  });
  assert.equal(result.status, null);
  assert.equal(result.merged, false);
  assert.equal(result.already_integrated, false);
});

// =========================================================================
// normalizeResultContract -- integration tests
// =========================================================================

test('normalizeResultContract: full happy path with all structured evidence', () => {
  const result = normalizeResultContract({
    tests: 'npm test: passed 15/15, 0 failed',
    exitCode: 0,
    releaseReport: { passed: true, commands: [{ cmd: 'check:imports', exit_code: 0 }] },
    commitReachability: { reachable: true, local_head: 'abc123', canonical_clean: true },
    integration: { status: 'merged', merged: true },
    changedFiles: ['src/main.js'],
    summary: 'Implemented feature X',
  });

  assert.equal(result.verification.passed, true);
  assert.equal(result.acceptance_gate.passed, true);
  assert.equal(result.contract_verification.blocking_passed, true);
  assert.equal(result.integration.merged, true);
  assert.equal(result.integration.status, 'merged');
  assert.equal(result.closure_decision.status, 'completed');
  assert.equal(result.finalizer_decision.status, 'completed');
  assert.equal(result.result_contract_normalized, true);
  assert.deepEqual(result.changed_files, ['src/main.js']);
});

test('normalizeResultContract: summary-only rejection in full flow', () => {
  // Task with only free-form summary text must not produce passed
  const result = normalizeResultContract({
    summary: 'Completed the implementation successfully, all tests pass',
    changedFiles: [],
  });

  assert.equal(result.verification.passed, null);
  assert.equal(result.acceptance_gate.passed, null);
  assert.equal(result.contract_verification.blocking_passed, false);
  assert.equal(result.closure_decision.status, null);
  assert.equal(result.finalizer_decision.status, null);
  assert.equal(result.finalizer_decision.reason, 'insufficient_evidence');
});

test('normalizeResultContract: explicit failure remains blocking', () => {
  const result = normalizeResultContract({
    tests: '3 failures, build broken',
    exitCode: 1,
    commitReachability: { reachable: false },
    changedFiles: ['src/broken.js'],
  });

  assert.equal(result.verification.passed, false);
  assert.equal(result.acceptance_gate.passed, false);
  assert.equal(result.contract_verification.blocking_passed, false);
  assert.equal(result.finalizer_decision.status, 'failed');
  assert.equal(result.finalizer_decision.reason, 'verification_failed');
});

test('normalizeResultContract: reachable local_head already-integrated', () => {
  const result = normalizeResultContract({
    commitReachability: { reachable: true, local_head: 'abc123', canonical_clean: true },
    integration: { already_integrated: true },
    deliveryResultRecovery: { reason: 'already_integrated', commit_integrated: true },
    tests: 'npm test: all passed',
    exitCode: 0,
    changedFiles: ['src/main.js'],
  });

  assert.equal(result.verification.passed, true);
  assert.equal(result.contract_verification.blocking_passed, true);
  assert.equal(result.integration.already_integrated, true);
  assert.equal(result.closure_decision.status, 'completed');
});

test('normalizeResultContract: unreachable local_head blocking', () => {
  const result = normalizeResultContract({
    commitReachability: { reachable: false, local_head: 'def456' },
    changedFiles: ['src/main.js'],
  });

  assert.equal(result.contract_verification.blocking_passed, false);
  assert.equal(result.finalizer_decision.blocking_passed, false);
  assert.equal(result.closure_decision.status, null);
});

test('normalizeResultContract: explicit verification failure blocking', () => {
  const result = normalizeResultContract({
    deliveryResultRecovery: {
      verification: { passed: false, commands: [{ cmd: 'npm test', exit_code: 1 }] },
    },
  });

  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.reason, 'delivery_result_recovery_verification_failed');
  assert.equal(result.finalizer_decision.status, 'failed');
  assert.equal(result.finalizer_decision.reason, 'verification_failed');
  // Blocking remains false since verification fails
  assert.equal(result.contract_verification.blocking_passed, false);
});

test('normalizeResultContract: no-mutation empty changed_files validity', () => {
  // A no-mutation result with empty changed_files is valid as long as
  // structured evidence exists. Empty changed_files alone must NOT cause
  // passed=null when other evidence exists.
  const result = normalizeResultContract({
    tests: 'npm test: all passed',
    exitCode: 0,
    changedFiles: [],
    summary: 'Read-only validation passed',
  });

  // Empty changed_files with structured test evidence -> verification passes
  assert.equal(result.verification.passed, true);
  // But contract blocking fails because no integration/reachability evidence
  assert.equal(result.contract_verification.blocking_passed, false);
});

// =========================================================================
// Edge cases and invariants
// =========================================================================

test('normalizeResultContract: existingResult fields preserved when not overridden', () => {
  const result = normalizeResultContract({
    tests: 'all ok',
    exitCode: 0,
    existingResult: {
      warnings: ['Some minor issue'],
      followups: ['Consider refactoring'],
      commit: 'abc123',
      remote_head: 'def456',
    },
  });

  assert.equal(result.warnings[0], 'Some minor issue');
  assert.equal(result.followups[0], 'Consider refactoring');
  assert.equal(result.commit, 'abc123');
  assert.equal(result.remote_head, 'def456');
});

test('normalizeResultContract: null/undefined inputs handled safely', () => {
  const result = normalizeResultContract(null);
  assert.equal(result.verification.passed, null);
  assert.equal(result.verification.reason, 'no_structured_evidence_summary_only');

  const result2 = normalizeResultContract(undefined);
  assert.equal(result2.verification.passed, null);
});

test('normalizeResultContract: empty input does not produce false completed', () => {
  const result = normalizeResultContract({});
  assert.equal(result.status, null);
  assert.equal(result.verification.passed, null);
  assert.equal(result.finalizer_decision.status, null);
  assert.equal(result.closure_decision.status, null);
});

test('normalizeContractBlockingPassed: delivery_result_recovery with recovery_failed reason does not pass blocking', () => {
  const result = normalizeContractBlockingPassed({
    deliveryResultRecovery: { commit_integrated: true, reason: 'recovery_failed' },
  });
  // Even though commit_integrated=true, reason 'recovery_failed' should not pass
  assert.equal(result.blocking_passed, false);
});

console.log('All codex-result-contract-normalizer tests loaded');
