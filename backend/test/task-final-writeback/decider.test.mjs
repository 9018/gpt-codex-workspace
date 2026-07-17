import test from "node:test";
import assert from "node:assert/strict";

import { decideTaskFinalization } from "../../src/task-finalization/task-final-state-decider.mjs";
import { decideTaskFinalState } from "../../src/task-finalizer.mjs";

function acceptedEvidence() {
  return {
    current_status: "completed",
    codex_result: {
      status: "completed",
      kind: "codex_executed",
      changed_files: ["backend/src/task-finalization/task-final-state-decider.mjs"],
      commit: "abc123",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      contract_verification: {
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
        blockers: [],
      },
      integration: { status: "merged", merged: true },
      acceptance_findings: [],
    },
    verification: { passed: true, findings: [] },
    acceptance: { passed: true, status: "accepted" },
    contract_verification: {
      blocking_passed: true,
      completion_eligible: true,
      requires_review: false,
      blockers: [],
    },
    integration: { required: true, status: "merged", merged: true },
    repair_budget: { attempts_remaining: 1 },
  };
}

test("decideTaskFinalization exposes the Plan 08 finalization decider entrypoint", () => {
  const evidence = acceptedEvidence();
  const finalizationDecision = decideTaskFinalization(evidence);
  const legacyDecision = decideTaskFinalState(evidence);

  assert.equal(finalizationDecision.status, legacyDecision.status);
  assert.equal(finalizationDecision.reason, legacyDecision.reason);
  assert.equal(finalizationDecision.safe_to_auto_advance, legacyDecision.safe_to_auto_advance);
  assert.equal(finalizationDecision.unified_decision.status, legacyDecision.unified_decision.status);
  assert.equal(finalizationDecision.status, "completed");
});
