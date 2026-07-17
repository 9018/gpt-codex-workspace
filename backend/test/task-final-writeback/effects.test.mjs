import test from "node:test";
import assert from "node:assert/strict";

import { normalizeToUnifiedDecision } from "../../src/codex-unified-decision.mjs";
import {
  buildProgressionDecision,
  mutateFinalTaskState,
  runCompletedTaskAutoStart,
  runFinalizationPostStateEffects,
  runPostFinalizationEffects,
  writeGoalFinalizationArtifacts,
} from "../../src/task-finalization/task-finalization-effects.mjs";

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

test("writeGoalFinalizationArtifacts writes result md, goal message, and fallback result json", async () => {
  const workspaceWrites = [];
  const messages = [];
  const files = [];
  const result = await writeGoalFinalizationArtifacts({
    store: { state: {} },
    config: {},
    workspace: { root: "/workspace" },
    workspaceFiles: { result_md: ".gptwork/goals/goal_artifacts/result.md" },
    context: { trace_id: "ctx" },
    goal: { id: "goal_artifacts", workspace_id: "hosted-default" },
    task: { id: "task_artifacts" },
    taskStatus: "waiting_for_review",
    taskResult: { summary: "needs review" },
    summary: "needs review",
    doneAt: "2026-07-17T12:00:00.000Z",
    resultJsonPath: null,
    writeWorkspaceTextInternalFn: async (...args) => workspaceWrites.push(args),
    appendGoalMessageFn: async (...args) => messages.push(args),
    writeFileFn: async (...args) => files.push(args),
    buildFallbackResultJsonFn: ({ taskStatus, taskResult, summary }) => ({ taskStatus, taskResult, summary }),
  });

  assert.equal(result.wrote_result_md, true);
  assert.equal(workspaceWrites[0][3], ".gptwork/goals/goal_artifacts/result.md");
  assert.match(workspaceWrites[0][4], /Waiting for review at: 2026-07-17T12:00:00.000Z/);
  assert.equal(messages[0][2].goal_id, "goal_artifacts");
  assert.match(messages[0][2].content, /Waiting for review task task_artifacts/);
  assert.equal(files[0][0], "/workspace/.gptwork/goals/goal_artifacts/result.json");
  assert.equal(JSON.parse(files[0][1]).taskStatus, "waiting_for_review");
});

test("mutateFinalTaskState projects task, goal, queue, and progression commands atomically", async () => {
  const reconciled = [];
  const store = {
    state: {
      tasks: [{ id: "task_mutate", status: "running", logs: [] }],
      goals: [{ id: "goal_mutate", status: "running", title: "Goal mutate" }],
      goal_queue: [
        { queue_id: "current", task_id: "task_mutate", goal_id: "goal_mutate", status: "running" },
        {
          queue_id: "dependent",
          goal_id: "goal_next",
          depends_on_goal_id: "goal_mutate",
          status: "blocked",
          blocked_reason: "depends_on_goal goal_mutate",
        },
      ],
      activities: [],
    },
    async mutate(fn) {
      return fn(this.state);
    },
  };

  const result = await mutateFinalTaskState({
    store,
    task: { id: "task_mutate", decision_revision: 3 },
    taskStatus: "completed",
    taskResult: {
      reviewer_decision: { status: "accepted" },
      integration: { status: "already_integrated" },
      closure_decision: { status: "auto_completed_clean" },
      unified_decision: { queue_effect: { unblock_dependents: true } },
    },
    doneAt: "2026-07-17T13:00:00.000Z",
    cr: {},
    config: {},
    goal: { id: "goal_mutate" },
    progressionDecision: { revision: 7 },
    reconcileProgressionCommandsInStateFn: ({ state, decisions, now }) => {
      reconciled.push({ state, decisions, at: now() });
      return { applied: decisions.length };
    },
  });

  assert.equal(result.task.status, "completed");
  assert.equal(result.task.decision_revision, 7);
  assert.equal(store.state.goals[0].status, "completed");
  assert.equal(store.state.goal_queue[0].status, "completed");
  assert.equal(store.state.goal_queue[1].status, "ready");
  assert.equal(store.state.activities.at(-1).type, "queue.dependency_reconciled");
  assert.deepEqual(result.progression_commands, { applied: 1 });
  assert.equal(reconciled[0].at, "2026-07-17T13:00:00.000Z");
});

test("runFinalizationPostStateEffects applies post-state effects and returns receipt data", async () => {
  const calls = [];
  const taskResult = { kind: "success" };
  const receipt = await runFinalizationPostStateEffects({
    store: { state: { goal_queue: [] } },
    config: { defaultWorkspaceRoot: "/workspace" },
    task: { id: "task_post", workstream_id: "ws_1" },
    finalTask: { id: "task_post", status: "completed" },
    goal: { id: "goal_post", workstream_id: "ws_1" },
    taskStatus: "completed",
    taskResult,
    summary: "done",
    doneAt: "2026-07-17T14:00:00.000Z",
    workspace: { root: "/workspace" },
    workspaceFiles: { result_md: ".gptwork/goals/goal_post/result.md" },
    context: { trace_id: "ctx" },
    repoLockPath: "/tmp/repo.lock",
    resultJsonPath: null,
    progressionReport: { applied: 2 },
    github: { syncTask: async () => ({ ok: true, updated: true }) },
    updateWorkstreamContextFromCompletedTaskFn: async () => {
      calls.push("workstream");
      return { applied: true };
    },
    releaseFinalizationRepoLockFn: async () => calls.push("lock"),
    loadRestartMarkerFn: async () => null,
    releaseRepoLockFn: async () => null,
    updateGoalStatusFn: async () => calls.push("goal-status"),
    writeWorkspaceTextInternalFn: async () => calls.push("result-md"),
    appendGoalMessageFn: async () => calls.push("goal-message"),
    writeFileFn: async () => calls.push("result-json"),
    buildFallbackResultJsonFn: ({ taskStatus }) => ({ taskStatus }),
    autoStartNextOnTaskCompletedFn: async () => {
      calls.push("auto-start");
      return { auto_started: true };
    },
    propagateRepairChildCompletionFn: async () => calls.push("repair-propagation"),
    handleRepairCompletionFn: async () => null,
    runPostFinalizationEffectsFn: async ({ taskResult }) => {
      calls.push("post-effects");
      taskResult.github_sync = { ok: true };
      return { github_sync: { ok: true }, goal_sweep: { ok: true, count: 0 } };
    },
    logFn: () => {},
    goalStatusFromReconciliationFn: () => "completed",
    projectGoalStatusForFinalizedTaskFn: () => "completed",
  });

  assert.deepEqual(calls, [
    "workstream",
    "lock",
    "goal-status",
    "result-md",
    "goal-message",
    "result-json",
    "auto-start",
    "repair-propagation",
    "post-effects",
  ]);
  assert.equal(taskResult.workstream_context_update.applied, true);
  assert.deepEqual(receipt, {
    task_id: "task_post",
    status: "completed",
    kind: "success",
    auto_start: { auto_started: true },
    progression_commands: { applied: 2 },
  });
});
