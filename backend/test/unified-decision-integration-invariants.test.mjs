import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDecisionConsistency,
  normalizeToUnifiedDecision,
} from '../src/codex-unified-decision.mjs';

test('completed cannot coexist with unsatisfied required integration', () => {
  const decision = normalizeToUnifiedDecision({
    finalizerDecision: {
      status: 'completed',
      reason: 'provider reported success',
      blocking_passed: true,
      safe_to_auto_advance: true,
    },
    taskResult: {
      changed_files: ['src/index.mjs'],
      verification: { passed: true },
      integration: {
        required: true,
        satisfied: false,
        terminal: false,
        status: 'pending',
      },
    },
  });

  assert.equal(decision.status, 'waiting_for_integration');
  assert.equal(decision.requires_integration, true);
  assert.equal(decision.safe_to_auto_advance, false);
  assert.equal(decision.integration_effect.required, true);
  assert.equal(decision.integration_effect.satisfied, false);
  assert.equal(decision.integration_effect.terminal, false);
  assert.equal(decision.queue_effect.hold_queue, true);
  assert.equal(checkDecisionConsistency(decision).consistent, true);
});

test('completed requires terminal integration, not only satisfied integration', () => {
  const decision = normalizeToUnifiedDecision({
    finalizerDecision: {
      status: 'completed',
      blocking_passed: true,
      safe_to_auto_advance: true,
    },
    taskResult: {
      changed_files: ['src/index.mjs'],
      verification: { passed: true },
      integration: {
        required: true,
        satisfied: true,
        terminal: false,
        status: 'applying',
      },
    },
  });

  assert.equal(decision.status, 'waiting_for_integration');
  assert.equal(decision.safe_to_auto_advance, false);
  assert.equal(decision.integration_effect.terminal, false);
});
