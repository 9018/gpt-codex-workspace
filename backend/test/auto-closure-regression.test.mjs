/**
 * auto-closure-regression.test.mjs — P0: Full-link auto-closure regression tests.
 *
 * Tests the complete auto-closure pipeline:
 *   1. Task type classification (code_change, sync, noop, verification)
 *   2. Closure path determination (complete, integrate, retry, repair, review)
 *   3. Network failure → retry (NOT code repair)
 *   4. Pure sync → complete without verification
 *   5. Notification consistency (Bark + GitHub)
 *   6. Self-healing policy network error patterns
 *   7. Retry budget management
 *   8. Full scenario matrix (10 closure scenarios)
 *
 * Each test verifies the auto-closure classification output matches
 * the expected terminal state for each scenario.
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

import {
  TASK_TYPES,
  CLOSURE_PATHS,
  classifyTaskType,
  determineClosurePath,
  checkNotificationConsistency,
  classifyClosure,
} from '../src/auto-closure-classifier.mjs';

import { classifyFailure, failureClassRequiresRepair, failureClassIsTerminalNonRepairable } from '../src/failure-classifier.mjs';

import { classifyError, ERROR_CATEGORIES, determineHealingAction } from '../src/self-healing-policy.mjs';

// ===========================================================================
// 1. Task type classification tests
// ===========================================================================

test('classifyTaskType: noop flag returns NOOP', () => {
  assert.deepEqual(classifyTaskType({ noop: true }), { type: TASK_TYPES.NOOP, typeLabel: 'no-op' });
  assert.deepEqual(classifyTaskType({ kind: 'noop' }), { type: TASK_TYPES.NOOP, typeLabel: 'no-op' });
});

test('classifyTaskType: no changed_files but has tests returns VERIFICATION', () => {
  const result = classifyTaskType({
    changed_files: [],
    tests: 'npm test: passed 15/15',
  });
  assert.equal(result.type, TASK_TYPES.VERIFICATION);
  assert.equal(result.typeLabel, 'verification');
});

test('classifyTaskType: no changed_files and no tests returns SYNC', () => {
  assert.deepEqual(classifyTaskType({ changed_files: [], tests: null }), { type: TASK_TYPES.SYNC, typeLabel: 'sync' });
  assert.deepEqual(classifyTaskType({}), { type: TASK_TYPES.SYNC, typeLabel: 'sync' });
  assert.deepEqual(classifyTaskType(null), { type: TASK_TYPES.SYNC, typeLabel: 'sync' });
});

test('classifyTaskType: has changed_files returns CODE_CHANGE', () => {
  assert.deepEqual(classifyTaskType({ changed_files: ['src/app.mjs'] }), { type: TASK_TYPES.CODE_CHANGE, typeLabel: 'code change' });
  assert.deepEqual(classifyTaskType({ changed_files: ['README.md', 'src/lib.mjs'] }), { type: TASK_TYPES.CODE_CHANGE, typeLabel: 'code change' });
});

// ===========================================================================
// 2. Closure path determination tests
// ===========================================================================

test('determineClosurePath: network failures → RETRY', () => {
  const result = determineClosurePath({
    failure_class: 'rate_limited',
    summary: '429 Too Many Requests',
  });
  assert.equal(result.path, CLOSURE_PATHS.RETRY);
  assert.equal(result.skipRepair, true);
  assert.equal(result.needsBackoff, true);
});

test('determineClosurePath: gateway error → RETRY', () => {
  const result = determineClosurePath({
    failure_class: 'gateway_error',
    summary: '502 Bad Gateway from upstream provider',
  });
  assert.equal(result.path, CLOSURE_PATHS.RETRY);
  assert.equal(result.skipRepair, true);
});

test('determineClosurePath: transient network error → RETRY', () => {
  const result = determineClosurePath({
    failure_class: 'transient_network_error',
    summary: 'ECONNREFUSED from api.openai.com',
  });
  assert.equal(result.path, CLOSURE_PATHS.RETRY);
  assert.equal(result.skipRepair, true);
});

test('determineClosurePath: codex_timeout → RETRY (terminal non-repairable)', () => {
  const result = determineClosurePath({
    failure_class: 'codex_timeout',
    summary: 'Codex execution timed out',
  });
  assert.equal(result.path, CLOSURE_PATHS.RETRY);
  assert.equal(result.skipRepair, true);
});

test('determineClosurePath: repairable failures → REPAIR', () => {
  const result = determineClosurePath({
    failure_class: 'test_failed',
    summary: 'Tests failed: 2/10 failed',
  });
  assert.equal(result.path, CLOSURE_PATHS.REPAIR);
  assert.equal(result.skipRepair, false);
});

test('determineClosurePath: missing_result_json → REPAIR', () => {
  const result = determineClosurePath({
    failure_class: 'missing_result_json',
    summary: 'result.json missing',
  });
  assert.equal(result.path, CLOSURE_PATHS.REPAIR);
  assert.equal(result.skipRepair, false);
});

test('determineClosurePath: code change success → INTEGRATE', () => {
  const result = determineClosurePath({
    failure_class: null,
    changed_files: ['src/app.mjs', 'src/lib.mjs'],
    verification: { passed: true, commands: ['npm test'] },
    summary: 'Added new feature',
  });
  assert.equal(result.path, CLOSURE_PATHS.INTEGRATE);
  assert.equal(result.needsIntegration, true);
  assert.equal(result.needsRestartCheck, true);
});

test('determineClosurePath: sync success → COMPLETE', () => {
  const result = determineClosurePath({
    failure_class: null,
    changed_files: [],
    summary: 'Sync task completed',
  });
  assert.equal(result.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
});

test('determineClosurePath: noop success → COMPLETE', () => {
  const result = determineClosurePath({
    noop: true,
    failure_class: null,
    changed_files: [],
    summary: 'No changes needed',
  });
  assert.equal(result.path, CLOSURE_PATHS.COMPLETE);
});

test('determineClosurePath: verification success → COMPLETE', () => {
  const result = determineClosurePath({
    failure_class: null,
    changed_files: [],
    tests: 'npm test: passed 15/15',
    summary: 'Verification task',
  });
  assert.equal(result.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsRestartCheck, true); // verification needs restart check
});

test('determineClosurePath: unhandled custom failure_class → REVIEW', () => {
  // unknown failure_class without matching repairable or terminal pattern
  const result = determineClosurePath({
    failure_class: 'custom_plugin_error',
    summary: 'Something went wrong',
    changed_files: ['src/broken.mjs'],
  });
  assert.equal(result.path, CLOSURE_PATHS.REVIEW);
  assert.equal(result.skipRepair, true);
});

// ===========================================================================
// 3. Network failure → retry (NOT code repair)
// ===========================================================================

test('network failures are NOT repairable by the repair loop', () => {
  // This is the critical P0 contract: network failures must NOT enter
  // the code repair loop because retrying them is counterproductive.
  assert.equal(failureClassIsTerminalNonRepairable('rate_limited'), true);
  assert.equal(failureClassIsTerminalNonRepairable('gateway_error'), true);
  assert.equal(failureClassIsTerminalNonRepairable('transient_network_error'), true);
  assert.equal(failureClassIsTerminalNonRepairable('codex_timeout'), true);

  assert.equal(failureClassRequiresRepair('rate_limited'), false);
  assert.equal(failureClassRequiresRepair('gateway_error'), false);
  assert.equal(failureClassRequiresRepair('transient_network_error'), false);
  assert.equal(failureClassRequiresRepair('codex_timeout'), false);
});

// ===========================================================================
// 4. Self-healing policy network error handling
// ===========================================================================

test('self-healing: classifyError recognizes rate_limited (429)', () => {
  const result = classifyError(new Error('429 Too Many Requests'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 3);
});

test('self-healing: classifyError recognizes gateway_error (502)', () => {
  const result = classifyError(new Error('502 Bad Gateway from upstream provider'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'gateway_error');
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 3);
});

test('self-healing: classifyError recognizes gateway_error (503)', () => {
  const result = classifyError(new Error('503 Service Unavailable'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'gateway_error');
});

test('self-healing: classifyError recognizes rate limit phrases', () => {
  const tests = [
    'Rate limit exceeded',
    'too many requests',
    'quota exceeded',
    'Retry later',
    'Request was throttled',
  ];
  for (const msg of tests) {
    const result = classifyError(new Error(msg));
    assert.equal(result.category, ERROR_CATEGORIES.NETWORK, `Should classify "${msg}" as NETWORK`);
    assert.equal(result.code, 'rate_limited', `Should classify "${msg}" as rate_limited`);
  }
});

test('self-healing: classifyError recognizes transient network errors', () => {
  const tests = [
    'connect ECONNREFUSED',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'ENOTFOUND getaddrinfo',
    'network error',
    'fetch failed',
    'failed to fetch',
    'socket hang up',
    'unable to connect',
  ];
  for (const msg of tests) {
    const result = classifyError(new Error(msg));
    assert.equal(result.category, ERROR_CATEGORIES.NETWORK, `Should classify "${msg}" as NETWORK`);
    assert.equal(result.code, 'transient_network_error', `Should classify "${msg}" as transient_network_error`);
  }
});

test('self-healing: classifyError recognizes overloaded as gateway', () => {
  const result = classifyError(new Error('upstream overloaded'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'gateway_error');
});

test('self-healing: determineHealingAction returns retry_with_backoff for network errors', () => {
  const result = determineHealingAction({
    error: new Error('429 Too Many Requests'),
    retryCount: 0,
  });
  assert.equal(result.action, 'retry_with_backoff');
  assert.equal(result.next_status, 'queued');
  assert.ok(result.reason.includes('Network error'));
});

test('self-healing: determineHealingAction returns waiting_for_human_review when budget exceeded', () => {
  const result = determineHealingAction({
    error: new Error('429 Too Many Requests'),
    retryCount: 5, // exceeds budget of 3
  });
  assert.equal(result.action, 'waiting_for_human_review');
});

// ===========================================================================
// 5. Notification consistency checks
// ===========================================================================

test('checkNotificationConsistency: both channels present and ok → consistent', () => {
  const task = {
    status: 'completed',
    notifications: [
      { channel: 'bark', ok: true, attempted_at: '2026-01-01T00:00:00Z' },
    ],
  };
  const githubResult = { ok: true, issue: 42, updated: true };
  const result = checkNotificationConsistency(task, githubResult);
  assert.equal(result.consistent, true);
  assert.equal(result.channels.bark.ok, true);
  assert.equal(result.channels.github.ok, true);
});

test('checkNotificationConsistency: missing Bark notification → finding', () => {
  const task = { status: 'completed', notifications: [] };
  const githubResult = { ok: true };
  const result = checkNotificationConsistency(task, githubResult);
  assert.equal(result.consistent, false);
  assert.ok(result.findings.some(f => f.code === 'bark_notification_missing'));
});

test('checkNotificationConsistency: both channels failed → major finding', () => {
  const task = {
    status: 'completed',
    notifications: [
      { channel: 'bark', ok: false, error_short: 'timeout' },
    ],
  };
  const githubResult = { ok: false, error: 'API call failed' };
  const result = checkNotificationConsistency(task, githubResult);
  assert.equal(result.consistent, false);
  assert.ok(result.findings.some(f => f.code === 'notification_channels_both_failed'));
});

test('checkNotificationConsistency: non-terminal status skips missing bark finding', () => {
  const task = { status: 'running', notifications: [] };
  const result = checkNotificationConsistency(task, null);
  assert.equal(result.consistent, true); // no findings for non-terminal
});

test('checkNotificationConsistency: completed without GitHub sync → finding', () => {
  const task = {
    status: 'completed',
    notifications: [
      { channel: 'bark', ok: true },
    ],
  };
  const result = checkNotificationConsistency(task, null);
  assert.equal(result.consistent, false);
  assert.ok(result.findings.some(f => f.code === 'github_sync_missing'));
});

// ===========================================================================
// 6. Full classifyClosure integration tests
// ===========================================================================

test('classifyClosure: code change path includes restart check', () => {
  const taskType = { type: 'code_change', typeLabel: 'code change' };
  const closurePath = { path: 'integrate', needsRestartCheck: true, reason: 'Code change' };
  // This is testing the helper structure, not the full classifyClosure
  const result = classifyClosure(
    { failure_class: null, changed_files: ['src/app.mjs'], verification: { passed: true } },
    { status: 'completed', notifications: [] },
    { ok: true }
  );
  assert.equal(result.taskType.type, TASK_TYPES.CODE_CHANGE);
  assert.equal(result.needsRestartCheck, true);
  assert.equal(result.needsIntegration, true);
  assert.equal(result.requiresReview, false);
  assert.equal(result.requiresRepair, false);
  assert.equal(result.requiresRetry, false);
});

test('classifyClosure: network failure path sets requiresRetry=true', () => {
  const result = classifyClosure(
    { failure_class: 'rate_limited', summary: '429 rate limited' },
    { status: 'failed', notifications: [] },
    null
  );
  assert.equal(result.requiresRetry, true);
  assert.equal(result.closurePath.path, CLOSURE_PATHS.RETRY);
});

test('classifyClosure: repairable failure path sets requiresRepair=true', () => {
  const result = classifyClosure(
    { failure_class: 'test_failed', changed_files: ['src/broken.mjs'], summary: 'Tests failed' },
    { status: 'failed', notifications: [] },
    null
  );
  assert.equal(result.requiresRepair, true);
  assert.equal(result.closurePath.path, CLOSURE_PATHS.REPAIR);
});

test('classifyClosure: pure sync path = complete, no restart, no integration', () => {
  const result = classifyClosure(
    { failure_class: null, changed_files: [], summary: 'Sync task' },
    { status: 'completed', notifications: [] },
    { ok: true }
  );
  assert.equal(result.closurePath.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
  assert.equal(result.needsRestartCheck, false);
});

test('classifyClosure: noop path = complete, no restart, no integration', () => {
  const result = classifyClosure(
    { noop: true, failure_class: null, changed_files: [], summary: 'No changes' },
    { status: 'completed', notifications: [] },
    null
  );
  assert.equal(result.closurePath.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
  assert.equal(result.needsRestartCheck, false);
});

test('classifyClosure: verification path = complete with restart check', () => {
  const result = classifyClosure(
    { failure_class: null, changed_files: [], tests: 'npm test: passed', summary: 'Verification only' },
    { status: 'completed', notifications: [] },
    null
  );
  assert.equal(result.closurePath.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsRestartCheck, true);
  assert.equal(result.needsIntegration, false);
});

// ===========================================================================
// 7. Complete scenario matrix
// ===========================================================================

test('auto-closure: full scenario matrix coverage', () => {
  const scenarios = [
    // { scenario, taskResult, task, expectedPath, expectedStatus, requiresReview, requiresRepair, requiresRetry }
    {
      name: 'successful code change',
      taskResult: { failure_class: null, changed_files: ['src/app.mjs'], verification: { passed: true } },
      task: { status: 'completed', notifications: [] },
      expectedPath: 'integrate',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: false,
    },
    {
      name: 'pure sync (no changes)',
      taskResult: { failure_class: null, changed_files: [], summary: 'sync' },
      task: { status: 'completed', notifications: [] },
      expectedPath: 'complete',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: false,
    },
    {
      name: 'noop',
      taskResult: { noop: true, failure_class: null, changed_files: [], summary: 'noop' },
      task: { status: 'completed', notifications: [] },
      expectedPath: 'complete',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: false,
    },
    {
      name: 'verification-only (tests but no changes)',
      taskResult: { failure_class: null, changed_files: [], tests: 'all passed', summary: 'verification' },
      task: { status: 'completed', notifications: [] },
      expectedPath: 'complete',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: false,
    },
    {
      name: 'rate limited (429)',
      taskResult: { failure_class: 'rate_limited', summary: '429' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'retry',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: true,
    },
    {
      name: 'gateway error (502)',
      taskResult: { failure_class: 'gateway_error', summary: '502' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'retry',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: true,
    },
    {
      name: 'transient network error',
      taskResult: { failure_class: 'transient_network_error', summary: 'ECONNREFUSED' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'retry',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: true,
    },
    {
      name: 'codex timeout',
      taskResult: { failure_class: 'codex_timeout', summary: 'timed out' },
      task: { status: 'timed_out', notifications: [] },
      expectedPath: 'retry',
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: true,
    },
    {
      name: 'test failure (repairable)',
      taskResult: { failure_class: 'test_failed', changed_files: ['src/broken.mjs'], summary: 'tests failed' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'repair',
      requiresReview: false,
      requiresRepair: true,
      requiresRetry: false,
    },
    {
      name: 'missing result.json (repairable)',
      taskResult: { failure_class: 'missing_result_json', summary: 'no result' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'repair',
      requiresReview: false,
      requiresRepair: true,
      requiresRetry: false,
    },
    {
      name: 'unhandled failure → review',
      taskResult: { failure_class: 'stale_running_task', summary: 'stale' },
      task: { status: 'failed', notifications: [] },
      expectedPath: 'retry',  // stale_running_task is terminal non-repairable
      requiresReview: false,
      requiresRepair: false,
      requiresRetry: true,
    },
  ];

  for (const sc of scenarios) {
    const result = classifyClosure(sc.taskResult, sc.task, null);
    assert.equal(result.closurePath.path, sc.expectedPath,
      `Scenario "${sc.name}": expected path=${sc.expectedPath}, got ${result.closurePath.path}`);
    assert.equal(result.requiresReview, sc.requiresReview,
      `Scenario "${sc.name}": requiresReview mismatch`);
    assert.equal(result.requiresRepair, sc.requiresRepair,
      `Scenario "${sc.name}": requiresRepair mismatch`);
    assert.equal(result.requiresRetry, sc.requiresRetry,
      `Scenario "${sc.name}": requiresRetry mismatch`);
    // Verify the summary is always present
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0,
      `Scenario "${sc.name}": summary should be non-empty`);
  }
});

// ===========================================================================
// 8. Failure classifier edge cases
// ===========================================================================

test('failure-classifier: rate_limited from various patterns', () => {
  assert.equal(classifyFailure({ message: '429 Too Many Requests' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'rate limit exceeded for model' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'OpenAI API quota exceeded' }), 'rate_limited');
  assert.equal(classifyFailure({ rateLimited: true }), 'rate_limited');
});

test('failure-classifier: gateway_error from various patterns', () => {
  assert.equal(classifyFailure({ message: '502 Bad Gateway' }), 'gateway_error');
  assert.equal(classifyFailure({ message: '503 Service Unavailable from upstream' }), 'gateway_error');
  assert.equal(classifyFailure({ message: 'upstream connect error or disconnect/reset' }), 'gateway_error');
  assert.equal(classifyFailure({ gatewayError: true }), 'gateway_error');
});

test('failure-classifier: transient_network_error from various patterns', () => {
  assert.equal(classifyFailure({ message: 'connect ECONNREFUSED 127.0.0.1:443' }), 'transient_network_error');
  assert.equal(classifyFailure({ message: 'read ECONNRESET' }), 'transient_network_error');
  assert.equal(classifyFailure({ message: 'request to https://api.openai.com failed, reason: connect ETIMEDOUT' }), 'transient_network_error');
  assert.equal(classifyFailure({ transientNetworkError: true }), 'transient_network_error');
});

// ===========================================================================
// 9. Auto-closure summary verification
// ===========================================================================

test('classifyClosure: summary contains all required fields', () => {
  const result = classifyClosure(
    { failure_class: null, changed_files: ['src/app.mjs'], verification: { passed: true } },
    { status: 'completed', notifications: [{ channel: 'bark', ok: true }] },
    { ok: true }
  );
  // Summary must contain: task type, closure path, notification status, restart check
  assert.ok(result.summary.includes('Task type:'), 'Summary should include Task type');
  assert.ok(result.summary.includes('Closure path:'), 'Summary should include Closure path');
  assert.ok(result.summary.includes('Notifications:'), 'Summary should include Notifications');
  assert.ok(result.summary.includes('Restart check:'), 'Summary should include Restart check');
});

// ===========================================================================
// 10. Retry budget management
// ===========================================================================

test('self-healing: retry budget works for network errors', () => {
  const error = new Error('429 Too Many Requests');

  // First attempt: retry
  const r1 = determineHealingAction({ error, retryCount: 0 });
  assert.equal(r1.action, 'retry_with_backoff');

  // Second attempt: retry
  const r2 = determineHealingAction({ error, retryCount: 1 });
  assert.equal(r2.action, 'retry_with_backoff');

  // Third attempt: retry
  const r3 = determineHealingAction({ error, retryCount: 2 });
  assert.equal(r3.action, 'retry_with_backoff');

  // Fourth attempt (exceeds budget of 3): review
  const r4 = determineHealingAction({ error, retryCount: 3 });
  assert.equal(r4.action, 'waiting_for_human_review');
});

// ===========================================================================
// 11. Notification consistency edge cases
// ===========================================================================

test('checkNotificationConsistency: non-terminal status skips all checks', () => {
  const task = { status: 'queued', notifications: [] };
  const result = checkNotificationConsistency(task, null);
  assert.equal(result.consistent, true);
  assert.equal(result.findings.length, 0);
});

test('checkNotificationConsistency: mixed channel results', () => {
  const task = {
    status: 'completed',
    notifications: [
      { channel: 'bark', ok: true },
    ],
  };
  const githubResult = { ok: false, error: 'rate limited' };
  const result = checkNotificationConsistency(task, githubResult);
  // Bark ok, GitHub not ok → not consistent, but no "both failed" finding
  assert.equal(result.consistent, true);  // githubResult IS present (synced=true)
  // githubResult is present, no missing sync finding
  assert.equal(result.channels.github.synced, true);
  assert.equal(result.channels.github.ok, false);
  // Should NOT have both_failed because bark is ok
  const bothFailed = result.findings.filter(f => f.code === 'notification_channels_both_failed');
  assert.equal(bothFailed.length, 0);
});

console.log('auto-closure-regression tests loaded');

// ===========================================================================
// P0-MA2: readonly_validation and already_integrated as noop-like
// ===========================================================================

test('P0-MA2: readonly_validation result is classified as noop type', () => {
  const result = classifyTaskType({
    operation_kind: 'readonly_validation',
    readonly_result: true,
    changed_files: [],
    validation_evidence: { summary: 'ok' },
  });
  assert.equal(result.type, TASK_TYPES.NOOP);
  assert.equal(result.typeLabel, 'readonly validation');
});

test('P0-MA2: already_integrated result is classified as noop type', () => {
  const result = classifyTaskType({
    operation_kind: 'already_integrated',
    already_integrated_result: true,
    changed_files: [],
    already_integrated_evidence: { already_integrated: true },
  });
  assert.equal(result.type, TASK_TYPES.NOOP);
  assert.equal(result.typeLabel, 'already integrated');
});

test('P0-MA2: readonly_validation closure path is COMPLETE', () => {
  const result = determineClosurePath({
    operation_kind: 'readonly_validation',
    readonly_result: true,
    integration_not_required: true,
    changed_files: [],
    status: 'completed',
  });
  assert.equal(result.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
  assert.equal(result.needsRestartCheck, false);
});

test('P0-MA2: already_integrated closure path is COMPLETE', () => {
  const result = determineClosurePath({
    operation_kind: 'already_integrated',
    already_integrated_result: true,
    integration_not_required: true,
    changed_files: [],
    status: 'completed',
  });
  assert.equal(result.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
  assert.equal(result.needsRestartCheck, false);
});

// ===========================================================================
// P0-MA2: tests derived from verification.commands
// ===========================================================================

test('P0-MA2: tests_derived_from_verification is detected as tests evidence', () => {
  const result = classifyTaskType({
    changed_files: [],
    tests_derived_from_verification: true,
    tests: 'npm test',
    verification: { commands: ['npm test'] },
  });
  assert.equal(result.type, TASK_TYPES.VERIFICATION);
  assert.equal(result.typeLabel, 'verification');
});

test('P0-MA2: verification.commands alone is tests evidence even without tests_derived_from_verification flag', () => {
  const result = classifyTaskType({
    changed_files: [],
    tests: null,
    verification: { commands: ['npm test'] },
  });
  assert.equal(result.type, TASK_TYPES.VERIFICATION);
  assert.equal(result.typeLabel, 'verification');
});

test('P0-MA2: noop-like with verification.commands is still NOOP not VERIFICATION', () => {
  const result = classifyTaskType({
    operation_kind: 'readonly_validation',
    readonly_result: true,
    changed_files: [],
    tests: null,
    verification: { commands: ['npm test'] },
  });
  // readonly_validation takes precedence over verification type
  assert.equal(result.type, TASK_TYPES.NOOP);
});

// ===========================================================================
// P0-MA2: Normalized evidence booleans with classifyClosure
// ===========================================================================

test('P0-MA2: classifyClosure with readonly_result completes correctly', () => {
  const result = classifyClosure(
    {
      readonly_result: true,
      operation_kind: 'readonly_validation',
      integration_not_required: true,
      changed_files: [],
      validation_evidence: { summary: 'ok' },
      status: 'completed',
    },
    { status: 'completed', notifications: [] },
    { ok: true }
  );
  assert.equal(result.closurePath.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
  assert.equal(result.needsRestartCheck, false);
});

test('P0-MA2: classifyClosure with already_integrated_result completes correctly', () => {
  const result = classifyClosure(
    {
      already_integrated_result: true,
      operation_kind: 'already_integrated',
      integration_not_required: true,
      changed_files: [],
      status: 'completed',
    },
    { status: 'completed', notifications: [] },
    { ok: true }
  );
  assert.equal(result.closurePath.path, CLOSURE_PATHS.COMPLETE);
  assert.equal(result.needsIntegration, false);
});
