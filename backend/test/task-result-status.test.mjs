import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutonomyValidation,
  applyRuntimeCodeChangeGuard,
  deriveTaskStatusFromTaskResult,
  isP0TaskTitle,
  getRestartVerification,
  verifyToolExposure,
} from '../src/task-result-status.mjs';

// ===========================================================================
// deriveTaskStatusFromTaskResult
// ===========================================================================

test('deriveTaskStatusFromTaskResult maps task result kinds to task statuses', () => {
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_executed' }), 'completed');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'no_first_output_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'noop' }), 'waiting_for_review');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_failed' }), 'failed');
});

// ===========================================================================
// applyAutonomyValidation
// ===========================================================================

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

test('applyAutonomyValidation returns status unchanged when no goal', () => {
  const status = applyAutonomyValidation('completed', {}, null, {});
  assert.equal(status, 'completed');
});

// ===========================================================================
// applyRuntimeCodeChangeGuard — deploy mode (existing behavior)
// ===========================================================================

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

// ===========================================================================
// isP0TaskTitle
// ===========================================================================

test('isP0TaskTitle returns true for titles starting with P0:', () => {
  assert.equal(isP0TaskTitle('P0: Deploy something'), true);
});

test('isP0TaskTitle returns true for titles starting with P0.', () => {
  assert.equal(isP0TaskTitle('P0.1: Safe-restart MCP after P0 tasks'), true);
  assert.equal(isP0TaskTitle('P0.2: Another P0 task'), true);
  assert.equal(isP0TaskTitle('P0.x: Version-agnostic P0 task'), true);
});

test('isP0TaskTitle returns true for titles starting with P0 ', () => {
  assert.equal(isP0TaskTitle('P0 Task: Something important'), true);
});

test('isP0TaskTitle returns true for titles starting with P0-', () => {
  assert.equal(isP0TaskTitle('P0-critical-fix'), true);
});

test('isP0TaskTitle returns false for non-P0 titles', () => {
  assert.equal(isP0TaskTitle('P1: Deploy something'), false);
  assert.equal(isP0TaskTitle('P2: Something else'), false);
  assert.equal(isP0TaskTitle('Fix bug in deployment'), false);
  assert.equal(isP0TaskTitle(''), false);
  assert.equal(isP0TaskTitle(null), false);
  assert.equal(isP0TaskTitle(undefined), false);
  assert.equal(isP0TaskTitle(42), false);
});

test('isP0TaskTitle returns false for case-insensitive matches', () => {
  // Must be exactly P0 followed by separator
  assert.equal(isP0TaskTitle('p0: lowercase'), false);
  assert.equal(isP0TaskTitle('P0something'), false);
});

// ===========================================================================
// applyRuntimeCodeChangeGuard — P0 mode (new behavior)
// ===========================================================================

test('P0 task with runtime changes and no restart marker is moved to review', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/server-tools.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_p0',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
  assert.ok(taskResult.warnings[0].includes('runtime_code_changed_without_safe_restart'));
  assert.ok(taskResult.warnings[0].includes('backend/src/server-tools.mjs'));
});

test('P0 task with runtime changes and active restart marker stays completed', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/server-tools.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_p0',
    isP0Task: true,
    loadRestartMarkerFn: async () => ({ status: 'scheduled' }),
  });

  assert.equal(status, 'completed');
});

test('P0 task with no runtime-relevant changed files stays completed', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/test/some-test.mjs', 'README.md'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_p0_noop',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  // No runtime changes → guard is not triggered, stays completed
  assert.equal(status, 'completed');
});

test('Non-P0, non-deploy task with runtime changes skips guard entirely', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/server-tools.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_normal',
    isP0Task: false,
    loadRestartMarkerFn: async () => null,
  });

  // Not deploy mode, not P0: guard skips
  assert.equal(status, 'completed');
});

test('requires_mcp_restart: true in parsedResult triggers guard for non-P0 builder tasks', async () => {
  const taskResult = {};
  const parsedResult = {
    changed_files: ['backend/src/server-tools.mjs'],
    requires_mcp_restart: true,
  };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_explicit',
    isP0Task: false,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
});

test('guard does not block non-completed tasks regardless of mode', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/server-tools.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'failed',
    taskResult,
    mode: 'deploy',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_failed',
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'failed');
});

test('guard returns taskStatus unchanged when parsedResult is missing', async () => {
  const taskResult = {};

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'deploy',
    parsedResult: null,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_no_parsed',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'completed');
});

// ===========================================================================
// guarded mode patterns — verify tool-groups, worker, runtime, bin patterns
// ===========================================================================

test('P0 guard detects changes to tool-groups files', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/tool-groups/cleanup-tools-group.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_tools',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
  assert.ok(taskResult.warnings[0].includes('tool-groups'));
});

test('P0 guard detects changes to bin/gptwork.mjs', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/bin/gptwork.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_bin',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
});

test('P0 guard detects changes to package.json', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/package.json'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_pkg',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
});

test('P0 guard detects changes to worker files', async () => {
  const taskResult = {};
  const parsedResult = { changed_files: ['backend/src/codex-worker.mjs'] };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_worker',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'waiting_for_review');
});

// ===========================================================================
// getRestartVerification
// ===========================================================================

test('getRestartVerification returns verified state from task result', () => {
  const result = getRestartVerification({
    restart_state: 'verified',
    restart_verified_at: '2026-06-23T00:00:00.000Z',
    running_commit: 'abc123',
  });
  assert.equal(result.hasRestart, true);
  assert.equal(result.restartState, 'verified');
  assert.equal(result.runningCommit, 'abc123');
});

test('getRestartVerification returns false for no restart info', () => {
  const result = getRestartVerification({});
  assert.equal(result.hasRestart, false);
  assert.equal(result.restartState, null);
  assert.equal(result.runningCommit, null);
});

test('getRestartVerification handles null input', () => {
  const result = getRestartVerification(null);
  assert.equal(result.hasRestart, false);
  assert.equal(result.restartState, null);
  assert.equal(result.runningCommit, null);
});

test('getRestartVerification detects restart via restart_verified_at alone', () => {
  const result = getRestartVerification({
    restart_verified_at: '2026-06-23T00:00:00.000Z',
  });
  assert.equal(result.hasRestart, true);
  assert.equal(result.restartState, null);
});

// ===========================================================================
// verifyToolExposure
// ===========================================================================

test('verifyToolExposure reports all tools present', () => {
  const available = ['tmp_status', 'cleanup_tmp', 'goal_storage_status', 'cleanup_goals',
    'workflow_status', 'workflow_record_result', 'workflow_advance',
    'workflow_apply_proposal', 'repo_lock_status', 'list_repo_locks', 'clear_repo_lock',
    'schedule_service_restart'];
  const required = ['tmp_status', 'cleanup_tmp', 'workflow_status', 'repo_lock_status', 'clear_repo_lock'];

  const result = verifyToolExposure(available, required);
  assert.equal(result.allPresent, true);
  assert.deepEqual(result.missingTools, []);
  assert.deepEqual(result.presentTools, required);
});

test('verifyToolExposure reports missing tools', () => {
  const available = ['tmp_status', 'cleanup_tmp'];
  const required = ['tmp_status', 'cleanup_tmp', 'repo_lock_status', 'clear_repo_lock'];

  const result = verifyToolExposure(available, required);
  assert.equal(result.allPresent, false);
  assert.deepEqual(result.missingTools, ['repo_lock_status', 'clear_repo_lock']);
  assert.deepEqual(result.presentTools, ['tmp_status', 'cleanup_tmp']);
});

test('verifyToolExposure handles empty available tools', () => {
  const result = verifyToolExposure([], ['tmp_status', 'cleanup_tmp']);
  assert.equal(result.allPresent, false);
  assert.deepEqual(result.missingTools, ['tmp_status', 'cleanup_tmp']);
  assert.deepEqual(result.presentTools, []);
});

test('verifyToolExposure handles null available tools', () => {
  const result = verifyToolExposure(null, ['tmp_status']);
  assert.equal(result.allPresent, false);
  assert.deepEqual(result.missingTools, ['tmp_status']);
  assert.deepEqual(result.presentTools, []);
});

test('verifyToolExposure handles no required tools', () => {
  const result = verifyToolExposure(['tmp_status'], []);
  assert.equal(result.allPresent, true);
  assert.deepEqual(result.missingTools, []);
  assert.deepEqual(result.presentTools, []);
});

console.log('task-result-status tests loaded');
