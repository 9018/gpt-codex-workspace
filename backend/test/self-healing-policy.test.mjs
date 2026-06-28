/**
 * self-healing-policy.test.mjs
 * Tests for self-healing policy — error classification, healing actions, retry budget.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  determineHealingAction,
  ERROR_CATEGORIES,
} from "../src/self-healing-policy.mjs";

// ================================================================
// Tests: classifyError
// ================================================================

test("classifyError: ENOSPC is recoverable with budget 1", () => {
  const result = classifyError(new Error("ENOSPC: no space left"));
  assert.equal(result.category, ERROR_CATEGORIES.ENOSPC);
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 1);
});

test("classifyError: no first output timeout is recoverable", () => {
  const result = classifyError(new Error("no first output timeout"));
  assert.equal(result.category, ERROR_CATEGORIES.NO_FIRST_OUTPUT);
  assert.equal(result.recoverable, true);
});

test("classifyError: stale lock is recoverable with budget 2", () => {
  const result = classifyError(new Error("stale lock for repo"));
  assert.equal(result.category, ERROR_CATEGORIES.STALE_LOCK);
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 2);
});

test("classifyError: timeout is recoverable with budget 1", () => {
  const result = classifyError(new Error("operation timed out"));
  assert.equal(result.category, ERROR_CATEGORIES.TIMEOUT);
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 1);
});

test("classifyError: unknown error is not recoverable", () => {
  const result = classifyError(new Error("some random failure"));
  assert.equal(result.category, ERROR_CATEGORIES.UNKNOWN);
  assert.equal(result.recoverable, false);
  assert.equal(result.retry_budget, 0);
});

// ================================================================
// Tests: determineHealingAction
// ================================================================

test("determineHealingAction: ENOSPC returns cleanup_and_retry", () => {
  const action = determineHealingAction({ error: new Error("ENOSPC: disk full") });
  assert.equal(action.action, "cleanup_and_retry");
  assert.equal(action.cleanup_tmp, true);
  assert.notEqual(action.reason, "");
});

test("determineHealingAction: no first output returns compact_and_retry", () => {
  const action = determineHealingAction({ error: new Error("no first output timeout") });
  assert.equal(action.action, "compact_and_retry");
  assert.equal(action.compact_context, true);
});

test("determineHealingAction: stale lock returns reconcile_lock_and_retry", () => {
  const action = determineHealingAction({ error: new Error("stale lock not released") });
  assert.equal(action.action, "reconcile_lock_and_retry");
});

test("determineHealingAction: worker crash returns recover_and_retry", () => {
  const action = determineHealingAction({ error: new Error("worker crash: child pid dead") });
  assert.equal(action.action, "recover_and_retry");
});

test("determineHealingAction: result missing returns fallback_parse_and_retry", () => {
  const action = determineHealingAction({ error: new Error("result.json missing") });
  assert.equal(action.action, "fallback_parse_and_retry");
});

test("determineHealingAction: timeout returns compact_and_retry", () => {
  const action = determineHealingAction({ error: new Error("timed out") });
  assert.equal(action.action, "compact_and_retry");
});

test("determineHealingAction: unknown error returns waiting_for_review", () => {
  const action = determineHealingAction({ error: new Error("random failure") });
  assert.equal(action.action, "waiting_for_review");
});

test("determineHealingAction: restart interrupted is not recoverable", () => {
  const action = determineHealingAction({ error: new Error("safe restart interrupted") });
  assert.equal(action.action, "waiting_for_review");
});

// ================================================================
// Tests: retry budget enforcement
// ================================================================

test("determineHealingAction: retry within budget returns retry action", () => {
  // ENOSPC has budget 1, retryCount 0 → still within budget → retry
  const action = determineHealingAction({
    error: new Error("ENOSPC: no space"),
    retryCount: 0,
  });
  assert.notEqual(action.action, "waiting_for_review");
  assert.equal(action.next_status, "repairing");
});

test("determineHealingAction: retry exceeds budget returns waiting_for_review", () => {
  // ENOSPC has budget 1, retryCount 1 → budget exceeded → waiting_for_review
  const action = determineHealingAction({
    error: new Error("ENOSPC: no space"),
    retryCount: 1,
  });
  assert.equal(action.action, "waiting_for_review");
  assert.equal(action.next_status, "waiting_for_review");
});

test("determineHealingAction: stale lock with retryCount=1 still retries (budget 2)", () => {
  const action = determineHealingAction({
    error: new Error("stale lock"),
    retryCount: 1,
  });
  assert.equal(action.action, "reconcile_lock_and_retry");
});

test("determineHealingAction: stale lock with retryCount=2 exceeds budget", () => {
  const action = determineHealingAction({
    error: new Error("stale lock"),
    retryCount: 2,
  });
  assert.equal(action.action, "waiting_for_review");
});

test("determineHealingAction: timeout with retryCount=0 retries", () => {
  const action = determineHealingAction({
    error: new Error("timed out"),
    retryCount: 0,
  });
  assert.equal(action.action, "compact_and_retry");
});

test("determineHealingAction: timeout with retryCount=1 exceeds budget", () => {
  const action = determineHealingAction({
    error: new Error("timed out"),
    retryCount: 1,
  });
  assert.equal(action.action, "waiting_for_review");
});

test("determineHealingAction: default retryCount=0", () => {
  const action = determineHealingAction({ error: new Error("ENOSPC") });
  const actionWithZero = determineHealingAction({ error: new Error("ENOSPC"), retryCount: 0 });
  assert.equal(action.action, actionWithZero.action);
});

// ================================================================
// Tests: task context propagation (the "task" param is used for future context)
// ================================================================

test("determineHealingAction: accepts task context without throwing", () => {
  const action = determineHealingAction({
    error: new Error("ENOSPC"),
    task: { id: "t1", mode: "builder", healing_retry_count: 1 },
  });
  assert.ok(action.action, "should return action without error");
});


// ===========================================================================
// P0: Network error retry behavior — retry_with_backoff, not code repair
// ===========================================================================

test('classifyError: rate limited returns NETWORK category', () => {
  const result = classifyError(new Error('429 Too Many Requests'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'rate_limited');
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 3);
});

test('classifyError: gateway error returns NETWORK category', () => {
  const result = classifyError(new Error('502 Bad Gateway'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'gateway_error');
  assert.equal(result.recoverable, true);
});

test('classifyError: transient network error returns NETWORK category', () => {
  const result = classifyError(new Error('ECONNREFUSED connection refused'));
  assert.equal(result.category, ERROR_CATEGORIES.NETWORK);
  assert.equal(result.code, 'transient_network_error');
  assert.equal(result.recoverable, true);
  assert.equal(result.retry_budget, 2);
});

test('determineHealingAction: rate limited returns retry_with_backoff', () => {
  const action = determineHealingAction({ error: new Error('429 rate limit exceeded') });
  assert.equal(action.action, 'retry_with_backoff');
  assert.equal(action.next_status, 'queued');
  assert.equal(action.compact_context, false);
  assert.equal(action.cleanup_tmp, false);
  assert.ok(action.reason.includes('Network'));
});

test('determineHealingAction: gateway error returns retry_with_backoff', () => {
  const action = determineHealingAction({ error: new Error('503 service unavailable') });
  assert.equal(action.action, 'retry_with_backoff');
  assert.equal(action.next_status, 'queued');
});

test('determineHealingAction: transient network error returns retry_with_backoff', () => {
  const action = determineHealingAction({ error: new Error('ECONNRESET socket hang up') });
  assert.equal(action.action, 'retry_with_backoff');
  assert.equal(action.next_status, 'queued');
});

// ===========================================================================
// P0: Repeated no-result must converge to bounded terminal state
// ===========================================================================

test('determineHealingAction: result_missing within budget retries', () => {
  const action = determineHealingAction({
    error: new Error('result.json missing'),
    retryCount: 0,
  });
  assert.equal(action.action, 'fallback_parse_and_retry');
  assert.equal(action.next_status, 'repairing');
  assert.notEqual(action.reason, '');
});

test('determineHealingAction: result_missing budget exceeded goes to waiting_for_review', () => {
  const action = determineHealingAction({
    error: new Error('result.json missing'),
    retryCount: 1,
  });
  assert.equal(action.action, 'waiting_for_review');
  assert.equal(action.next_status, 'waiting_for_review');
});

test('determineHealingAction: no first output within budget retries', () => {
  const action = determineHealingAction({
    error: new Error('no first output timeout'),
    retryCount: 0,
  });
  assert.equal(action.action, 'compact_and_retry');
  assert.equal(action.next_status, 'repairing');
});

test('determineHealingAction: no first output budget exceeded goes to waiting_for_review', () => {
  const action = determineHealingAction({
    error: new Error('no first output timeout'),
    retryCount: 1,
  });
  assert.equal(action.action, 'waiting_for_review');
  assert.equal(action.next_status, 'waiting_for_review');
});

test('determineHealingAction: no active lock leak after budget exceeded', () => {
  // After budget is exceeded for a result_missing error, the action should
  // NOT request any lock-related state (no cleanup_tmp, no lock reentry).
  const action = determineHealingAction({
    error: new Error('result.json missing'),
    retryCount: 1,
  });
  assert.equal(action.action, 'waiting_for_review');
  assert.equal(action.next_status, 'waiting_for_review');
  assert.equal(action.compact_context, false);
  assert.equal(action.cleanup_tmp, false);
  // The caller must not re-acquire or leak locks when going to review
});

test('determineHealingAction: repeated network failures converge to waiting_for_review', () => {
  // Rate limited has budget 3, so retryCount 3 should trigger review
  const action = determineHealingAction({
    error: new Error('429 rate limit exceeded'),
    retryCount: 3,
  });
  assert.equal(action.action, 'waiting_for_review');
  assert.equal(action.next_status, 'waiting_for_review');
});

test('determineHealingAction: network error within budget does NOT create code repair', () => {
  // Network errors should retry, not enter code repair
  const action = determineHealingAction({
    error: new Error('502 Bad Gateway'),
    retryCount: 0,
  });
  assert.equal(action.action, 'retry_with_backoff');
  assert.notEqual(action.next_status, 'waiting_for_repair');
});
console.log("self-healing-policy tests loaded");
