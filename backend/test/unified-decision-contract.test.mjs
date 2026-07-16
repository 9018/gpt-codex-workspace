import test from 'node:test';
import assert from 'node:assert/strict';

import {
  firstOf,
  normalizeToUnifiedDecision,
} from '../src/codex-unified-decision.mjs';
import {
  UnifiedDecisionInvariantError,
  assertValidUnifiedDecision,
  validateUnifiedDecision,
} from '../src/domain/unified-decision-validator.mjs';

test('firstOf preserves primitive and structured values', () => {
  const values = [
    'verification passed',
    42,
    false,
    ['one'],
    { code: 'ok' },
  ];

  for (const value of values) {
    assert.deepEqual(firstOf(null, undefined, '', value), value);
  }
  assert.equal(firstOf(null, undefined, ''), null);
});

test('unified decision preserves a string reason', () => {
  const decision = normalizeToUnifiedDecision({
    finalizerDecision: {
      status: 'waiting_for_review',
      reason: 'verification passed',
    },
  });

  assert.equal(decision.reason, 'verification passed');
});

test('normalizer emits the canonical v2 envelope with revisions and effects', () => {
  const decision = normalizeToUnifiedDecision({
    finalizerDecision: {
      status: 'completed',
      reason: 'verification passed',
      blocking_passed: true,
      safe_to_auto_advance: true,
    },
    verification: { passed: true, revision: 7 },
    contractVerification: { blocking_passed: true, completion_eligible: true },
    taskResult: {
      integration: { required: false, satisfied: true, terminal: true },
    },
    task: { id: 'task_v2', decision_revision: 4 },
    now: '2026-07-17T09:00:00.000Z',
  });

  assert.equal(decision.schema_version, 2);
  assert.equal(decision.task_id, 'task_v2');
  assert.equal(decision.decision_revision, 5);
  assert.equal(decision.evidence_revision, 7);
  assert.deepEqual(decision.effects.integration, decision.integration_effect);
  assert.deepEqual(decision.effects.goal, decision.goal_effect);
  assert.deepEqual(decision.effects.queue, decision.queue_effect);
  assert.deepEqual(decision.consistency, { valid: true, violations: [] });
});

test('validator rejects contradictory canonical decisions with a typed error', () => {
  const decision = {
    schema_version: 2,
    task_id: 'task_invalid',
    decision_revision: 2,
    evidence_revision: 2,
    status: 'completed',
    reason: 'invalid completion',
    blockers: [],
    repairable_blockers: [],
    requires_review: false,
    requires_repair: false,
    requires_integration: true,
    safe_to_auto_advance: true,
    effects: {
      task: { status: 'completed' },
      goal: { status: 'completed', complete_goal: true },
      queue: { unblock_dependents: true, hold_queue: false },
      workstream: { status: 'completed' },
      integration: { required: true, satisfied: false, terminal: false },
    },
  };

  const validation = validateUnifiedDecision(decision);
  assert.equal(validation.valid, false);
  assert.ok(validation.violations.includes('completed_without_terminal_integration'));
  assert.throws(
    () => assertValidUnifiedDecision(decision),
    (error) => error instanceof UnifiedDecisionInvariantError
      && error.code === 'unified_decision_invariant_failed'
      && error.violations.includes('completed_without_terminal_integration'),
  );
});
