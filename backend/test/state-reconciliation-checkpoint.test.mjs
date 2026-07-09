import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateReconciliationCheckpoint } from '../src/state-reconciliation-checkpoint.mjs';

test('canonical_dirty produces blocked-with-next-action replan without destructive cleanup', () => {
  const snapshot = buildStateReconciliationCheckpoint({
    task: { id: 'task_dirty', goal_id: 'goal_dirty', status: 'waiting_for_repair' },
    recoveryEvidence: {
      reason: 'canonical_dirty',
      canonical_clean_before: false,
      canonical_dirty_classification: {
        by_source: {
          modified: ['backend/src/task-finalizer.mjs', 'docs/codex-tui-mode.md'],
        },
      },
    },
  });

  assert.equal(snapshot.schema, 'gptwork.state_reconciliation_checkpoint.v1');
  assert.equal(snapshot.primary_signal, 'canonical_dirty');
  assert.equal(snapshot.verdict, 'blocked-with-next-action');
  assert.equal(snapshot.decision, 'replan');
  assert.equal(snapshot.next_action, 'attribute_dirty_paths_before_repair');
  assert.equal(snapshot.guardrails.do_not_force_clear_locks, true);
  assert.equal(snapshot.guardrails.do_not_overwrite_dirty_worktree, true);
  assert.ok(snapshot.required_evidence.includes('dirty path attribution'));
  assert.deepEqual(snapshot.state.changed_files, ['backend/src/task-finalizer.mjs', 'docs/codex-tui-mode.md']);
});

test('result_missing/no-op converts to evidence collection instead of blind retry', () => {
  const snapshot = buildStateReconciliationCheckpoint({
    task: { id: 'task_noop', goal_id: 'goal_noop', status: 'waiting_for_repair' },
    taskResult: { failure_class: 'result_missing', changed_files: [] },
    retainedWorktrees: ['/tmp/worktrees/task_noop'],
  });

  assert.equal(snapshot.primary_signal, 'result_missing');
  assert.equal(snapshot.verdict, 'blocked-with-next-action');
  assert.equal(snapshot.decision, 'replan');
  assert.equal(snapshot.next_action, 'collect_result_and_acceptance_evidence');
  assert.ok(snapshot.required_evidence.includes('retained worktree inspection'));
  assert.deepEqual(snapshot.state.retained_worktrees, ['/tmp/worktrees/task_noop']);
});

test('active lock or running worker appends requirements without抢占', () => {
  const snapshot = buildStateReconciliationCheckpoint({
    task: { id: 'task_running', status: 'running' },
    locks: { active_count: 1 },
    worker: { status: 'running' },
  });

  assert.equal(snapshot.primary_signal, 'active_lock_or_running_worker');
  assert.equal(snapshot.verdict, 'partial');
  assert.equal(snapshot.decision, 'continue');
  assert.equal(snapshot.next_action, 'append_requirements_to_current_task');
  assert.ok(snapshot.required_evidence.includes('current task/workflow log append'));
  assert.equal(snapshot.state.active_lock_or_running_worker, true);
});

test('waiting_for_review defaults to GPTChat continue with guardrails', () => {
  const snapshot = buildStateReconciliationCheckpoint({
    task: { id: 'task_review', status: 'waiting_for_review' },
    taskResult: {
      changed_files: ['backend/src/foo.mjs'],
      result_json_path: '.gptwork/tasks/task_review/result.json',
    },
  });

  assert.equal(snapshot.primary_signal, 'waiting_for_review');
  assert.equal(snapshot.verdict, 'partial');
  assert.equal(snapshot.decision, 'continue');
  assert.equal(snapshot.next_action, 'gptchat_default_continue_with_guardrails');
  assert.ok(snapshot.state.evidence_paths.includes('.gptwork/tasks/task_review/result.json'));
});
