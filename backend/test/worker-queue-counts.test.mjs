import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { collectWorkerQueueCounts, computePolicyQueueCounts } from '../src/worker-queue-counts.mjs';
import { StateStore } from '../src/state-store.mjs';

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

async function makeStateStore(prefix = 'worker-queue-cache-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return new StateStore({
    statePath: join(root, 'state.json'),
    defaultWorkspaceRoot: join(root, 'workspace'),
  });
}

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

test('collectWorkerQueueCounts reuses state-version derived cache and refreshes oldest ages', async () => {
  const store = await makeStateStore();
  const state = await store.load();
  state.tasks.push(
    { assignee: 'codex', status: 'waiting_for_review', id: 'task_review', result: { summary: 'Needs review' }, created_at: new Date(Date.now() - 30_000).toISOString() },
    { assignee: 'codex', status: 'waiting_for_repair', id: 'task_repair', result: { summary: 'Needs repair' } },
    { assignee: 'codex', status: 'failed', id: 'task_history', result: {} },
    { assignee: 'codex', status: 'completed', id: 'task_done', result: { verification: { passed: true } } },
  );
  await store.save();

  let buildCount = 0;
  const originalGetOrBuildDerived = store.getOrBuildDerived.bind(store);
  store.getOrBuildDerived = (key, builder) => originalGetOrBuildDerived(key, () => {
    buildCount += 1;
    return builder();
  });

  const first = await collectWorkerQueueCounts(store);
  const second = await collectWorkerQueueCounts(store);

  assert.equal(buildCount, 1, 'same state version should build worker queue derived data once');
  assert.equal(second.actionable_review, first.actionable_review);
  assert.equal(second.current_blockers, first.current_blockers);
  assert.equal(first.raw_counts.failed, 1, 'raw history remains visible');
  assert.equal(first.policy_counts.failed, 0, 'resolved legacy failed does not block current work');
  assert.equal(first.actionable_review, first.policy_counts.waiting_for_review, 'actionable review follows policy counts');
  assert.equal(first.current_blockers, 2, 'waiting_for_review and waiting_for_repair remain blockers');
  assert.ok(second.oldest_age_ms.waiting_for_review >= first.oldest_age_ms.waiting_for_review,
    'oldest ages are recomputed from cached timestamps using current time');
});

test('collectWorkerQueueCounts rebuilds derived cache after mutate invalidates state version', async () => {
  const store = await makeStateStore();
  await store.load();
  await store.mutate((state) => {
    state.tasks.push({ assignee: 'codex', status: 'queued', id: 'task_queued' });
  });

  let buildCount = 0;
  const originalGetOrBuildDerived = store.getOrBuildDerived.bind(store);
  store.getOrBuildDerived = (key, builder) => originalGetOrBuildDerived(key, () => {
    buildCount += 1;
    return builder();
  });

  assert.equal((await collectWorkerQueueCounts(store)).queued, 1);
  assert.equal((await collectWorkerQueueCounts(store)).queued, 1);
  assert.equal(buildCount, 1);

  await store.mutate((state) => {
    state.tasks[0].status = 'waiting_for_lock';
  });

  const afterMutation = await collectWorkerQueueCounts(store);
  assert.equal(buildCount, 2, 'state mutation should force a new derived build');
  assert.equal(afterMutation.queued, 0);
  assert.equal(afterMutation.waiting_for_lock, 1);
  assert.equal(afterMutation.current_blockers, 1);
});

test('collectWorkerQueueCounts cache smoke avoids repeated heavy builds for large queues', async () => {
  const store = await makeStateStore();
  await store.load();
  await store.mutate((state) => {
    state.tasks.push(...Array.from({ length: 3000 }, (_, index) => ({
      assignee: 'codex',
      status: index % 3 === 0 ? 'queued' : index % 3 === 1 ? 'waiting_for_repair' : 'completed',
      id: `task_bulk_${index}`,
      result: index % 3 === 2 ? { verification: { passed: true } } : { summary: 'queued' },
    })));
  });

  let buildCount = 0;
  const originalGetOrBuildDerived = store.getOrBuildDerived.bind(store);
  store.getOrBuildDerived = (key, builder) => originalGetOrBuildDerived(key, () => {
    buildCount += 1;
    return builder();
  });

  for (let i = 0; i < 8; i += 1) {
    const counts = await collectWorkerQueueCounts(store);
    assert.equal(counts.queued, 1000);
    assert.equal(counts.waiting_for_repair, 1000);
    assert.equal(counts.completed, 1000);
  }
  assert.equal(buildCount, 1, 'large queue repeated reads should reuse one derived build');

  await store.mutate((state) => {
    state.tasks[0].status = 'waiting_for_lock';
  });
  const afterMutation = await collectWorkerQueueCounts(store);
  assert.equal(buildCount, 2, 'large queue derived cache should rebuild once after mutation');
  assert.equal(afterMutation.waiting_for_lock, 1);
  assert.equal(afterMutation.queued, 999);
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
    raw_legacy_resolved: 0,
    raw_unresolved: 0,
    policy_excluded: 0,
    policy_excluded_count: 0,
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

test('P0-MA11-R8: runtime_status queue counts reflect externally-mutated state file without restart', async () => {
  // Regression: after an external process writes state.json (e.g. another
  // Codex process converged a waiting_for_review task to completed),
  // collectWorkerQueueCounts must return the updated counts without a
  // process restart.  The fix tracks state file mtime and reloads from
  // disk when mtime changes.
  const store = await makeStateStore('r8-external-mutate-');
  await store.load();

  // Seed state with one waiting_for_review task (current_blockers=1)
  await store.mutate((state) => {
    state.tasks.push({
      assignee: 'codex',
      status: 'waiting_for_review',
      id: 'task_r8_review',
      result: { summary: 'Needs review' },
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
  });

  // Verify initial queue counts from in-process state
  let before = await collectWorkerQueueCounts(store);
  assert.equal(before.waiting_for_review, 1);
  assert.equal(before.current_blockers, 1);
  assert.equal(before.actionable_review, 1);

  // Simulate an external mutation: write state.json directly, changing the
  // waiting_for_review task to completed with convergence evidence.
  // This mimics what applyDeterministicConvergence does in another process.
  const externalState = JSON.parse(JSON.stringify(store.state));
  const task = externalState.tasks.find(t => t.id === 'task_r8_review');
  assert.ok(task, 'seed task must exist');
  task.status = 'completed';
  task.updated_at = new Date().toISOString();
  task.ma11_convergence = { r6_converged: true, r6_reason: 'Regression test: deterministic convergence' };
  task.result.verification = { passed: true };

  // Write externally (simulate another process doing this)
  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.statePath, JSON.stringify(externalState, null, 2), 'utf8');

  // Now call collectWorkerQueueCounts - the mtime check in load() should
  // detect the external change, reload state, rebuild indexes, and return
  // current_blockers=0 without any restart.
  const after = await collectWorkerQueueCounts(store);
  assert.equal(after.completed, 1, 'converged task should be counted as completed');
  assert.equal(after.waiting_for_review, 0, 'no more waiting_for_review after external convergence');
  assert.equal(after.actionable_review, 0, 'actionable_review should drop to 0');
  assert.equal(after.current_blockers, 0, 'current_blockers should drop from 1 to 0 without restart');

  // Verify the state file was reloaded (store.state has the updated task)
  const loadedTask = store.state.tasks.find(t => t.id === 'task_r8_review');
  assert.equal(loadedTask?.status, 'completed', 'in-memory state should match file after external mutation');
});



test('P0-MA11-R8: external reload uses file fingerprint, not strict mtime increase', async () => {
  const store = await makeStateStore('r8-fingerprint-mutate-');
  await store.load();
  await store.mutate((state) => {
    state.tasks.push({
      assignee: 'codex',
      status: 'waiting_for_review',
      id: 'task_r8_fingerprint_review',
      result: { summary: 'Needs review' },
      created_at: new Date(Date.now() - 30_000).toISOString(),
    });
  });
  const before = await collectWorkerQueueCounts(store);
  assert.equal(before.current_blockers, 1);

  const externalState = JSON.parse(JSON.stringify(store.state));
  const task = externalState.tasks.find(t => t.id === 'task_r8_fingerprint_review');
  task.status = 'completed';
  task.result.verification = { passed: true };
  task.updated_at = new Date().toISOString();

  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.statePath, JSON.stringify(externalState, null, 2), 'utf8');
  const writtenStat = await stat(store.statePath);

  // Simulate a runtime cache whose recorded mtime is not lower than the new
  // file mtime.  The old `mtime > cachedMtime` check missed this; the fixed
  // code reloads when the file fingerprint differs at all.
  store._stateMtime = writtenStat.mtimeMs + 60_000;
  store._stateSize = writtenStat.size;

  const after = await collectWorkerQueueCounts(store);
  assert.equal(after.completed, 1);
  assert.equal(after.waiting_for_review, 0);
  assert.equal(after.current_blockers, 0);
  assert.equal(store.state.tasks.find(t => t.id === 'task_r8_fingerprint_review')?.status, 'completed');
});

test('P0-MA11-R8: runtime_status queue counts stay current after in-process mutate', async () => {
  // Sanity-check that in-process mutations (via store.save/store.mutate)
  // still update state version and invalidate the derived cache correctly.
  const store = await makeStateStore('r8-inprocess-mutate-');
  await store.load();

  await store.mutate((state) => {
    state.tasks.push({
      assignee: 'codex',
      status: 'waiting_for_review',
      id: 'task_inprocess_review',
      result: { summary: 'Needs review' },
      created_at: new Date().toISOString(),
    });
  });

  let counts = await collectWorkerQueueCounts(store);
  assert.equal(counts.waiting_for_review, 1);
  assert.equal(counts.current_blockers, 1);
  assert.equal(counts.actionable_review, 1);

  // In-process mutation — converge the task
  await store.mutate((state) => {
    const t = state.tasks.find(t => t.id === 'task_inprocess_review');
    if (t) {
      t.status = 'completed';
      t.updated_at = new Date().toISOString();
      t.result.verification = { passed: true };
    }
  });

  counts = await collectWorkerQueueCounts(store);
  assert.equal(counts.completed, 1);
  assert.equal(counts.waiting_for_review, 0);
  assert.equal(counts.actionable_review, 0);
  assert.equal(counts.current_blockers, 0);
});
