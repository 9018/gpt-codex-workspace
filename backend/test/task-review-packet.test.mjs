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
        verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0, stdout_tail: 'tool output'.repeat(200) }] },
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
    'task_id', 'goal_id', 'title', 'status', 'canonical_outcome', 'context_bundle_health', 'task_status', 'reason_for_review', 'compact_git_summary',
    'changed_files', 'reconciliation', 'reconciled_evidence', 'key_evidence', 'blocking_findings', 'non_blocking_followups',
    'recommended_next_action', 'missing_evidence', 'agent_backends', 'pipeline_gate',
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
  assert.equal(packet.canonical_outcome, null, 'running task has no canonical outcome');
  assert.equal(packet.context_bundle_health.health, 'stale', 'running task bundle is stale');
  assert.equal(packet.recommended_next_action.action, 'wait_for_result');
  assert.ok(packet.missing_evidence.some((item) => item.code === 'result_missing'));
  assert.ok(packet.missing_evidence.some((item) => item.code === 'verification_missing'));
});

test('getTaskReviewPacket reflects canonical outcome when unified_decision is present', async () => {
  const state = {
    tasks: [{
      id: 'task_canonical',
      goal_id: 'goal_canonical',
      title: 'Canonical outcome test',
      status: 'completed',
      result: {
        status: 'completed',
        summary: 'Task with canonical outcome',
        changed_files: ['src/test.mjs'],
        verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
        contract_verification: {
          acceptance_status: 'satisfied',
          blocking_passed: true,
          completion_eligible: true,
          blockers: [],
          non_blocking_followups: [],
          quality_notes: [],
        },
        closure_decision: { status: 'completed', reason: 'All checks passed' },
        unified_decision: {
          status: 'completed',
          reason: 'Canonical outcome: all checks passed',
          blocking_passed: true,
          requires_review: false,
          source: 'finalizer',
          profile: 'code_change',
          safe_to_auto_advance: true,
          normalized_at: '2026-07-07T00:00:00.000Z',
        },
      },
    }],
    goals: [{ id: 'goal_canonical', task_id: 'task_canonical', title: 'Canonical goal', status: 'completed' }],
  };

  const packet = await getTaskReviewPacket({ store: makeStore(state), config: {}, task_id: 'task_canonical' });

  assert.ok(packet.canonical_outcome, 'canonical_outcome should be present');
  assert.equal(packet.canonical_outcome.status, 'completed');
  assert.equal(packet.canonical_outcome.reason, 'Canonical outcome: all checks passed');
  assert.equal(packet.canonical_outcome.blocking_passed, true);
  assert.equal(packet.canonical_outcome.requires_review, false);
  assert.equal(packet.canonical_outcome.source, 'finalizer');
  assert.equal(packet.canonical_outcome.safe_to_auto_advance, true);
  assert.equal(packet.canonical_outcome.profile, 'code_change');

  assert.equal(packet.context_bundle_health.health, 'degraded', 'completed task without report paths has degraded bundle');
  assert.equal(packet.context_bundle_health.has_unified_decision, true);
  assert.equal(packet.context_bundle_health.has_verification, true);
  assert.equal(packet.context_bundle_health.has_result, true);
  // report_paths are empty for in-memory-only test, so missing_evidence_count > 0
  assert.equal(packet.context_bundle_health.missing_evidence_count, 1);

  assert.equal(packet.key_evidence.unified_decision.status, 'completed');
  assert.equal(packet.key_evidence.closure_decision.status, 'completed');
  assert.equal(packet.key_evidence.verification.passed, true);

  // Canonical outcome is the primary status; task_status is supporting
  assert.equal(packet.status, 'completed');
  assert.equal(packet.task_status, 'completed');
});
