import test from "node:test";
import assert from "node:assert/strict";

import { normalizeToUnifiedDecision } from "../../src/codex-unified-decision.mjs";
import { buildProgressionDecision } from "../../src/task-finalization/task-finalization-effects.mjs";

test("buildProgressionDecision normalizes unified decision revisions and integration target", () => {
  const unifiedDecision = normalizeToUnifiedDecision({
    finalizerDecision: {
      status: "completed",
      reason: "terminal_evidence_satisfied",
      blockers: [],
      repairable_blockers: [],
      safe_to_auto_advance: true,
      blocking_passed: true,
      integration_effect: { required: false, status: "satisfied", satisfied: true, terminal: true },
      goal_effect: { status: "completed", complete_goal: true, safe_to_auto_advance: true },
      queue_effect: { status: "completed", unblock_dependents: true, hold_queue: false },
    },
    taskResult: {
      status: "completed",
      summary: "done",
      changed_files: ["backend/src/app.mjs"],
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      acceptance_gate: { passed: true },
      commit: "abc123",
    },
  });

  const decision = buildProgressionDecision({
    task: { id: "task_effects", goal_id: "goal_fallback", decision_revision: 11 },
    goal: { id: "goal_effects" },
    doneAt: "2026-07-17T11:00:00.000Z",
    config: { defaultBranch: "release" },
    taskResult: {
      unified_decision: unifiedDecision,
      commit: "abc123",
      integration: { status: "not_required" },
      verification: { revision: 22 },
      finalizer_decision: {
        worktree_effect: { cleanup_required: true, worktree_path: "/repo/.worktrees/task_effects" },
      },
    },
  });

  assert.equal(decision.task_id, "task_effects");
  assert.equal(decision.goal_id, "goal_effects");
  assert.equal(decision.revision, 11);
  assert.equal(decision.decision_revision, 11);
  assert.equal(decision.evidence_revision, 22);
  assert.equal(decision.normalized_at, "2026-07-17T11:00:00.000Z");
  assert.equal(decision.integration.source_commit, "abc123");
  assert.equal(decision.integration.target_branch, "release");
  assert.equal(decision.worktree_effect.cleanup_required, true);
});

test("buildProgressionDecision returns null without a unified decision", () => {
  assert.equal(buildProgressionDecision({ task: { id: "task_none" }, taskResult: {} }), null);
});
