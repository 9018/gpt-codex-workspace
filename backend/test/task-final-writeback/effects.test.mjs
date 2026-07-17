import test from "node:test";
import assert from "node:assert/strict";

import { normalizeToUnifiedDecision } from "../../src/codex-unified-decision.mjs";
import { buildProgressionDecision, runCompletedTaskAutoStart, runPostFinalizationEffects } from "../../src/task-finalization/task-finalization-effects.mjs";

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

test("runPostFinalizationEffects records github sync and non-blocking stale sweep", async () => {
  const logs = [];
  const taskResult = {};
  const result = await runPostFinalizationEffects({
    store: { state: {} },
    task: { id: "task_effect_post" },
    taskResult,
    github: {
      syncTask: async (task) => ({ ok: true, issue: 42, updated: true, comment_posted: task.id === "task_effect_post" }),
    },
    convergeStaleGoalStatusesFn: async () => [{ goal_id: "goal_stale" }],
    logFn: (line) => logs.push(line),
  });

  assert.deepEqual(taskResult.github_sync, { ok: true, issue: 42, updated: true, comment_posted: true });
  assert.equal(result.github_sync.ok, true);
  assert.equal(result.goal_sweep.count, 1);
  assert.match(logs[0], /goal sweep: converged 1 stale goal/);

  const failed = await runPostFinalizationEffects({
    store: { state: {} },
    task: { id: "task_failed_post" },
    taskResult: {},
    github: { syncTask: async () => { throw new Error("github down"); } },
    convergeStaleGoalStatusesFn: async () => { throw new Error("sweep down"); },
  });
  assert.equal(failed.github_sync.ok, false);
  assert.equal(failed.goal_sweep.ok, false);
});

test("runCompletedTaskAutoStart starts only completed tasks and captures failures", async () => {
  const calls = [];
  const started = await runCompletedTaskAutoStart({
    taskStatus: "completed",
    store: { state: {} },
    config: { defaultWorkspaceRoot: "/workspace" },
    task: { id: "task_done" },
    autoStartNextOnTaskCompletedFn: async (_store, _config, task) => {
      calls.push(task.id);
      return { auto_started: true, task_id: "task_next" };
    },
  });
  assert.deepEqual(calls, ["task_done"]);
  assert.equal(started.auto_started, true);

  const skipped = await runCompletedTaskAutoStart({
    taskStatus: "waiting_for_review",
    task: { id: "task_review" },
    autoStartNextOnTaskCompletedFn: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(skipped, null);

  const failed = await runCompletedTaskAutoStart({
    taskStatus: "completed",
    task: { id: "task_done" },
    autoStartNextOnTaskCompletedFn: async () => {
      throw new Error("queue unavailable");
    },
  });
  assert.deepEqual(failed, { auto_started: false, error: "queue unavailable", details: [] });
});
