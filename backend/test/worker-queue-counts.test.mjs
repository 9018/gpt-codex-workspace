import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { collectWorkerQueueCounts, computePolicyQueueCounts } from '../src/worker-queue-counts.mjs';

const WORKER_QUEUE_COUNTS_SOURCE = fileURLToPath(new URL('../src/worker-queue-counts.mjs', import.meta.url));

const ZERO_AGES = {
  assigned: 0,
  queued: 0,
  running: 0,
  waiting_for_integration: 0,
  waiting_for_lock: 0,
  waiting_for_repair: 0,
  waiting_for_review: 0,
  completed: 0,
  failed: 0,
};

test('worker queue counts derives status taxonomy from task-status-taxonomy module', async () => {
  const source = await readFile(WORKER_QUEUE_COUNTS_SOURCE, 'utf8');
  assert.match(source, /from ['"]\.\/task-status-taxonomy\.mjs['"]/);
  assert.doesNotMatch(source, /COUNTED_STATUSES\s*=\s*new Set\(Object\.keys\(EMPTY_QUEUE_COUNTS\)\)/);
});

test('worker queue counts delegates current-work decisions to current-blocker-policy', async () => {
  const source = await readFile(WORKER_QUEUE_COUNTS_SOURCE, 'utf8');
  assert.match(source, /classifyCurrentBlockerTask/);
  assert.match(source, /from ['"]\.\/current-blocker-policy\.mjs['"]/);
});

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
          { assignee: 'codex', status: 'waiting_for_repair' },
          { assignee: 'codex', status: 'completed' },
          { assignee: 'codex', status: 'failed', id: 'task_code_failed', result: { changed_files: ['backend/src/example.mjs'] } },
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
  assert.equal(result.waiting_for_repair, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.actionable_review, 1);
  assert.equal(result.current_blockers, 4);
  assert.deepEqual(result.raw_counts.waiting_for_repair, 1);
  assert.deepEqual(result.policy_counts.waiting_for_repair, 1);
  assert.ok(result.oldest_age_ms.assigned >= 0);
});

test('collectWorkerQueueCounts separates raw indexed review counts from policy blockers', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'waiting_for_review', id: 'task_resolved_review', result: { resolved_by_task_id: 'task_done' } },
          { assignee: 'codex', status: 'waiting_for_repair', id: 'task_repair', result: { summary: 'Needs repair' } },
          { assignee: 'codex', status: 'completed', id: 'task_done', result: { verification: { passed: true } } },
        ],
      };
    },
    getCodexTaskQueue() {
      return { counts: { waiting_for_review: 2, waiting_for_repair: 1, completed: 1 } };
    },
  };

  const result = await collectWorkerQueueCounts(store);

  assert.equal(result.raw_counts.waiting_for_review, 2);
  assert.equal(result.policy_counts.waiting_for_review, 0);
  assert.equal(result.waiting_for_review, 0, 'legacy fields follow policy counts for blockers');
  assert.equal(result.waiting_for_repair, 1);
  assert.equal(result.actionable_review, 0);
  assert.equal(result.current_blockers, 1);
});

test('collectWorkerQueueCounts returns zero counts when load fails', async () => {
  const store = { async load() { throw new Error('boom'); } };
  assert.deepEqual(await collectWorkerQueueCounts(store), {
    assigned: 0,
    queued: 0,
    running: 0,
    waiting_for_integration: 0,
    waiting_for_lock: 0,
    waiting_for_repair: 0,
    waiting_for_review: 0,
    completed: 0,
    failed: 0,
    raw_counts: ZERO_AGES,
    policy_counts: ZERO_AGES,
    actionable_review: 0,
    current_blockers: 0,
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

test('collectWorkerQueueCounts excludes resolved legacy failed tasks but keeps policy-active failed visible', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_old_resolved', result: { resolved_legacy: true } },
          { assignee: 'codex', status: 'failed', id: 'task_old_superseded', result: { superseded_by_task_id: 'task_successor' } },
          { assignee: 'codex', status: 'waiting_for_review', id: 'task_review_resolved', result: { resolved_by_task_id: 'task_successor' } },
          { assignee: 'codex', status: 'failed', id: 'task_real_failed', result: { changed_files: ['backend/src/example.mjs'] } },
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

test('legacyFailedPolicySummary shows active running with code-evidence failure as blocking', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          { assignee: 'codex', status: 'failed', id: 'task_failed_unresolved', result: { tests: 'node --test failed' } },
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

test('legacyFailedPolicySummary follows policy for fresh failed task without current-work evidence', async () => {
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
  assert.equal(result.failed, 0);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 0);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.blocks_current_work, false);
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
          { assignee: 'codex', status: 'failed', id: 'task_failed_no_rel', goal_id: 'goal_aaa', result: { changed_files: ['backend/src/no-rel.mjs'] } },
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

test('legacyFailedPolicySummary excludes codex timeout without code evidence from current blockers', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          {
            assignee: 'codex',
            status: 'timed_out',
            id: 'task_timeout_no_evidence',
            result: {
              kind: 'codex_timeout',
              summary: 'Codex execution timed out',
              changed_files: [],
              tests: null,
              commit: null,
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

test('legacyFailedPolicySummary excludes codex failed without code evidence from current blockers', async () => {
  const store = {
    async load() {
      return {
        tasks: [
          {
            assignee: 'codex',
            status: 'failed',
            id: 'task_codex_failed_no_evidence',
            result: {
              kind: 'codex_failed',
              summary: 'Codex execution failed (non-zero exit)',
              changed_files: [],
              tests: null,
              commit: null,
            },
          },
          {
            assignee: 'codex',
            status: 'failed',
            id: 'task_code_failure_still_blocks',
            result: {
              kind: 'codex_failed',
              summary: 'Codex execution failed (non-zero exit)',
              changed_files: ['backend/src/real-change.mjs'],
              tests: 'node --test failed',
              commit: null,
            },
          },
        ],
      };
    },
  };
  const result = await collectWorkerQueueCounts(store);
  assert.equal(result.failed, 1);
  assert.equal(result.legacy_failed_policy.resolved_legacy_failed, 1);
  assert.equal(result.legacy_failed_policy.unresolved_failed, 1);
  assert.equal(result.legacy_failed_policy.blocks_current_work, true);
});

test('computePolicyQueueCounts reuses indexes instead of scanning all tasks for each failed task', () => {
  const failedTasks = Array.from({ length: 1200 }, (_, index) => ({
    assignee: 'codex',
    status: 'failed',
    id: `task_failed_${index}`,
    root_task_id: `root_${index}`,
    goal_id: `goal_${index}`,
    result: {
      changed_files: [`backend/src/failure-${index}.mjs`],
      verification: { passed: false },
    },
  }));
  const completedSuccessors = Array.from({ length: 400 }, (_, index) => ({
    assignee: 'codex',
    status: 'completed',
    id: `task_successor_${index}`,
    root_task_id: `root_${index}`,
    goal_id: `goal_${index}`,
    result: { verification: { passed: true }, commit: `abc${index}` },
  }));
  const reviewTasks = Array.from({ length: 25 }, (_, index) => ({
    assignee: 'codex',
    status: 'waiting_for_review',
    id: `task_review_${index}`,
    result: { summary: 'Needs review' },
  }));
  const repairTasks = Array.from({ length: 10 }, (_, index) => ({
    assignee: 'codex',
    status: 'waiting_for_repair',
    id: `task_repair_${index}`,
    result: { summary: 'Needs repair' },
  }));
  const tasks = [
    ...failedTasks,
    ...completedSuccessors,
    ...reviewTasks,
    ...repairTasks,
    { assignee: 'human', status: 'failed', id: 'task_human_failed' },
  ];

  let topLevelIterations = 0;
  const originalIterator = tasks[Symbol.iterator];
  Object.defineProperty(tasks, Symbol.iterator, {
    configurable: true,
    value: function iteratorWithCounter(...args) {
      topLevelIterations += 1;
      return originalIterator.apply(this, args);
    },
  });

  try {
    const counts = computePolicyQueueCounts(tasks);
    assert.equal(counts.failed, 800);
    assert.equal(counts.completed, 400);
    assert.equal(counts.waiting_for_review, 25);
    assert.equal(counts.waiting_for_repair, 10);
    assert.ok(topLevelIterations <= 3, `expected a small fixed number of task scans, got ${topLevelIterations}`);
  } finally {
    Object.defineProperty(tasks, Symbol.iterator, {
      configurable: true,
      value: originalIterator,
    });
  }
});
