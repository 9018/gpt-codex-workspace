import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutonomyValidation,
  applyRuntimeCodeChangeGuard,
  deriveTaskStatusFromTaskResult,
} from '../src/task-result-status.mjs';

test('deriveTaskStatusFromTaskResult maps task result kinds to task statuses', () => {
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_executed' }), 'completed');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'no_first_output_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_failed' }), 'failed');
});

test('applyAutonomyValidation moves completed invalid result to review and adds warning', () => {
  const taskResult = { kind: 'codex_executed' };
  const goal = {
    autonomy_policy: { gpt_question_budget: 0 },
    subagent_policy: { mode: 'required' }
  };
  const parsedResult = { gpt_questions_used: 1 };

  const status = applyAutonomyValidation('completed', taskResult, goal, parsedResult);

  assert.equal(status, 'waiting_for_review');
  assert.match(taskResult.warnings[0], /Autonomy policy validation failed:/);
});

test('applyRuntimeCodeChangeGuard moves deploy runtime changes without active marker to review', async () => {
  const taskResult = { kind: 'codex_executed' };
  const parsedResult = { changed_files: ['backend/src/gptwork-server.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'deploy',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_1',
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
  assert.equal(taskResult.warnings[0], 'runtime_code_changed_without_safe_restart: backend/src/gptwork-server.mjs');
});

test('applyRuntimeCodeChangeGuard keeps completed when active restart marker exists', async () => {
  const taskResult = { kind: 'codex_executed' };
  const parsedResult = { changed_files: ['backend/src/gptwork-server.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'deploy',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_1',
    loadRestartMarkerFn: async () => ({ status: 'scheduled' }),
  });

  assert.equal(status, 'completed');
  assert.equal(taskResult.warnings, undefined);
});
