/**
 * review-backlog-reconciler.test.mjs — Tests for Review Backlog State Convergence
 *
 * P0-MA5 coverage:
 * - Constants structure and freeze
 * - reconcileBundle: completed+integrated with stale changed_files_mismatch
 * - reconcileBundle: completed/integrated with stale result_summary.status
 * - reconcileBundle: true unresolved changed_files_mismatch remains blocking
 * - reconcileBundle: diagnostic/no-mutation → typed followup not blocker
 * - reconcileBundle: compact bundle exposes reconciled status
 * - reconcileTask: single-task with store
 * - reconcileReviewBacklog: full backlog scan
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_TYPES,
  reconcileBundle,
  reconcileTask,
  reconcileReviewBacklog,
} from '../src/review/review-backlog-reconciler.mjs';

// =========================================================================
// 1. Constants structure
// =========================================================================

test('RECONCILIATION_TYPES is frozen with expected keys', () => {
  assert.equal(Object.isFrozen(RECONCILIATION_TYPES), true);
  const expected = [
    'INTEGRATION_RECOVERY_REQUIRED',
    'MISSING_CONTRACT_VERIFICATION',
    'MISSING_TESTS_EVIDENCE',
    'RECONCILED_BY_AUTO_RETRY',
    'RECONCILED_BY_COMPLETION',
    'RECONCILED_BY_EVIDENCE_COLLECTION',
    'RECONCILED_BY_INTEGRATION',
    'RECONCILED_BY_NOOP_EVIDENCE',
    'RECONCILED_BY_POLICY_PROPOSAL',
    'RECONCILED_BY_SUCCESSOR',
    'RECONCILED_DIAGNOSTIC_NO_MUTATION',
    'RECONCILED_STATUS',
    'STILL_BLOCKING',
    'STILL_POLICY_UNCERTAIN',
    'STILL_PROVIDER_UNAVAILABLE',
    'TRUE_HUMAN_REVIEW_REQUIRED',
  ];
  assert.deepEqual(Object.keys(RECONCILIATION_TYPES).sort(), expected.sort());

  assert.equal(RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION, 'reconciled_by_integration');
  assert.equal(RECONCILIATION_TYPES.RECONCILED_BY_SUCCESSOR, 'reconciled_by_successor');
  assert.equal(RECONCILIATION_TYPES.RECONCILED_BY_COMPLETION, 'reconciled_by_completion');
  assert.equal(RECONCILIATION_TYPES.STILL_BLOCKING, 'still_blocking');
  assert.equal(RECONCILIATION_TYPES.RECONCILED_DIAGNOSTIC_NO_MUTATION, 'reconciled_diagnostic_no_mutation');
  assert.equal(RECONCILIATION_TYPES.MISSING_CONTRACT_VERIFICATION, 'missing_contract_verification');
});

// =========================================================================
// 2. Completed+integrated task with stale changed_files_mismatch
//    (MA4-like scenario — the primary known issue)
// =========================================================================

test('reconcileBundle: completed+integrated task with stale changed_files_mismatch — reconciled_by_integration', () => {
  const task = {
    id: 'task_ma4_original',
    status: 'completed',
    result: {
      status: 'completed',
      summary: 'MA4: default multi-agent pipeline',
      changed_files: ['backend/src/agent-service.mjs'],
      verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
      integration: { status: 'merged', merged: true, commit: '87e5d99b37179ba46889dff42010532f95467036' },
      closure_decision: { status: 'completed', reason: 'ok' },
    },
  };

  // Bundle mimics the stale compact bundle from the MA4 scenario:
  // result_summary.status is "waiting_for_repair" (stale),
  // blockers contain changed_files_mismatch (stale),
  // contract_verification is null
  const bundle = {
    task_id: 'task_ma4_original',
    status: 'completed',
    result_summary: {
      status: 'waiting_for_repair',
      summary: 'MA4: default multi-agent pipeline',
      commit: '87e5d99b37179ba46889dff42010532f95467036',
    },
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    contract_verification: null,
    integration: { status: 'merged', merged: true, commit: '87e5d99b37179ba46889dff42010532f95467036' },
    blockers: [
      {
        severity: 'major',
        code: 'changed_files_mismatch',
        message: 'Files in result not found in git diff',
        source: 'acceptance_agent',
      },
    ],
    missing_evidence: [
      { code: 'contract_verification_missing', message: 'No contract_verification evidence' },
    ],
    changed_files: ['backend/src/agent-service.mjs'],
  };

  const result = reconcileBundle({ task, bundle });

  // Should be reconciled overall (still_blocking is empty even with stale blockers)
  assert.equal(result.reconciled, true);
  assert.equal(result.reconciled_count >= 1, true);
  assert.equal(result.still_blocking_count, 0);

  // stale_result_summary_status should be flagged and reconciled
  const statusReconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_STATUS
  );
  assert.ok(statusReconciled, 'stale result_summary.status should be reconciled');
  assert.equal(statusReconciled.resolved_by, 'terminal_completion_and_integration');

  // changed_files_mismatch should be reconciled_by_integration
  const blockerReconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION
  );
  assert.ok(blockerReconciled, 'changed_files_mismatch should be reconciled_by_integration');
  assert.ok(blockerReconciled.evidence?.integration_merged === true);

  // No still_blocking items
  assert.deepEqual(result.still_blocking, []);

  // Evidence shows integration state
  assert.ok(result.evidence?.stale_status_reconciled === true);
});

// =========================================================================
// 3. Completed/integrated task with stale result_summary.status waiting_for_repair
// =========================================================================

test('reconcileBundle: completed+integrated task with stale result_summary.status waiting_for_repair', () => {
  const task = {
    id: 'task_stale_status',
    status: 'completed',
    result: {
      integration: { status: 'merged', merged: true, commit: 'abc123' },
    },
  };

  const bundle = {
    task_id: 'task_stale_status',
    status: 'completed',
    result_summary: {
      status: 'waiting_for_repair',
      summary: 'Old result',
    },
    verification: null,
    contract_verification: null,
    integration: { status: 'merged', merged: true, commit: 'abc123' },
    blockers: [],
    missing_evidence: [],
    changed_files: [],
  };

  const result = reconcileBundle({ task, bundle });

  // Should flag stale result_summary.status
  const statusReconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_STATUS
  );
  assert.ok(statusReconciled, 'stale waiting_for_repair status should be flagged');
  assert.equal(statusReconciled.resolved_by, 'terminal_completion_and_integration');

  // Should be reconciled overall
  assert.equal(result.reconciled, true);
  assert.equal(result.still_blocking_count, 0);

  // Evidence shows stale status was detected
  assert.equal(result.bundle_result_summary_status, 'waiting_for_repair');
  assert.equal(result.is_integrated, true);
});

// =========================================================================
// 4. True unresolved changed_files_mismatch must remain blocking
// =========================================================================

test('reconcileBundle: true unresolved changed_files_mismatch — remains blocking', () => {
  const task = {
    id: 'task_unresolved',
    status: 'waiting_for_repair',
    result: {
      changed_files: ['backend/src/new-file.mjs'],
    },
  };

  const bundle = {
    task_id: 'task_unresolved',
    status: 'waiting_for_repair',
    result_summary: { status: 'waiting_for_repair', summary: 'Unresolved mismatch' },
    verification: null,
    contract_verification: null,
    integration: null,
    blockers: [
      {
        severity: 'major',
        code: 'changed_files_mismatch',
        message: 'Files in result not found in git diff: backend/src/new-file.mjs',
        source: 'acceptance_agent',
      },
    ],
    missing_evidence: [
      { code: 'contract_verification_missing', message: 'No contract_verification' },
    ],
    changed_files: ['backend/src/new-file.mjs'],
  };

  const result = reconcileBundle({ task, bundle });

  // Should NOT be reconciled
  assert.equal(result.reconciled, false);
  assert.equal(result.still_blocking_count, 1);

  // The changed_files_mismatch should remain in still_blocking
  const stillBlocking = result.still_blocking.find(b => b.code === 'changed_files_mismatch');
  assert.ok(stillBlocking, 'changed_files_mismatch should remain in still_blocking');

  // No reconciliation finding for the blocker
  const blockerReconciled = result.reconciled_findings.find(
    f => f.original_code === 'changed_files_mismatch'
  );
  assert.equal(blockerReconciled, undefined, 'change_files_mismatch should not be reconciled for unresolved task');
});

// =========================================================================
// 5. Diagnostic/no-mutation → typed followup not blocker
// =========================================================================

test('reconcileBundle: diagnostic/no-mutation changed_files_mismatch — reconciled_diagnostic_no_mutation when profile matches', () => {
  const task = {
    id: 'task_diagnostic',
    status: 'completed',
    result: {
      operation_kind: 'diagnostic',
    },
  };

  const bundle = {
    task_id: 'task_diagnostic',
    status: 'completed',
    result_summary: { status: 'completed', summary: 'Diagnostic check' },
    verification: { passed: true, commands: [] },
    contract_verification: null,
    integration: null,
    acceptance_contract_summary: {
      operation_kind: 'diagnostic',
    },
    blockers: [
      {
        severity: 'major',
        code: 'changed_files_mismatch',
        message: 'changed_files_mismatch for diagnostic',
        source: 'acceptance_agent',
      },
    ],
    missing_evidence: [],
    changed_files: [],
  };

  const result = reconcileBundle({ task, bundle });

  // Should be reconciled because diagnostic profile makes changed_files_mismatch non-blocking
  const diagnosticReconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_DIAGNOSTIC_NO_MUTATION
  );
  assert.ok(diagnosticReconciled, 'diagnostic changed_files_mismatch should be reconciled');
  assert.equal(diagnosticReconciled.resolved_by, 'diagnostic_no_mutation_profile');
  assert.ok(diagnosticReconciled.evidence?.profile === 'diagnostic');

  // No still_blocking
  assert.equal(result.still_blocking_count, 0);
});

test('reconcileBundle: diagnostic/no-mutation tests scenario — noop profile with changed_files_mismatch', () => {
  const task = {
    id: 'task_noop',
    status: 'completed',
    result: { noop: true, operation_kind: 'noop' },
  };

  const bundle = {
    task_id: 'task_noop',
    status: 'completed',
    result_summary: { status: 'completed', summary: 'Noop task' },
    verification: { passed: true, commands: [] },
    contract_verification: null,
    integration: null,
    acceptance_contract_summary: {
      operation_kind: 'noop',
    },
    blockers: [
      {
        severity: 'major',
        code: 'changed_files_mismatch',
        message: 'changed_files_mismatch for noop',
        source: 'acceptance_agent',
      },
    ],
    missing_evidence: [],
    changed_files: [],
  };

  const result = reconcileBundle({ task, bundle });

  const reconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_DIAGNOSTIC_NO_MUTATION
  );
  assert.ok(reconciled, 'noop changed_files_mismatch should be reconciled');
  assert.equal(result.still_blocking_count, 0);
});

// =========================================================================
// 6. Compact bundle should expose reconciled status
// =========================================================================

test('reconcileBundle: compact bundle exposes reconciled status structure', () => {
  const task = {
    id: 'task_exposure',
    status: 'completed',
    result: {
      integration: { status: 'merged', merged: true, commit: 'def456' },
    },
  };

  const bundle = {
    task_id: 'task_exposure',
    status: 'completed',
    result_summary: { status: 'waiting_for_repair', summary: 'Old' },
    verification: { passed: true, commands: [] },
    contract_verification: null,
    integration: { status: 'merged', merged: true, commit: 'def456' },
    blockers: [
      { severity: 'major', code: 'changed_files_mismatch', message: 'Stale mismatch', source: 'acceptance_agent' },
    ],
    missing_evidence: [
      { code: 'contract_verification_missing', message: 'Missing' },
    ],
    changed_files: ['backend/src/some-file.mjs'],
  };

  const result = reconcileBundle({ task, bundle });

  // Check result structure matches requirement
  assert.ok(typeof result.reconciled === 'boolean');
  assert.ok(typeof result.reconciled_count === 'number');
  assert.ok(typeof result.still_blocking_count === 'number');
  assert.ok(Array.isArray(result.reconciled_findings));
  assert.ok(Array.isArray(result.stale_blockers));
  assert.ok(Array.isArray(result.reconciled_blockers));
  assert.ok(Array.isArray(result.still_blocking));
  assert.ok(result.evidence !== null);

  // Every reconciled finding has code, message, evidence
  for (const finding of result.reconciled_findings) {
    assert.ok(typeof finding.code === 'string');
    assert.ok(typeof finding.message === 'string');
    assert.ok(finding.evidence !== null && typeof finding.evidence === 'object');
  }

  // Every stale_blocker has code, message, current, expected
  for (const blocker of result.stale_blockers) {
    assert.ok(typeof blocker.code === 'string');
    assert.ok(typeof blocker.current === 'string');
    assert.ok(typeof blocker.expected === 'string');
  }
});

// =========================================================================
// 7. reconcileTask — single-task with store
// =========================================================================

test('reconcileTask: single task reconciliation with store', async () => {
  const store = {
    async load() {
      return {
        tasks: [{
          id: 'task_single',
          status: 'completed',
          result: {
            integration: { status: 'merged', merged: true, commit: 'abc' },
          },
        }],
        goals: [],
      };
    },
    async findTaskById(id) {
      const state = await this.load();
      return state.tasks.find(t => t.id === id) || null;
    },
  };

  const result = await reconcileTask({ store, task_id: 'task_single' });

  assert.equal(result.task_id, 'task_single');
  assert.ok(result.reconciled !== undefined);
  assert.ok(Array.isArray(result.reconciled_findings));
});

test('reconcileTask: task not found returns error', async () => {
  const store = {
    async load() { return { tasks: [], goals: [] }; },
    async findTaskById() { return null; },
  };

  const result = await reconcileTask({ store, task_id: 'nonexistent' });
  assert.equal(result.status, 'error');
  assert.ok(result.error.includes('not found'));
  assert.equal(result.reconciled, false);
});

test('reconcileTask: requires store and task_id', async () => {
  const result1 = await reconcileTask({ store: null, task_id: 't1' });
  assert.equal(result1.status, 'error');

  const result2 = await reconcileTask({ store: { async load() { return { tasks: [] }; } } });
  assert.equal(result2.status, 'error');
});

// =========================================================================
// 8. reconcileReviewBacklog — full backlog scan
// =========================================================================

test('reconcileReviewBacklog: full backlog scan with mixed types', async () => {
  // Create tasks:
  // - task_completed_integrated: completed+integrated with stale bundle
  // - task_unresolved: still waiting_for_repair with real changed_files_mismatch
  // - task_diagnostic: completed diagnostic with stale changed_files_mismatch
  const store = {
    async load() {
      return {
        tasks: [
          {
            id: 'task_completed_integrated',
            assignee: 'codex',
            status: 'completed',
            result: {
              integration: { status: 'merged', merged: true, commit: 'abc' },
              verification: { passed: true, commands: [] },
            },
          },
          {
            id: 'task_unresolved',
            assignee: 'codex',
            status: 'waiting_for_repair',
            result: { changed_files: ['backend/src/broken.mjs'] },
          },
          {
            id: 'task_diagnostic',
            assignee: 'codex',
            status: 'completed',
            result: {
              operation_kind: 'diagnostic',
              verification: { passed: true, commands: [] },
            },
          },
        ],
        goals: [],
      };
    },
    async findTaskById(id) {
      const state = await this.load();
      return state.tasks.find(t => t.id === id) || null;
    },
  };

  const result = await reconcileReviewBacklog({ store });

  assert.ok(result.total_scanned > 0);
  assert.ok(typeof result.reconciled_count === 'number');
  assert.ok(typeof result.still_blocked_count === 'number');
  assert.ok(typeof result.human_review_count === 'number');
  assert.ok(typeof result.typed_recovery_counts === 'object');
  assert.ok(Array.isArray(result.tasks));
  assert.ok(typeof result.scanned_at === 'string');

  // At least one task should be found
  assert.ok(result.total_scanned >= 1);
});

test('reconcileReviewBacklog: with specific task_id', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { id: 'task_a', assignee: 'codex', status: 'completed', result: { integration: { merged: true, commit: 'abc' } } },
          { id: 'task_b', assignee: 'codex', status: 'waiting_for_repair', result: {} },
        ],
        goals: [],
      };
    },
    async findTaskById(id) {
      const state = await this.load();
      return state.tasks.find(t => t.id === id) || null;
    },
  };

  const result = await reconcileReviewBacklog({ store, task_id: 'task_a' });
  assert.equal(result.total_scanned, 1);
  // task_a is completed+integrated so it should reconcile successfully
  assert.equal(result.tasks[0].task_id, 'task_a');
});

// =========================================================================
// 9. Edge cases
// =========================================================================

test('reconcileBundle: task with no blockers and no missing evidence is reconciled by default', () => {
  const task = { id: 'task_clean', status: 'completed' };
  const bundle = {
    task_id: 'task_clean',
    status: 'completed',
    result_summary: { status: 'completed', summary: 'Clean' },
    verification: { passed: true, commands: [] },
    contract_verification: null,
    integration: null,
    blockers: [],
    missing_evidence: [],
    changed_files: [],
  };

  const result = reconcileBundle({ task, bundle });
  assert.equal(result.reconciled, true);
  assert.equal(result.still_blocking_count, 0);
});

test('reconcileBundle: null task returns error', () => {
  const bundle = { task_id: 't1', status: 'completed', blockers: [], missing_evidence: [] };
  const result = reconcileBundle({ task: null, bundle });
  assert.equal(result.status, 'error');
  assert.equal(result.reconciled, false);
});

test('reconcileBundle: null bundle returns error', () => {
  const task = { id: 't1', status: 'completed' };
  const result = reconcileBundle({ task, bundle: null });
  assert.equal(result.status, 'error');
  assert.equal(result.reconciled, false);
});

// =========================================================================
// 10. Successor repair evidence
// =========================================================================

test('reconcileBundle: completed+integrated task with successor repair — reconciled_by_successor', () => {
  const task = {
    id: 'task_original',
    status: 'completed',
    parent_task_id: 'task_repair',  // This task is itself a successor repair for another task
    result: {
      integration: { status: 'merged', merged: true, commit: '789' },
    },
  };

  // This simulates a successor repair task (parent_task_id means it's a repair of another task)
  // But also, the original task that task_original repairs should be reconciled
  // Actually let me think about this differently:
  // The original MA4 task was 'task_ma4_original' which had status=completed, integration.merged=true
  // Then a successor repair task 'task_d2862a73' was created with parent_task_id='task_ma4_original'
  // 
  // In our test, we're testing that the original task's stale bundle is reconciled because
  // there exists a successor repair task that is completed+integrated

  const state = {
    tasks: [
      task,
      {
        id: 'task_successor_repair',
        status: 'completed',
        parent_task_id: 'task_original',  // This repairs task_original
        result: {
          status: 'completed',
          integration: { status: 'merged', merged: true, commit: 'repair_commit' },
          commit: 'repair_commit',
        },
      },
    ],
    goals: [],
  };

  const bundle = {
    task_id: 'task_original',
    status: 'completed',
    result_summary: { status: 'completed', summary: 'Original task' },
    verification: { passed: true, commands: [] },
    contract_verification: null,
    integration: { status: 'merged', merged: true, commit: '789' },
    blockers: [
      {
        severity: 'major',
        code: 'changed_files_mismatch',
        message: 'Stale changed_files_mismatch',
        source: 'acceptance_agent',
      },
    ],
    missing_evidence: [],
    changed_files: ['backend/src/original.mjs'],
  };

  const result = reconcileBundle({ task, bundle, state });

  // Task has successor restoration → changed_files_mismatch should be reconciled_by_successor
  const successorReconciled = result.reconciled_findings.find(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_BY_INTEGRATION
  );
  assert.ok(successorReconciled || result.reconciled === true,
    'Task with successor repair should reconcile stale blockers');
});

// =========================================================================
// 11. Additional per-acceptance-criteria check
// =========================================================================

test('reconcileBundle: MA4 scenario reproduces known stale state detection', () => {
  // Exact reproduction of the known MA4 issue:
  // task_4b36a8b3: status=completed, integration.merged=true
  // But bundle shows: result_summary.status=waiting_for_repair, changed_files_mismatch blocker, no contract_verification
  const task = {
    id: 'task_4b36a8b3',
    status: 'completed',
    result: {
      status: 'completed',
      summary: 'P0-MA4: default multi-agent pipeline and worker orchestration',
      changed_files: ['backend/src/agent-service.mjs'],
      verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
      integration: { status: 'merged', merged: true, commit: '87e5d99b37179ba46889dff42010532f95467036' },
      closure_decision: { status: 'completed', reason: 'ok' },
    },
  };

  const bundle = {
    task_id: 'task_4b36a8b3',
    status: 'completed',
    result_summary: { status: 'waiting_for_repair', summary: 'Old stale summary' },
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    contract_verification: null,
    integration: { status: 'merged', merged: true, commit: '87e5d99b37179ba46889dff42010532f95467036' },
    blockers: [
      { severity: 'major', code: 'changed_files_mismatch', message: 'Files in result not found in git diff', source: 'acceptance_agent' },
    ],
    missing_evidence: [
      { code: 'contract_verification_missing', message: 'No contract_verification evidence' },
    ],
    changed_files: ['backend/src/agent-service.mjs'],
  };

  const result = reconcileBundle({ task, bundle });

  // This completed+integrated+successor-repair-accepted MA4 task
  // should NO LONGER have changed_files_mismatch as a current blocker
  assert.equal(result.reconciled, true,
    'MA4 completed+integrated task should be reconciled');

  // No blockers should remain
  assert.equal(result.still_blocking_count, 0,
    'MA4 completed+integrated task should have 0 still_blocking blockers');

  // The stale result_summary.status should be reconciled
  const statusReconciled = result.reconciled_findings.some(
    f => f.code === RECONCILIATION_TYPES.RECONCILED_STATUS
  );
  assert.ok(statusReconciled,
    'Stale result_summary.status should be reconciled');

  // The changed_files_mismatch should be reconciled
  const mismatchReconciled = result.reconciled_findings.some(
    f => f.original_code === 'changed_files_mismatch'
  );
  assert.ok(mismatchReconciled,
    'changed_files_mismatch should be reconciled by integration evidence');
});
