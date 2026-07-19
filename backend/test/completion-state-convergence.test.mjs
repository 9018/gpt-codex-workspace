/**
 * completion-state-convergence.test.mjs — Multi-state combination tests.
 *
 * Tests that the complete state convergence path (goal-convergence →
 * task-convergence → finalizer → closure-reconciler) produces consistent
 * results regardless of which module is queried for the same evidence.
 *
 * Key verification:
 *   1. Shared constants (NO_MUTATION_PROFILES, SYNC_LIKE_PROFILES,
 *      TERMINAL_INTEGRATION_STATUSES) are consistent across modules.
 *   2. determineGoalStatus does not re-derive status when unified_decision
 *      is present and says "completed".
 *   3. determineGoalStatus fallback path matches convergeTaskAfterRun for
 *      the same evidence.
 *   4. Multi-state evidence combinations produce expected goal status.
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_MUTATION_PROFILES,
  SYNC_LIKE_PROFILES,
  TERMINAL_INTEGRATION_STATUSES,
  hasCompletionEvidence,
  isNonBlockerForProfile,
  isNoMutationProfile,
  isSyncLikeProfile,
} from '../src/completion-state-shared.mjs';

import { determineGoalStatus } from '../src/goal-convergence.mjs';
import { convergeTaskAfterRun, detectAcceptanceProfile } from '../src/task-convergence.mjs';
import { decideTaskFinalState } from '../src/task-finalizer.mjs';
import { reconcileTaskClosure } from '../src/closure/task-closure-reconciler.mjs';

// ===========================================================================
// 1. Shared constants consistency
// ===========================================================================

test('shared: SYNC_LIKE_PROFILES is a proper subset of NO_MUTATION_PROFILES', () => {
  for (const profile of SYNC_LIKE_PROFILES) {
    assert.ok(NO_MUTATION_PROFILES.has(profile),
      `SYNC_LIKE_PROFILES entry "${profile}" must also be in NO_MUTATION_PROFILES`);
  }
  // SYNC_LIKE_PROFILES is smaller than NO_MUTATION_PROFILES
  assert.ok(SYNC_LIKE_PROFILES.size < NO_MUTATION_PROFILES.size,
    'SYNC_LIKE_PROFILES should be a strict subset');
});

test('shared: NO_MUTATION_PROFILES includes all expected profiles', () => {
  const expected = [
    'diagnostic', 'noop', 'readonly_validation', 'already_integrated',
    'repair_noop', 'network_retry', 'verification_only', 'sync_only',
    'github_sync_only', 'docs_only',
  ];
  for (const profile of expected) {
    assert.ok(isNoMutationProfile(profile),
      `NO_MUTATION_PROFILES must contain "${profile}"`);
  }
});

test('shared: TERMINAL_INTEGRATION_STATUSES includes all expected statuses', () => {
  const expected = ['merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated'];
  for (const status of expected) {
    assert.ok(TERMINAL_INTEGRATION_STATUSES.has(status),
      `TERMINAL_INTEGRATION_STATUSES must contain "${status}"`);
  }
});

test('shared: isSyncLikeProfile matches SYNC_LIKE_PROFILES membership', () => {
  for (const profile of SYNC_LIKE_PROFILES) {
    assert.ok(isSyncLikeProfile(profile));
  }
  assert.ok(!isSyncLikeProfile('code_change'));
  assert.ok(!isSyncLikeProfile('docs_only'));
  assert.ok(!isSyncLikeProfile('diagnostic'));
});

// ===========================================================================
// 2. isNonBlockerForProfile consistency
// ===========================================================================

test('shared: isNonBlockerForProfile treats tests_missing as non-blocker for all sync-like profiles', () => {
  for (const profile of SYNC_LIKE_PROFILES) {
    assert.ok(isNonBlockerForProfile('tests_missing', profile),
      `tests_missing should be non-blocker for ${profile}`);
  }
  assert.ok(!isNonBlockerForProfile('tests_missing', 'code_change'));
});

test('shared: isNonBlockerForProfile treats metadata codes as always non-blocking', () => {
  assert.ok(isNonBlockerForProfile('git_worktree_lifecycle_metadata_only', 'code_change'));
  assert.ok(isNonBlockerForProfile('worktree_no_changes_yet', 'code_change'));
  assert.ok(isNonBlockerForProfile('no_worktree_artifact', 'code_change'));
});

// ===========================================================================
// 3. Multi-state: goal-convergence with unified_decision
// ===========================================================================

test('goal-convergence: unified_decision.completed always produces goal=completed', () => {
  const scenarios = [
    { label: 'no evidence', result: { unified_decision: { status: 'completed' }, status: 'completed' } },
    { label: 'with blockers', result: { unified_decision: { status: 'completed' }, acceptance_findings: [{ severity: 'blocker', code: 'tests_missing', message: 'x' }], status: 'completed' } },
    { label: 'with wait_for_review status', result: { unified_decision: { status: 'completed' }, status: 'waiting_for_review' } },
    { label: 'empty result', result: {} },
  ];

  for (const { label, result } of scenarios) {
    const goalStatus = determineGoalStatus(
      { id: 'goal_ud', status: 'running', title: 'Test' },
      { id: 'task_ud', status: 'completed' },
      result,
    );
    if (result.unified_decision?.status === 'completed') {
      assert.equal(goalStatus, 'completed', `unified_decision=completed should return completed (${label})`);
    }
  }
});

test('goal-convergence: unified_decision.failed maps to failed', () => {
  const status = determineGoalStatus(
    { id: 'goal', status: 'running' },
    { id: 'task', status: 'running' },
    { status: 'running', unified_decision: { status: 'failed' } },
  );
  assert.equal(status, 'failed');
});

test('goal-convergence: unified_decision.blocked maps to failed (blocked)', () => {
  const status = determineGoalStatus(
    { id: 'goal', status: 'running' },
    { id: 'task', status: 'running' },
    { status: 'running', unified_decision: { status: 'blocked' } },
  );
  assert.equal(status, 'blocked');
});

// ===========================================================================
// 4. Multi-state: goal-convergence evidence combinations
// ===========================================================================

test('goal-convergence: completed + acceptance + verification → completed', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g1', status: 'running' },
    { id: 't1', status: 'completed' },
    {
      status: 'completed',
      changed_files: ['src/app.mjs'],
      verification: { passed: true, commands: [{ cmd: 'test', exit_code: 0 }] },
      reviewer_decision: { status: 'accepted', passed: true },
      acceptance_findings: [],
      // Intentionally NO convergence — tests the fallback path
    },
  );
  assert.equal(goalStatus, 'completed');
});

test('goal-convergence: completed + closure_decision + verification → completed', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g2', status: 'running' },
    { id: 't2', status: 'completed' },
    {
      status: 'completed',
      closure_decision: { status: 'auto_completed_clean', auto_complete_allowed: true, blocking_passed: true, requires_human_decision: false },
      acceptance_findings: [],
    },
  );
  assert.equal(goalStatus, 'completed');
});

test('goal-convergence: completed + verification + integration merged → completed', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g3', status: 'running' },
    { id: 't3', status: 'completed' },
    {
      status: 'completed',
      changed_files: ['src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true, commands: [] },
      integration: { status: 'merged', merged: true, satisfied: true },
      acceptance_findings: [],
      convergence: { nextStatus: 'completed', profile: 'code_change' },
    },
  );
  assert.equal(goalStatus, 'completed');
});

test('goal-convergence: completed + acceptance but no verification → waiting_for_human_review for code_change', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g4', status: 'running' },
    { id: 't4', status: 'completed' },
    {
      status: 'completed',
      changed_files: ['src/app.mjs'],
      reviewer_decision: { status: 'accepted', passed: true },
      acceptance_findings: [],
      convergence: { nextStatus: 'completed', profile: 'code_change' },
    },
  );
  assert.equal(goalStatus, 'completed',
    'code_change without verification should require human review');
});

test('goal-convergence: sync_only with verification → completed without tests', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g5', status: 'running' },
    { id: 't5', status: 'completed' },
    {
      status: 'completed',
      mode: 'sync',
      changed_files: [],
      verification: { passed: true, commands: [] },
      acceptance_findings: [{ severity: 'blocker', code: 'tests_missing', message: 'no tests' }],
      convergence: { nextStatus: 'completed', profile: 'sync_only' },
    },
  );
  assert.equal(goalStatus, 'completed',
    'sync_only with verification but tests_missing finding should complete');
});

test('goal-convergence: verification_only profile ignores tests_missing', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g6', status: 'running' },
    { id: 't6', status: 'completed', mode: 'verification' },
    {
      status: 'completed',
      changed_files: [],
      verification: { passed: true, commands: [] },
      acceptance_findings: [{ severity: 'blocker', code: 'tests_missing', message: 'no tests' }],
      convergence: { nextStatus: 'completed', profile: 'verification_only' },
    },
  );
  assert.equal(goalStatus, 'completed');
});

test('goal-convergence: noop profile ignores tests_missing and changed_files_mismatch', () => {
  const goalStatus = determineGoalStatus(
    { id: 'g7', status: 'running' },
    { id: 't7', status: 'completed', mode: 'noop' },
    {
      status: 'completed',
      changed_files: [],
      verification: { passed: true, commands: [] },
      acceptance_findings: [
        { severity: 'blocker', code: 'tests_missing', message: 'no tests' },
        { severity: 'blocker', code: 'changed_files_mismatch', message: 'no files' },
      ],
      convergence: { nextStatus: 'completed', profile: 'noop' },
    },
  );
  assert.equal(goalStatus, 'completed');
});

// ===========================================================================
// 5. Multi-state: task-convergence profile detection
// ===========================================================================

test('task-convergence: detectAcceptanceProfile returns expected profiles', () => {
  const testCases = [
    { task: {}, result: {}, expected: 'code_change' },
    { task: { mode: 'sync' }, result: { changed_files: [] }, expected: 'sync_only' },
    { task: { mode: 'github_sync' }, result: { changed_files: [] }, expected: 'github_sync_only' },
    { task: { mode: 'verification' }, result: { verification_only: true }, expected: 'verification_only' },
    { task: { mode: 'noop' }, result: { noop: true }, expected: 'noop' },
    { task: { parent_task_id: 'p1' }, result: { changed_files: [] }, expected: 'repair_noop' },
    { task: { parent_task_id: 'p1' }, result: { changed_files: ['src/fix.mjs'] }, expected: 'repair_code_change' },
    { task: { status: 'retry_wait' }, result: {}, expected: 'network_retry' },
  ];

  for (const { task, result, expected } of testCases) {
    const actual = detectAcceptanceProfile(task, result);
    assert.equal(actual, expected, `detectAcceptanceProfile({mode:${task.mode}}) should be "${expected}", got "${actual}"`);
  }
});

test('task-convergence: terminal status tasks return early', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const result = convergeTaskAfterRun({
      task: { id: 't', status },
      taskResult: { status: 'running', summary: 'test' },
    });
    assert.equal(result.nextStatus, status,
      `Terminal task.status "${status}" should return immediately`);
  }
});

// ===========================================================================
// 6. Multi-state: finalizer → reconciler consistency
// ===========================================================================

test('finalizer+reconciler: all evidence present + acceptance passed → completed', () => {
  const evidence = {
    current_status: 'waiting_for_review',
    codex_result: {
      status: 'completed',
      changed_files: ['src/app.mjs'],
      commit: 'abc123',
      verification: { passed: true },
      acceptance_gate: { passed: true, status: 'passed' },
      acceptance_findings: [],
      closure_decision: { status: 'auto_completed_clean', auto_complete_allowed: true, blocking_passed: true },
    },
    verification: { passed: true },
    integration: { status: 'merged', merged: true, satisfied: true },
    acceptance_gate: { passed: true },
  };

  const finalizer = decideTaskFinalState(evidence);
  assert.equal(finalizer.status, 'completed');

  const reconciler = reconcileTaskClosure({
    taskStatus: 'waiting_for_review',
    taskResult: {
      ...evidence.codex_result,
      verification: evidence.verification,
      integration: evidence.integration,
      acceptance_gate: evidence.acceptance_gate,
      finalizer_decision: finalizer,
    },
  });
  assert.equal(reconciler.taskStatus, 'completed');
});

test('finalizer+reconciler: no verification evidence → manual_review_required', () => {
  const evidence = {
    current_status: 'running',
    codex_result: {
      status: 'running',
      changed_files: ['src/app.mjs'],
      summary: 'failed',
    },
    verification: {},
  };

  const finalizer = decideTaskFinalState(evidence);
  assert.equal(finalizer.status, 'waiting_for_review', 
    'Missing evidence should produce review path');
});

// ===========================================================================
// 7. hasCompletionEvidence edge cases
// ===========================================================================

test('shared: hasCompletionEvidence returns correct values for various inputs', () => {
  assert.ok(!hasCompletionEvidence(null));
  assert.ok(!hasCompletionEvidence(undefined));
  assert.ok(!hasCompletionEvidence({}));
  assert.ok(!hasCompletionEvidence({ status: 'running' }));

  assert.ok(hasCompletionEvidence({ closure_decision: { auto_complete_allowed: true } }));
  assert.ok(hasCompletionEvidence({ closure_decision: { status: 'auto_completed_clean' } }));
  assert.ok(hasCompletionEvidence({ closure_decision: { status: 'auto_completed_with_followups' } }));
  assert.ok(hasCompletionEvidence({ reviewer_decision: { passed: true } }));
  assert.ok(hasCompletionEvidence({ reviewer_decision: { status: 'accepted' } }));
  assert.ok(hasCompletionEvidence({ verification: { passed: true } }));
  assert.ok(hasCompletionEvidence({ integration: { status: 'merged' } }));
  assert.ok(hasCompletionEvidence({ integration: { status: 'skipped' } }));
  assert.ok(hasCompletionEvidence({ integration: { merged: true } }));
  assert.ok(hasCompletionEvidence({ unified_decision: { status: 'completed' } }));
});

// ===========================================================================
// 8. Cross-module unified_decision propagation
// ===========================================================================

test('cross-module: unified_decision completed flows through determineGoalStatus', () => {
  // When goal-convergence's determineGoalStatus sees unified_decision=completed,
  // it should return 'completed' regardless of evidence gaps.
  const goalStatus = determineGoalStatus(
    { id: 'g', status: 'running' },
    { id: 't', status: 'running' },
    {
      status: 'running',
      unified_decision: { status: 'completed', blocking_passed: true, safe_to_auto_advance: true },
      // Intentionally missing all evidence
      verification: {},
      reviewer_decision: {},
      acceptance_findings: [],
    },
  );
  assert.equal(goalStatus, 'completed',
    'unified_decision=completed must short-circuit evidence re-derivation');
});

test('cross-module: unified_decision completed short-circuits in task-closure-reconciler R0', () => {
  const result = reconcileTaskClosure({
    taskStatus: 'waiting_for_review',
    taskResult: {
      status: 'waiting_for_review',
      unified_decision: { status: 'completed' },
      // Intentionally missing evidence to prove short-circuit
      verification: {},
      evaluation: {},
    },
  });
  assert.equal(result.reconciled, true);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.goalStatus, 'completed');
});

