import test from 'node:test';
import assert from 'node:assert/strict';

import { collectWorkerQueueCounts } from '../src/worker-queue-counts.mjs';

const ZERO_AGES = {
  assigned: 0,
  queued: 0,
  running: 0,
  waiting_for_integration: 0,
  waiting_for_lock: 0,
  waiting_for_review: 0,
  completed: 0,
  failed: 0,
};

test('collectWorkerQueueCounts counts codex task statuses in one pass shape', async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'assigned', created_at: old },
          { assignee: 'codex', status: 'queued' },
          { assignee: 'codex', status: 'running' },
          { assignee: 'codex', status: 'waiting_for_lock' },
          { assignee: 'codex', status: 'waiting_for_review' },
          { assignee: 'codex', status: 'completed' },
          { assignee: 'codex', status: 'failed', id: 'task_plain_failed', result: {} },
          { assignee: 'human', status: 'assigned' },
        ]
      };
    }
  };

  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.assigned, 1);
  assert.equal(result.queued, 1);
  assert.equal(result.running, 1);
  assert.equal(result.waiting_for_lock, 1);
  assert.equal(result.waiting_for_review, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.ok(result.oldest_age_ms.assigned >= 0);
});

test('collectWorkerQueueCounts returns zero counts when load fails', async () => {
  const store = { async load() { throw new Error('boom'); } };
  assert.deepEqual(await collectWorkerQueueCounts(store), {
    assigned: 0,
    queued: 0,
    running: 0,
    waiting_for_integration: 0,
    waiting_for_lock: 0,
    waiting_for_review: 0,
    completed: 0,
    failed: 0,
    actionable_review: 0,
    legacy_failed_policy: {
      policy: 'resolved_legacy_failed_excluded_from_current_blockers',
      resolved_legacy_failed: 0,
      unresolved_failed: 0,
      resolved_legacy_review: 0,
      blocks_current_work: false,
    },
    oldest_age_ms: ZERO_AGES,
  });
});

test('collectWorkerQueueCounts excludes resolved legacy failed tasks but keeps active failed visible', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_old_resolved', result: { resolved_legacy: true } },
          { assignee: 'codex', status: 'failed', id: 'task_old_superseded', result: { superseded_by_task_id: 'task_successor' } },
          { assignee: 'codex', status: 'waiting_for_review', id: 'task_review_resolved', result: { resolved_by_task_id: 'task_successor' } },
          { assignee: 'codex', status: 'failed', id: 'task_real_failed', result: {} },
          { assignee: 'codex', status: 'running', id: 'task_running' },
        ],
      };
    },
  };

  const result = await collectWorkerQueueCounts(store);

  assert.equal(result.failed, 1, 'only unresolved failed tasks count as current failed');
  assert.equal(result.running, 1, 'active running tasks remain visible');
  assert.equal(result.waiting_for_review, 0, 'resolved legacy review tasks are not actionable review');
  assert.deepEqual(result.legacy_failed_policy, {
    policy: 'resolved_legacy_failed_excluded_from_current_blockers',
    resolved_legacy_failed: 2,
    unresolved_failed: 1,
    resolved_legacy_review: 1,
    blocks_current_work: true,
  });
});

test('legacyFailedPolicySummary resolves historical failed via completed successor with same root', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_legacy', root_task_id: 'root_abc' },
          { assignee: 'codex', status: 'completed', id: 'task_successor', root_task_id: 'root_abc', result: { verification: { passed: true }, commit: 'abc123' } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
  assert.equal(result.failed, 0);
});

test('legacyFailedPolicySummary resolves timed_out with no result via completed successor', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'timed_out', id: 'task_timed_out', root_task_id: 'root_def' },
          { assignee: 'codex', status: 'completed', id: 'task_p0', root_task_id: 'root_def', result: { verification: { passed: true } } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
});

test('legacyFailedPolicySummary shows active running with unresolved failure as blocking', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_failed_unresolved', result: {} },
          { assignee: 'codex', status: 'running', id: 'task_running' },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 1);
  assert.equal(result.legacy_failed_policy.blocks_current_work, true);
  assert.equal(result.running, 1);
});

test('legacyFailedPolicySummary treats unresolved fresh failed with no superseding evidence as blocker', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_fresh_failed', result: {} },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 1);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, true);
});


test('legacyFailedPolicySummary resolves no-result no-op failures as legacy', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_no_result', result: null, result_id: 'none' },
          { assignee: 'codex', status: 'timed_out', id: 'task_no_result_timed_out', result: null, result_id: 'none' },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 2);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
  assert.equal(result.failed, 0);
});


test('legacyFailedPolicySummary resolves historical failed via same goal_id successor', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_legacy_goal', goal_id: 'goal_xyz' },
          { assignee: 'codex', status: 'completed', id: 'task_p0_goal', goal_id: 'goal_xyz', result: { verification: { passed: true } } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
});

test('legacyFailedPolicySummary resolves historical failed via successor result.repair reference', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_old_repair', result: {} },
          { assignee: 'codex', status: 'completed', id: 'task_repair_successor', result: { repair: { repair_of_task_id: 'task_old_repair' }, verification: { passed: true } } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
});

test('legacyFailedPolicySummary does not resolve historical failed with different goal_id', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_failed_no_rel', goal_id: 'goal_aaa', result: {} },
          { assignee: 'codex', status: 'completed', id: 'task_completed_diff', goal_id: 'goal_bbb', result: { verification: { passed: true } } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 1);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, true);
});

test('legacyFailedPolicySummary clean idle completed state does not block', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'completed', id: 'task_done', result: { verification: { passed: true } } },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
  assert.equal(result.completed, 1);
});

test('legacyFailedPolicySummary excludes provider result_missing noop failures from current blockers', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          {
            assignee: 'codex',
            status: 'failed',
            id: 'task_provider_noop',
            result: {
              kind: 'codex_failed',
              failure_class: 'result_missing',
              changed_files: [],
              tests: null,
              commit: null,
              noop: true,
              diagnostics: {
                detected_reason: 'No changed files, no tests, no commit, no structured summary',
              },
            },
          },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.failed, 0);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
});

test('legacyFailedPolicySummary still blocks real code failures in mixed provider-noop state', async () => {
  const providerFailures = Array.from({ length: 50 }, (_, index) => ({
    assignee: 'codex',
    status: 'failed',
    id: `task_provider_${index}`,
    result: {
      kind: 'codex_failed',
      failure_class: 'result_missing',
      changed_files: [],
      tests: null,
      commit: null,
      noop: true,
      diagnostics: {
        detected_reason: 'No changed files, no tests, no commit, no structured summary',
      },
    },
  }));

  const store = {
    async load() {
      return {
        tasks: [
          ...providerFailures,
          {
            assignee: 'codex',
            status: 'failed',
            id: 'task_real_code_failure',
            result: {
              changed_files: ['backend/src/example.mjs'],
              verification: { passed: false },
            },
          },
        ],
      };
    },
  };

  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.failed, 1);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 50);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 1);
  assert.equal(result.legacy_failed_policy.blocks_current_work, true);
});
