import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTaskAcceptanceBundle } from '../src/review/task-acceptance-bundle.mjs';
import { getTaskReviewPacket } from '../src/review/review-packet-builder.mjs';

function makeStore(state) {
  return {
    async load() { return state; },
    async findTaskById(id) { return state.tasks.find((task) => task.id === id) || null; },
    findGoalByTaskId(taskId) { return state.goals.find((goal) => goal.task_id === taskId) || null; },
  };
}

test('getTaskAcceptanceBundle returns compact acceptance evidence without full context payloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-review-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const goalDir = join(root, '.gptwork', 'goals', 'goal_bundle');
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, 'result.json'), JSON.stringify({
    status: 'completed',
    summary: 'Implemented compact review packets',
    changed_files: ['backend/src/review/task-acceptance-bundle.mjs'],
    verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0, stdout_tail: 'very long output'.repeat(200) }] },
    contract_verification: {
      acceptance_status: 'satisfied',
      blocking_passed: true,
      completion_eligible: true,
      blockers: [],
      non_blocking_followups: [{ code: 'docs_later', message: 'Document later' }],
      quality_notes: ['Consider a card view later'],
    },
    closure_decision: { status: 'auto_completed_with_followups', reason: 'Blocking requirements passed' },
    followups: ['Document later'],
  }), 'utf8');
  await writeFile(join(goalDir, 'acceptance.contract.json'), JSON.stringify({
    intent: { operation_kind: 'code_change', semantic_confidence: 'high' },
    requirements: { requires_commit: true, required_verification: ['npm run check:syntax'] },
    blocking_requirements: [{ id: 'compact_packet', description: 'Return compact packet' }],
  }), 'utf8');

  const state = {
    tasks: [{
      id: 'task_bundle',
      goal_id: 'goal_bundle',
      title: 'Compact review packet',
      status: 'completed',
      result: {
        summary: 'Task result summary from state',
        operation_kind: 'code_change',
        changed_files: ['backend/src/review/task-acceptance-bundle.mjs'],
        integration: { status: 'merged', commit: 'abc123' },
        evidence_paths: { events_jsonl: '.gptwork/goals/goal_bundle/events.jsonl' },
        verification: { passed: true, commands: [{ cmd: 'npm run check:syntax', exit_code: 0 }] },
        contract_verification: { acceptance_status: 'satisfied', blocking_passed: true, completion_eligible: true, blockers: [], non_blocking_followups: [], quality_notes: [] },
        closure_decision: { status: 'completed', reason: 'ok' },
      },
      logs: [{ message: 'internal transcript-like log should not appear' }],
    }],
    goals: [{ id: 'goal_bundle', task_id: 'task_bundle', title: 'Goal title', status: 'completed', acceptance_contract: null }],
    memories: [{ goal_id: 'goal_bundle', key: 'secret', value: 'durable memory should not appear' }],
    conversations: [{ goal_id: 'goal_bundle', messages: [{ content: 'full transcript should not appear' }] }],
  };

  const bundle = await getTaskAcceptanceBundle({ store: makeStore(state), config: { defaultWorkspaceRoot: root }, task_id: 'task_bundle' });

  assert.deepEqual(Object.keys(bundle), [
    'task_id', 'goal_id', 'title', 'status', 'operation_kind', 'acceptance_contract_summary',
    'result_summary', 'verification', 'contract_verification', 'no_change_repair_completion_summary',
    'unified_decision', 'closure_decision', 'integration', 'changed_files', 'report_paths', 'run_evidence', 'blockers', 'non_blocking_followups', 'quality_notes', 'missing_evidence',
  ]);
  assert.equal(bundle.operation_kind, 'code_change');
  assert.equal(bundle.acceptance_contract_summary.operation_kind, 'code_change');
  assert.equal(bundle.result_summary.summary, 'Task result summary from state');
  assert.equal(bundle.verification.passed, true);
  assert.equal(bundle.contract_verification.acceptance_status, 'satisfied');
  assert.deepEqual(bundle.changed_files, ['backend/src/review/task-acceptance-bundle.mjs']);
  assert.equal(bundle.run_evidence.events_jsonl, '.gptwork/goals/goal_bundle/events.jsonl');
  assert.equal(bundle.report_paths.events_jsonl, '.gptwork/goals/goal_bundle/events.jsonl');
  assert.deepEqual(bundle.missing_evidence, []);

  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /full transcript/);
  assert.doesNotMatch(serialized, /durable memory/);
  assert.doesNotMatch(serialized, /context\.bundle/);
  assert.ok(serialized.length < 8000, `bundle should remain compact, got ${serialized.length}`);
});

test('getTaskAcceptanceBundle and review packet surface no-change repair evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-review-no-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = {
    tasks: [{
      id: 'task_78ee_like',
      goal_id: 'goal_78ee_like',
      title: 'Repair: P0 auto convergence routing',
      status: 'completed',
      repair_of_task_id: 'task_original',
      result: {
        status: 'completed',
        summary: 'Original changes already integrated into main; affected files match main exactly; tests pass.',
        changed_files: [],
        verification: { passed: true, commands: [{ cmd: 'npm --prefix backend run check:syntax', exit_code: 0 }] },
        reviewer_decision: { status: 'accepted', passed: true },
        contract_verification: { acceptance_status: 'satisfied', blocking_passed: true, completion_eligible: true, requires_review: false, blockers: [] },
        integration: { status: 'not_required', required: false },
        no_change_repair_completion_summary: {
          kind: 'already_integrated',
          completion_eligible: true,
          reason: 'no_change_repair_evidence_satisfied',
          changed_files_empty_acceptable: true,
          explanation: 'changed_files=[] is acceptable for this repair because existing canonical state satisfies the target.',
          evidence: {
            affected_files: ['backend/src/goal-convergence.mjs'],
            files_match_canonical: true,
            commit_reachable: true,
            diff_empty: true,
            verification_passed: true,
            acceptance_passed: true,
            integration_satisfied: true,
          },
          blockers: [],
        },
      },
      logs: [],
    }],
    goals: [{ id: 'goal_78ee_like', task_id: 'task_78ee_like', title: 'Repair goal', status: 'completed' }],
  };

  const store = makeStore(state);
  const bundle = await getTaskAcceptanceBundle({ store, config: { defaultWorkspaceRoot: root }, task_id: 'task_78ee_like' });
  const packet = await getTaskReviewPacket({ store, config: { defaultWorkspaceRoot: root }, task_id: 'task_78ee_like' });

  assert.equal(bundle.no_change_repair_completion_summary.completion_eligible, true);
  assert.equal(bundle.no_change_repair_completion_summary.changed_files_empty_acceptable, true);
  assert.deepEqual(bundle.no_change_repair_completion_summary.affected_files, ['backend/src/goal-convergence.mjs']);
  assert.equal(packet.key_evidence.no_change_repair_completion_summary.diff_empty, true);
  assert.equal(packet.key_evidence.no_change_repair_completion_summary.commit_reachable, true);
});

test('getTaskAcceptanceBundle reports missing_evidence instead of throwing for unfinished task', async () => {
  const state = {
    tasks: [{ id: 'task_running', goal_id: 'goal_running', title: 'Running task', status: 'running' }],
    goals: [{ id: 'goal_running', task_id: 'task_running', title: 'Running goal', status: 'open' }],
  };

  const bundle = await getTaskAcceptanceBundle({ store: makeStore(state), config: { defaultWorkspaceRoot: '/tmp/no-such-root' }, task_id: 'task_running' });

  assert.equal(bundle.task_id, 'task_running');
  assert.equal(bundle.status, 'running');
  assert.equal(bundle.result_summary.status, 'missing');
  assert.ok(bundle.missing_evidence.some((item) => item.code === 'result_missing'));
  assert.ok(bundle.missing_evidence.some((item) => item.code === 'verification_missing'));
});
