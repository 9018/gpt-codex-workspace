import test from 'node:test';
import assert from 'node:assert/strict';

import { getTaskReviewPacket } from '../src/review/review-packet-builder.mjs';

function makeStore(state) {
  return {
    async load() { return state; },
    async findTaskById(id) { return state.tasks.find((task) => task.id === id) || null; },
    findGoalByTaskId(taskId) { return state.goals.find((goal) => goal.task_id === taskId) || null; },
  };
}

test('getTaskReviewPacket returns safe minimal review fields and recommended action', async () => {
  const state = {
    tasks: [{
      id: 'task_review',
      goal_id: 'goal_review',
      title: 'Review compact packet',
      status: 'waiting_for_review',
      result: {
        summary: 'Implemented compact packet but contract needs review',
        changed_files: ['backend/src/review/review-packet-builder.mjs', 'backend/test/task-review-packet.test.mjs'],
        verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0, stdout_tail: 'tool output'.repeat(300) }] },
        contract_verification: {
          acceptance_status: 'indeterminate',
          blocking_passed: false,
          completion_eligible: false,
          blockers: [{ code: 'manual_review_required', message: 'Semantic ambiguity requires review', source: 'contract_verifier' }],
          non_blocking_followups: [{ code: 'docs_later', message: 'Document the new tool later' }],
          quality_notes: ['Keep output compact'],
        },
        closure_decision: { status: 'requires_review', reason: 'Contract verifier requested review' },
        compact_git_summary: { diff_stat: { files_changed: 2, insertions: 120, deletions: 0 } },
      },
      logs: [{ message: 'full transcript should not leak' }],
    }],
    goals: [{ id: 'goal_review', task_id: 'task_review', title: 'Goal title', status: 'open' }],
    conversations: [{ goal_id: 'goal_review', messages: [{ content: 'conversation transcript should not leak' }] }],
    memories: [{ goal_id: 'goal_review', key: 'memory', value: 'durable memory should not leak' }],
  };

  const packet = await getTaskReviewPacket({ store: makeStore(state), config: {}, task_id: 'task_review' });

  assert.deepEqual(Object.keys(packet), [
    'task_id', 'goal_id', 'title', 'status', 'task_status', 'reason_for_review', 'compact_git_summary',
    'changed_files', 'reconciliation', 'reconciled_evidence', 'key_evidence', 'blocking_findings', 'non_blocking_followups',
    'recommended_next_action', 'missing_evidence',
  ]);
  assert.equal(packet.reason_for_review, 'Contract verifier requested review');
  assert.equal(packet.recommended_next_action.action, 'review_blockers');
  assert.equal(packet.blocking_findings.length, 1);
  assert.equal(packet.key_evidence.verification.passed, true);
  assert.equal(packet.compact_git_summary.files_changed, 2);
  assert.deepEqual(packet.changed_files, ['backend/src/review/review-packet-builder.mjs', 'backend/test/task-review-packet.test.mjs']);

  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /full transcript/);
  assert.doesNotMatch(serialized, /conversation transcript/);
  assert.doesNotMatch(serialized, /durable memory/);
  assert.doesNotMatch(serialized, /tool outputtool output/);
  assert.ok(serialized.length < 6000, `packet should remain compact, got ${serialized.length}`);
});

test('getTaskReviewPacket recommends waiting and reports missing evidence for running task', async () => {
  const state = {
    tasks: [{ id: 'task_running_review', goal_id: 'goal_running_review', title: 'Running review', status: 'running' }],
    goals: [{ id: 'goal_running_review', task_id: 'task_running_review', title: 'Running goal', status: 'open' }],
  };

  const packet = await getTaskReviewPacket({ store: makeStore(state), config: {}, task_id: 'task_running_review' });

  assert.equal(packet.status, 'running');
  assert.equal(packet.recommended_next_action.action, 'wait_for_result');
  assert.ok(packet.missing_evidence.some((item) => item.code === 'result_missing'));
  assert.ok(packet.missing_evidence.some((item) => item.code === 'verification_missing'));
});
