import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFailedIntegrationCompletion,
  applySuccessfulIntegrationCompletion,
  classifyFinalizationIntegrationResult,
} from "../../src/task-finalization/integration-finalizer.mjs";

test("classifyFinalizationIntegrationResult exposes terminal and repairable integration decisions", () => {
  assert.deepEqual(classifyFinalizationIntegrationResult({ ok: true, status: "merged", merged: true }), {
    kind: "terminal_completed",
    task_status: "completed",
    should_attempt_auto_completion: false,
    should_attempt_repair: false,
  });
  assert.deepEqual(classifyFinalizationIntegrationResult({ ok: false, status: "conflict" }), {
    kind: "repairable_failure",
    task_status: null,
    should_attempt_auto_completion: false,
    should_attempt_repair: true,
  });
});

test("integration completion helpers preserve finalizer-facing task result shape", () => {
  const successful = applySuccessfulIntegrationCompletion({
    taskResult: { commit: "task-commit", acceptance_findings: [] },
    integrationResult: { status: "branch_pushed", commit: "branch-commit" },
    autoCompletion: { completed: true, commit: "merged-commit", verification_report: { passed: true } },
  });

  assert.equal(successful.integration.status, "merged");
  assert.equal(successful.integration.auto_completed, true);
  assert.equal(successful.commit, "merged-commit");
  assert.equal(successful.needs_integration, false);

  const failed = applyFailedIntegrationCompletion({
    taskResult: { acceptance_findings: [] },
    autoCompletion: { reason: "dirty", blockers: [{ message: "repo dirty" }] },
  });

  assert.equal(failed.requires_review, true);
  assert.match(failed.reason, /auto_integration_completion_failed/);
  assert.equal(failed.acceptance_findings[0].code, "auto_integration_completion_failed");
});
