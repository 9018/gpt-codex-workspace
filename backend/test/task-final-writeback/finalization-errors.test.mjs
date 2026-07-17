import test from "node:test";
import assert from "node:assert/strict";

import { UnifiedDecisionInvariantError } from "../../src/domain/unified-decision-validator.mjs";
import { assertValidInputUnifiedDecision } from "../../src/task-finalization/finalization-errors.mjs";

test("assertValidInputUnifiedDecision ignores missing optional unified decisions", () => {
  assert.equal(assertValidInputUnifiedDecision({}), undefined);
  assert.equal(assertValidInputUnifiedDecision({ finalizer_decision: {} }), undefined);
});

test("assertValidInputUnifiedDecision validates direct and nested unified decisions", () => {
  assert.throws(
    () => assertValidInputUnifiedDecision({ unified_decision: { status: "completed" } }),
    (error) => error instanceof UnifiedDecisionInvariantError && error.violations.includes("schema_version_invalid"),
  );

  assert.throws(
    () => assertValidInputUnifiedDecision({ finalizer_decision: { unified_decision: { status: "completed" } } }),
    (error) => error instanceof UnifiedDecisionInvariantError && error.violations.includes("schema_version_invalid"),
  );
});
