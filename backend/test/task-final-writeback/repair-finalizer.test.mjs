import test from "node:test";
import assert from "node:assert/strict";

import { applyNoChangeRepairCompletionSummary } from "../../src/task-finalization/repair-finalizer.mjs";

test("applyNoChangeRepairCompletionSummary annotates eligible no-change repair completion", () => {
  const taskResult = applyNoChangeRepairCompletionSummary({
    task: { id: "repair_task", parent_task_id: "parent_task", title: "Repair existing state" },
    taskResult: {
      kind: "repair_noop",
      repair_noop: true,
      changed_files: [],
      verification: { passed: true },
      acceptance_gate: { passed: true },
      integration: { status: "not_required" },
      no_change_repair_evidence: {
        affected_files: ["backend/src/task-final-writeback.mjs"],
        files_match_canonical: true,
        diff_empty: true,
      },
    },
  });

  assert.equal(taskResult.no_change_repair_completion.completion_eligible, true);
  assert.equal(taskResult.no_change_repair_completion_summary.changed_files_empty_acceptable, true);
  assert.equal(taskResult.no_change_repair_completion_summary.reason, "no_change_repair_evidence_satisfied");
  assert.match(taskResult.no_change_repair_completion_summary.explanation, /changed_files=\[\] is acceptable/);
});

test("applyNoChangeRepairCompletionSummary leaves non-repair results unchanged", () => {
  const taskResult = { changed_files: ["backend/src/app.mjs"], summary: "normal change" };

  assert.equal(applyNoChangeRepairCompletionSummary({ task: { id: "task" }, taskResult }), taskResult);
});
