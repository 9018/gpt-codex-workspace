import test from "node:test";
import assert from "node:assert/strict";

import {
  applyLegacyNoChangeCompatibility,
  normalizeTuiEvidenceToTaskResult,
} from "../../src/task-processing/task-result-normalizer.mjs";

test("normalizes durable TUI evidence into the provider result contract", () => {
  const result = normalizeTuiEvidenceToTaskResult({
    evidence_ready: true,
    result_json: {
      status: "completed",
      summary: "implemented",
      changed_files: ["src/example.mjs"],
      commit: "abc1234",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    },
    collected: { worktree_clean: true },
  }, { id: "task_1" }, { id: "goal_1" }, { id: "session_1" });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "codex_tui_goal");
  assert.equal(result.session_id, "session_1");
  assert.deepEqual(result.changed_files, ["src/example.mjs"]);
  assert.equal(result.verification.passed, true);
});

test("legacy completed no-change results become explicit noops", () => {
  const result = applyLegacyNoChangeCompatibility({
    status: "completed",
    changed_files: [],
    verification: { passed: true },
  });

  assert.equal(result.operation_kind, "noop");
  assert.equal(result.no_mutation, true);
  assert.equal(result.repo_mutated, false);
});
