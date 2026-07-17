import test from "node:test";
import assert from "node:assert/strict";

import { applyRepairMetadata, taskWithRepairContext } from "../../src/task-processing/task-repair-context.mjs";
import { statusForHealingAction } from "../../src/task-processing/task-healing-controller.mjs";
import { applySuccessfulDeliveryRecovery } from "../../src/task-processing/task-delivery-recovery.mjs";

test("repair context preserves root lineage and resolved worktree", () => {
  const args = applyRepairMetadata({}, { root_task_id: "root", repair_attempt: 2, ignored: true });
  assert.deepEqual(args, { root_task_id: "root", repair_attempt: 2 });

  const task = taskWithRepairContext({ id: "task" }, {
    repo_id: "repo",
    task_worktree_path: "/tmp/worktree",
    worktree_lifecycle: { branch_name: "gptwork/task/task" },
  });
  assert.equal(task.worktree.path, "/tmp/worktree");
  assert.equal(task.worktree.branch, "gptwork/task/task");
  assert.equal(task.repo_id, "repo");
});

test("healing retry actions return to the queue", () => {
  assert.equal(statusForHealingAction("retry_with_backoff"), "queued");
  assert.equal(statusForHealingAction("waiting_for_review"), "waiting_for_review");
});

test("successful already-integrated recovery is terminal and deduplicates warnings", () => {
  const result = applySuccessfulDeliveryRecovery({
    summary: "missing result",
    warnings: ["existing"],
    acceptance_findings: [{ code: "commit_missing", severity: "major", message: "missing" }],
  }, {
    reason: "already_integrated",
    commit: "abc1234",
    warnings: ["existing", "integrated"],
  });

  assert.equal(result.integration.status, "already_integrated");
  assert.equal(result.convergence.nextStatus, "completed");
  assert.deepEqual(result.warnings, ["existing", "Delivery already integrated: existing", "integrated"]);
  assert.equal(result.acceptance_findings[0].resolved, true);
});
