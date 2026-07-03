/**
 * integration-backlog-reconciler.test.mjs — Tests for Integration Backlog Reconciler
 *
 * P0-MA7 coverage:
 * - Constants structure and freeze
 * - acceptanceSatisfied helper
 * - extractCommit helper
 * - integrationNotRequired helper
 * - isExternalIntegrationWait helper
 * - classifyIntegrationState: already integrated + accepted → completed
 * - classifyIntegrationState: already integrated + no acceptance → typed blocker
 * - classifyIntegrationState: commit not on main → genuine waiting_for_integration
 * - classifyIntegrationState: commit missing → typed blocker
 * - classifyIntegrationState: integration not required → noop-like
 * - classifyIntegrationState: external wait (branch_pushed)
 * - classifyIntegrationState: repairable integration failure
 * - runIntegrationBacklogReconcile: full backlog scan with no waiting tasks
 * - runIntegrationBacklogReconcile: full backlog scan with mixed tasks
 * - reconcileIntegrationBacklog: store error handling
 * - reconcileIntegrationTask: null task handling
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTEGRATION_RECONCILIATION_TYPES,
  acceptanceSatisfied,
  extractCommit,
  integrationNotRequired,
  isExternalIntegrationWait,
  classifyIntegrationState,
  reconcileIntegrationTask,
  reconcileIntegrationBacklog,
  runIntegrationBacklogReconcile,
  isCommitOnMain,
  commitExistsInRepo,
} from '../src/integration-backlog-reconciler.mjs';

import { TASK_STATUSES } from '../src/task-status-taxonomy.mjs';

// =========================================================================
// 1. Constants structure
// =========================================================================

test('INTEGRATION_RECONCILIATION_TYPES is frozen with expected 9 keys', () => {
  assert.equal(Object.isFrozen(INTEGRATION_RECONCILIATION_TYPES), true);
  const expected = [
    'ALREADY_INTEGRATED_AND_ACCEPTED',
    'ALREADY_INTEGRATED_NO_ACCEPTANCE',
    'COMMIT_NOT_ON_MAIN',
    'COMMIT_MISSING',
    'ACCEPTANCE_NOT_SATISFIED',
    'INTEGRATION_NOT_NEEDED',
    'REPAIRABLE_INTEGRATION_FAILURE',
    'WAITING_FOR_EXTERNAL_INTEGRATION',
    'STILL_WAITING_FOR_INTEGRATION',
  ];
  assert.deepEqual(Object.keys(INTEGRATION_RECONCILIATION_TYPES).sort(), expected.sort());

  assert.equal(INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED, 'already_integrated_and_accepted');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_NO_ACCEPTANCE, 'already_integrated_no_acceptance');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.COMMIT_NOT_ON_MAIN, 'commit_not_on_main');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING, 'commit_missing');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.INTEGRATION_NOT_NEEDED, 'integration_not_needed');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE, 'repairable_integration_failure');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.WAITING_FOR_EXTERNAL_INTEGRATION, 'waiting_for_external_integration');
  assert.equal(INTEGRATION_RECONCILIATION_TYPES.STILL_WAITING_FOR_INTEGRATION, 'still_waiting_for_integration');
});

// =========================================================================
// 2. acceptanceSatisfied helper
// =========================================================================

test('acceptanceSatisfied returns true when acceptance_gate passed', () => {
  assert.equal(acceptanceSatisfied({ acceptance_gate: { passed: true } }), true);
});

test('acceptanceSatisfied returns true when acceptance status is accepted', () => {
  assert.equal(acceptanceSatisfied({ acceptance: { status: 'accepted' } }), true);
});

test('acceptanceSatisfied returns true when reviewer_decision passed', () => {
  assert.equal(acceptanceSatisfied({ reviewer_decision: { passed: true } }), true);
});

test('acceptanceSatisfied returns true when reviewer_decision.decision passed', () => {
  assert.equal(acceptanceSatisfied({ reviewer_decision: { decision: { passed: true } } }), true);
});

test('acceptanceSatisfied returns true when verification passed and no blockers', () => {
  assert.equal(acceptanceSatisfied({ verification: { passed: true } }), true);
});

test('acceptanceSatisfied returns false when verification passed but blockers exist', () => {
  const result = {
    verification: { passed: true, findings: [{ severity: 'blocker', code: 'test_failed', message: 'Test failed', resolved: false }] },
  };
  assert.equal(acceptanceSatisfied(result), false);
});

test('acceptanceSatisfied returns false when no acceptance evidence', () => {
  assert.equal(acceptanceSatisfied({}), false);
  assert.equal(acceptanceSatisfied({ verification: { passed: false } }), false);
});

// =========================================================================
// 3. extractCommit helper
// =========================================================================

test('extractCommit returns commit field', () => {
  assert.equal(extractCommit({ commit: 'abc123' }), 'abc123');
});

test('extractCommit falls back to local_head', () => {
  assert.equal(extractCommit({ local_head: 'def456' }), 'def456');
});

test('extractCommit falls back to repo_head', () => {
  assert.equal(extractCommit({ repo_head: 'ghi789' }), 'ghi789');
});

test('extractCommit returns null when no commit fields', () => {
  assert.equal(extractCommit({}), null);
  assert.equal(extractCommit({ status: 'completed' }), null);
});

// =========================================================================
// 4. integrationNotRequired helper
// =========================================================================

test('integrationNotRequired returns true when integration_not_required is set', () => {
  assert.equal(integrationNotRequired({ integration_not_required: true }), true);
});

test('integrationNotRequired returns true when needs_integration is false', () => {
  assert.equal(integrationNotRequired({ needs_integration: false }), true);
});

test('integrationNotRequired returns true when operation_kind is noop', () => {
  assert.equal(integrationNotRequired({ operation_kind: 'noop' }), true);
});

test('integrationNotRequired returns true when operation_kind is readonly_validation', () => {
  assert.equal(integrationNotRequired({ operation_kind: 'readonly_validation' }), true);
});

test('integrationNotRequired returns true when operation_kind is diagnostic', () => {
  assert.equal(integrationNotRequired({ operation_kind: 'diagnostic' }), true);
});

test('integrationNotRequired returns true when operation_kind is already_integrated', () => {
  assert.equal(integrationNotRequired({ operation_kind: 'already_integrated' }), true);
});

test('integrationNotRequired returns true when noop_result is true', () => {
  assert.equal(integrationNotRequired({ noop_result: true }), true);
});

test('integrationNotRequired returns false when no integration evidence', () => {
  assert.equal(integrationNotRequired({}), false);
});

test('integrationNotRequired returns false for code_change operation_kind', () => {
  assert.equal(integrationNotRequired({ operation_kind: 'code_change' }), false);
});

test('integrationNotRequired returns false when needs_integration is true', () => {
  assert.equal(integrationNotRequired({ needs_integration: true }), false);
});

// =========================================================================
// 5. isExternalIntegrationWait helper
// =========================================================================

test('isExternalIntegrationWait returns true for branch_pushed status', () => {
  assert.equal(isExternalIntegrationWait({ integration: { status: 'branch_pushed', ok: true } }), true);
});

test('isExternalIntegrationWait returns true for pr_opened status', () => {
  assert.equal(isExternalIntegrationWait({ integration: { status: 'pr_opened', ok: true } }), true);
});

test('isExternalIntegrationWait returns true when integration_terminalization indicates external wait', () => {
  assert.equal(isExternalIntegrationWait({ integration_terminalization: { status: 'waiting_for_external_integration' } }), true);
});

test('isExternalIntegrationWait returns false for merged status', () => {
  assert.equal(isExternalIntegrationWait({ integration: { status: 'merged' } }), false);
});

test('isExternalIntegrationWait returns false when no integration evidence', () => {
  assert.equal(isExternalIntegrationWait({}), false);
});

test('isExternalIntegrationWait returns false for failed integration', () => {
  assert.equal(isExternalIntegrationWait({ integration: { status: 'conflict', ok: false } }), false);
});

// =========================================================================
// 6. classifyIntegrationState: pure classification tests (no git required)
// =========================================================================

test('classifyIntegrationState: integration not required (noop-like)', () => {
  const result = classifyIntegrationState({
    task: { result: { operation_kind: 'noop' } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.INTEGRATION_NOT_NEEDED);
  assert.equal(result.integration_not_required, true);
  assert.equal(result.repairable, false);
});

test('classifyIntegrationState: external integration wait (branch_pushed)', () => {
  const result = classifyIntegrationState({
    task: { result: { integration: { status: 'branch_pushed', ok: true } } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.WAITING_FOR_EXTERNAL_INTEGRATION);
  assert.equal(result.external_wait, true);
});

test('classifyIntegrationState: repairable integration failure (conflict)', () => {
  const result = classifyIntegrationState({
    task: { result: { integration: { status: 'conflict', error: 'merge conflict in src/app.mjs' } } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE);
  assert.equal(result.repairable, true);
});

test('classifyIntegrationState: repairable integration failure (check_failed)', () => {
  const result = classifyIntegrationState({
    task: { result: { integration: { status: 'check_failed', error: 'pre-check failed' } } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE);
  assert.equal(result.repairable, true);
});

test('classifyIntegrationState: commit missing', () => {
  const result = classifyIntegrationState({
    task: { result: { status: 'waiting_for_integration', changed_files: ['src/app.mjs'] } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING);
  assert.equal(result.commit, null);
});

test('classifyIntegrationState: commit missing when commit is "none"', () => {
  const result = classifyIntegrationState({
    task: { result: { commit: 'none' } },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING);
  assert.equal(result.commit, null);
});

test('classifyIntegrationState: commit not on main (no canonical repo path)', () => {
  // Without a canonicalRepoPath, the commit_on_main check returns false
  const result = classifyIntegrationState({
    task: {
      result: {
        commit: 'abc123def456abc123def456abc123def456abc1',
        verification: { passed: true },
        reviewer_decision: { decision: { passed: true } },
      },
    },
    canonicalRepoPath: null,
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_NOT_ON_MAIN);
  assert.equal(result.commit_on_main, false);
  assert.equal(result.acceptance_satisfied, true);
});

test('classifyIntegrationState: commit on main + acceptance satisfied when canonicalRepoPath has commit on main', () => {
  // This requires a real git repo — test with an in-memory like approach
  // For pure unit tests, we mock isCommitOnMain by providing a real canonical repo path
  // that points to our own repo where HEAD commit is trivially on main
  const selfPath = process.cwd();
  const result = classifyIntegrationState({
    task: {
      result: {
        commit: 'HEAD',
        reviewer_decision: { passed: true },
      },
    },
    canonicalRepoPath: selfPath,
  });
  // HEAD is always an ancestor of HEAD
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED);
  assert.equal(result.commit_on_main, true);
  assert.equal(result.acceptance_satisfied, true);
});

test('classifyIntegrationState: commit on main + acceptance not satisfied', () => {
  const selfPath = process.cwd();
  const result = classifyIntegrationState({
    task: {
      result: {
        commit: 'HEAD',
        // No reviewer_decision, no acceptance_gate — acceptance not satisfied
      },
    },
    canonicalRepoPath: selfPath,
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_NO_ACCEPTANCE);
  assert.equal(result.commit_on_main, true);
  assert.equal(result.acceptance_satisfied, false);
});

test('classifyIntegrationState: acceptance_findings with blocker blocks acceptance', () => {
  const result = classifyIntegrationState({
    task: {
      result: {
        commit: 'abc123',
        verification: { passed: true },
        acceptance_findings: [{ severity: 'blocker', code: 'test_missing', message: 'Missing tests', resolved: false }],
      },
    },
  });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_NOT_ON_MAIN);
  assert.equal(result.acceptance_satisfied, false);
});

test('classifyIntegrationState: resolved blockers allow acceptance', () => {
  const result = classifyIntegrationState({
    task: {
      result: {
        commit: 'abc123',
        verification: { passed: true },
        acceptance_findings: [{ severity: 'blocker', code: 'test_missing', message: 'Missing tests', resolved: true }],
      },
    },
  });
  assert.equal(result.acceptance_satisfied, true);
});

// =========================================================================
// 7. reconcileIntegrationTask: task-level reconciliation
// =========================================================================

test('reconcileIntegrationTask returns error for null task', async () => {
  const result = await reconcileIntegrationTask({ task: null });
  assert.equal(result.status, 'error');
  assert.equal(result.reconciled, false);
  assert.ok(result.error);
});

test('reconcileIntegrationTask returns not reconciled for commit_missing task', async () => {
  const result = await reconcileIntegrationTask({
    task: { id: 'task_1', status: 'waiting_for_integration', result: {} },
  });
  assert.equal(result.reconciled, false);
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING);
  assert.equal(result.task_id, 'task_1');
});

// =========================================================================
// 8. runIntegrationBacklogReconcile: full backlog scan
// =========================================================================

test('runIntegrationBacklogReconcile returns empty for no waiting_for_integration tasks', async () => {
  const tasks = [
    { id: 't1', status: 'completed', assignee: 'codex' },
    { id: 't2', status: 'running', assignee: 'codex' },
  ];
  const result = await runIntegrationBacklogReconcile(tasks);
  assert.equal(result.total_scanned, 0);
  assert.equal(result.reconciled_count, 0);
  assert.equal(result.still_blocked_count, 0);
  assert.deepEqual(result.type_counts, {});
});

test('runIntegrationBacklogReconcile scans waiting_for_integration tasks', async () => {
  const tasks = [
    { id: 't1', status: 'waiting_for_integration', assignee: 'codex', result: {} },
    { id: 't2', status: 'completed', assignee: 'codex', result: { commit: 'abc' } },
  ];
  const result = await runIntegrationBacklogReconcile(tasks);
  assert.equal(result.total_scanned, 1);
  assert.equal(result.still_blocked_count, 1);
  assert.equal(result.reconciled_count, 0);
  assert.equal(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING], 1);
});

test('runIntegrationBacklogReconcile scans task with commit on main', async () => {
  const selfPath = process.cwd();
  const tasks = [
    {
      id: 't_already_integrated',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {
        commit: 'HEAD',
        reviewer_decision: { passed: true },
        execution_cwd: selfPath,
      },
    },
  ];
  const result = await runIntegrationBacklogReconcile(tasks, { defaultWorkspaceRoot: selfPath });
  assert.equal(result.total_scanned, 1);
  assert.equal(result.reconciled_count, 1);
  assert.equal(result.still_blocked_count, 0);
  assert.equal(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED], 1);
});

test('runIntegrationBacklogReconcile with mixed classifications', async () => {
  const selfPath = process.cwd();
  const tasks = [
    {
      id: 't_already_integrated',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {
        commit: 'HEAD',
        reviewer_decision: { passed: true },
        execution_cwd: selfPath,
      },
    },
    {
      id: 't_no_commit',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {},
    },
    {
      id: 't_branch_pushed',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {
        integration: { status: 'branch_pushed', ok: true },
      },
    },
    {
      id: 't_conflict',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {
        integration: { status: 'conflict', ok: false, error: 'merge conflict' },
      },
    },
    {
      id: 't_noop',
      status: 'waiting_for_integration',
      assignee: 'codex',
      result: {
        operation_kind: 'noop',
      },
    },
  ];
  const result = await runIntegrationBacklogReconcile(tasks, { defaultWorkspaceRoot: selfPath });
  assert.equal(result.total_scanned, 5);
  assert.equal(result.reconciled_count, 1);
  assert.equal(result.still_blocked_count, 4);
  assert.ok(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED] >= 1);
  assert.ok(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING] >= 1);
  assert.equal(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.WAITING_FOR_EXTERNAL_INTEGRATION], 1);
  assert.equal(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE], 1);
  assert.equal(result.type_counts[INTEGRATION_RECONCILIATION_TYPES.INTEGRATION_NOT_NEEDED], 1);
});

// =========================================================================
// 9. reconcileIntegrationBacklog: store error handling
// =========================================================================

test('reconcileIntegrationBacklog returns error when store has no load function', async () => {
  const result = await reconcileIntegrationBacklog({});
  assert.equal(result.total_scanned, 0);
  assert.ok(result.error);
});

test('reconcileIntegrationBacklog returns error when store is null', async () => {
  const result = await reconcileIntegrationBacklog(null);
  assert.equal(result.total_scanned, 0);
  assert.ok(result.error);
});

// =========================================================================
// 10. isCommitOnMain / commitExistsInRepo: git helper robustness
// =========================================================================

test('isCommitOnMain returns false for empty args', () => {
  assert.equal(isCommitOnMain(null, null), false);
  assert.equal(isCommitOnMain('/tmp', null), false);
  assert.equal(isCommitOnMain(null, 'abc'), false);
});

test('isCommitOnMain returns false for non-existent repo path', () => {
  assert.equal(isCommitOnMain('/nonexistent/path', 'abc123'), false);
});

test('commitExistsInRepo returns false for empty args', () => {
  assert.equal(commitExistsInRepo(null, null), false);
  assert.equal(commitExistsInRepo('/tmp', null), false);
});

test('commitExistsInRepo returns false for non-existent commit', () => {
  // /tmp generally won't be a git repo, so cat-file should fail
  assert.equal(commitExistsInRepo('/tmp', '0000000000000000000000000000000000000000'), false);
});

// =========================================================================
// 11. Edge cases
// =========================================================================

test('classifyIntegrationState with empty task defaults to commit_missing', () => {
  const result = classifyIntegrationState({ task: {} });
  assert.equal(result.classification, INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING);
});

test('reconcileIntegrationTask with minimal task returns not reconciled', async () => {
  const result = await reconcileIntegrationTask({ task: { id: 'minimal', status: 'waiting_for_integration' } });
  assert.equal(result.reconciled, false);
  assert.equal(result.task_status, 'waiting_for_integration');
  assert.ok(result.reason);
});

test('reconcileIntegrationTask preserves goal_id', async () => {
  const result = await reconcileIntegrationTask({
    task: { id: 't1', goal_id: 'g1', status: 'waiting_for_integration', result: {} },
  });
  assert.equal(result.goal_id, 'g1');
});

test('multiple acceptances: acceptance_gate passed', () => {
  assert.equal(acceptanceSatisfied({ acceptance_gate: { passed: true } }), true);
});

test('multiple acceptances: reviewer_decision decision accepted', () => {
  assert.equal(acceptanceSatisfied({ reviewer_decision: { decision: { status: 'accepted' } } }), true);
});
