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

console.log("self-healing-policy tests loaded");
