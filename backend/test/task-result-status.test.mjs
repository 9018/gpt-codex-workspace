import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutonomyValidation,
  applyRuntimeCodeChangeGuard,
  deriveTaskStatusFromTaskResult,
  isP0TaskTitle,
  getRestartVerification,
  verifyToolExposure,
  validateResultContract,
  classifyResultContractFindings,
} from '../src/task-result-status.mjs';

// ===========================================================================
// deriveTaskStatusFromTaskResult
// ===========================================================================

test('deriveTaskStatusFromTaskResult maps task result kinds to task statuses', () => {
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_executed' }), 'completed');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'codex_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'no_first_output_timeout' }), 'timed_out');
  assert.equal(deriveTaskStatusFromTaskResult({ kind: 'noop' }), 'completed');
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

test('accepted verified runtime-code result records restart requirement without forcing review', async () => {
  const taskResult = {
    kind: 'codex_executed',
    commit: '1234567890abcdef1234567890abcdef12345678',
    verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
    reviewer_decision: { status: 'accepted', passed: true },
    acceptance_findings: [],
  };
  const parsedResult = {
    changed_files: ['backend/src/acceptance/contract-builder.mjs', 'backend/src/queue-policy.mjs'],
    commit: taskResult.commit,
    verification: { passed: true },
  };

  const status = await applyRuntimeCodeChangeGuard({
    taskStatus: 'completed',
    taskResult,
    mode: 'builder',
    parsedResult,
    workspaceRoot: '/tmp/workspace',
    taskId: 'task_4f23c446',
    isP0Task: true,
    loadRestartMarkerFn: async () => null,
  });

  assert.equal(status, 'completed');
  assert.equal(taskResult.restart_required, true);
  assert.equal(taskResult.requires_restart_check, true);
  assert.equal(taskResult.runtime_restart_guard.status, 'restart_required');
  assert.equal(taskResult.runtime_restart_guard.requires_review, false);
  assert.ok(taskResult.warnings[0].includes('runtime_code_changed_without_safe_restart'));
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


// ---------------------------------------------------------------------------
// validateResultContract tests (P0)
// ---------------------------------------------------------------------------

test("validateResultContract returns valid for complete result with all fields", () => {
  const result = {
    status: "completed",
    changed_files: ["src/foo.js"],
    commit: "abc123",
    tests: "npm test: passed",
    summary: "Done",
  };
  // Skip worktree check since test environment may have uncommitted changes
  const validation = validateResultContract(result, { repoPath: process.cwd(), skipWorktreeCheck: true });
  assert.equal(validation.valid, true);
  assert.equal(validation.diagnosis_codes.length, 0);
});

test("validateResultContract returns TESTS_MISSING for completed non-noop result without tests", () => {
  const result = {
    status: "completed",
    changed_files: ["src/foo.js"],
    commit: "abc123",
    tests: null,
    summary: "Done",
  };
  const validation = validateResultContract(result, { repoPath: process.cwd() });
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnosis_codes.includes("tests_missing"));
});

test("validateResultContract returns COMMIT_MISSING when changed_files but no commit", () => {
  const result = {
    status: "completed",
    changed_files: ["src/foo.js"],
    commit: "none",
    tests: "npm test: passed",
    summary: "Done",
  };
  const validation = validateResultContract(result, { repoPath: process.cwd() });
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnosis_codes.includes("commit_missing"));
});

test("validateResultContract accepts verified admin restart evidence without changed files", () => {
  const head = "88546312e483f2ce4a338ae0486e31c9bc4dd739";
  const result = {
    status: "completed",
    kind: "admin_restart_verified",
    changed_files: [],
    commit: head,
    local_head: head,
    running_commit: head,
    restart_required: false,
    tests: "safe restart verified; runtime commit matched; health passed",
    summary: "Safe restart verified",
    verification: {
      passed: true,
      commands: [{ cmd: "safe_restart_phase_c_verify", exit_code: 0 }],
    },
    acceptance_findings: [],
  };

  const validation = validateResultContract(result, { skipWorktreeCheck: true });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.diagnosis_codes, []);
});

test("validateResultContract skips worktree check when skipWorktreeCheck is true", () => {
  const result = {
    status: "completed",
    changed_files: [],
    commit: null,
    tests: "npm test: passed",
    summary: "Done",
  };
  const validation = validateResultContract(result, { skipWorktreeCheck: true });
  assert.equal(validation.valid, true);
});

test("validateResultContract uses provided repoPath for worktree check", () => {
  const result = {
    status: "completed",
    changed_files: [],
    commit: "abc123",
    tests: "npm test: passed",
    summary: "Done",
  };
  // Using a valid repo path (current cwd) should not throw
  const validation = validateResultContract(result, { repoPath: process.cwd() });
  assert.ok(typeof validation.valid === "boolean");
  assert.ok(Array.isArray(validation.diagnosis_codes));
});

test("validateResultContract returns SUMMARY_FIELD_CONFLICT for summary without evidence", () => {
  const result = {
    status: "completed",
    summary: "Task completed successfully",
    changed_files: [],
    commit: "none",
    tests: null,
    noop: false,
  };
  const validation = validateResultContract(result, { repoPath: process.cwd(), skipWorktreeCheck: true });
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnosis_codes.includes("summary_field_conflict"));
});

test("validateResultContract returns valid for noop completed result", () => {
  const result = {
    status: "completed",
    noop: true,
    summary: "No changes needed",
    changed_files: [],
    commit: null,
    tests: null,
  };
  const validation = validateResultContract(result, { repoPath: process.cwd(), skipWorktreeCheck: true });
  assert.equal(validation.valid, true);
});

test("classifyResultContractFindings keeps sync-only missing tests as followup", () => {
  const classification = classifyResultContractFindings({
    diagnosisCodes: ["tests_missing", "commit_missing"],
    profile: "sync_only",
  });

  assert.deepEqual(classification.blocking_codes, ["commit_missing"]);
  assert.deepEqual(classification.non_blocking_codes, ["tests_missing"]);
  assert.equal(classification.finding_severity_for_code.tests_missing, "followup");
  assert.equal(classification.finding_severity_for_code.commit_missing, "major");
});

test("classifyResultContractFindings treats commit missing as blocking for code changes", () => {
  const classification = classifyResultContractFindings({
    diagnosisCodes: ["commit_missing"],
    profile: "code_change",
  });

  assert.deepEqual(classification.blocking_codes, ["commit_missing"]);
  assert.deepEqual(classification.non_blocking_codes, []);
  assert.equal(classification.finding_severity_for_code.commit_missing, "major");
});

console.log('task-result-status tests loaded');
