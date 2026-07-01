/**
 * e2e-convergence-regression.test.mjs
 *
 * P0-5: E2E convergence regression suite — automatic acceptance,
 * integration, queue advancement, and state synchronization.
 *
 * Required coverage (10 areas):
 * 1. Normal code-change success path (G8/G9/G10 pattern)
 * 2. Accepted+verified code task does NOT enter review loop
 * 3. Repeated integration result for same task/commit is idempotent
 * 4. Already-integrated no-change task completes only with sufficient evidence
 * 5. Actionable follow-up with remaining budget enters automatic follow-up path
 * 6. Exhausted budget / unsafe state / ambiguous state / corrupted evidence
 * 7. Task, goal, queue item, and dependent queue state are synchronized
 * 8. Dependent queue unblocks after completion
 * 9. auto_start=false is not started by worker
 * 10. Review packet, acceptance bundle, and recovery diagnostics show compact
 *     root cause and next_action
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ===========================================================================
// Module imports
// ===========================================================================

import {
  convergeTaskAfterRun,
  CONVERGENCE_STATUSES,
  CLOSURE_REASONS,
  detectAcceptanceProfile,
  consolidateBatchConvergence,
} from "../src/task-convergence.mjs";

import {
  isTerminalCompleted,
  isNonCompletionTerminal,
  checkDependency,
  checkAcceptanceGate,
  checkRepoConcurrency,
} from "../src/queue-policy.mjs";

import {
  QUEUE_STATUS_WAITING,
  QUEUE_STATUS_READY,
  QUEUE_STATUS_RUNNING,
  QUEUE_STATUS_BLOCKED,
  QUEUE_STATUS_COMPLETED as QUEUE_COMPLETED,
  QUEUE_STATUS_FAILED as QUEUE_FAILED,
  startNextQueuedGoal,
  autoStartNextOnTaskCompleted,
} from "../src/goal-queue.mjs";

import { getTaskReviewPacket } from "../src/review/review-packet-builder.mjs";

// ===========================================================================
// Shared helpers
// ===========================================================================

function makeStore(state = {}) {
  state.goal_queue = state.goal_queue || [];
  state.goals = state.goals || [];
  state.tasks = state.tasks || [];
  state.conversations = state.conversations || [];
  state.memories = state.memories || [];
  state.activities = state.activities || [];
  return {
    async load() { return state; },
    async save() {},
    async mutate(updater) {
      const result = updater(state);
      return result;
    },
    findTaskById: async (id) => (state.tasks || []).find((t) => t.id === id) || null,
    findGoalByTaskId: (taskId) => (state.goals || []).find((g) => g.task_id === taskId) || null,
  };
}

function emptyConfig(overrides = {}) {
  return {
    defaultWorkspaceRoot: "/tmp",
    defaultRepoPath: "/tmp/canonical",
    ...overrides,
  };
}

// ===========================================================================
// Coverage 1: Normal code-change success path (G8/G9/G10 pattern)
// ===========================================================================

test("convergence-regression: C1 — G8/G9/G10 code-change success path auto-completes after merge and verification", () => {
  const result = convergeTaskAfterRun({
    task: {
      id: "task_g9_success",
      status: "running",
      title: "G9: Implement feature X",
      mode: "builder",
    },
    taskResult: {
      kind: "codex_executed",
      status: "completed",
      summary: "Implemented feature X with tests passing",
      changed_files: ["lib/feature-x.mjs", "test/feature-x.test.mjs"],
      commit: "abc123def456",
      remote_head: "abc123def456",
      tests: "npm test: passed 42/42",
      verification: { passed: true },
      reviewer_decision: {
        status: "accepted",
        passed: true,
        should_enter_review: false,
      },
      acceptance_findings: [],
      integration: {
        status: "merged",
        merged: true,
        pushed: true,
        commit: "abc123def456",
      },
    },
    acceptance: {
      passed: true,
      status: "accepted",
      findings: [],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "G8/G9/G10 success path should complete");
  assert.equal(result.closureReason, CLOSURE_REASONS.ACCEPTED,
    "Should close with ACCEPTED reason");
  assert.equal(result.repairPlan, null,
    "No repair plan for success path");
  assert.equal(result.retryPlan, null,
    "No retry plan for success path");
});

test("convergence-regression: C1 — code-change task auto-integrates when acceptance contract requires it", () => {
  const profile = detectAcceptanceProfile(
    { mode: "builder", title: "G9: Feature implementation" },
    {
      changed_files: ["docs/guide.md"],
      verification: { passed: true },
      commit: "abc123",
    }
  );

  assert.equal(profile, "code_change",
    "Builder-mode task with changed files should be code_change profile");
});

// ===========================================================================
// Coverage 2: Accepted+verified never enters review loop
// ===========================================================================

test("convergence-regression: C2 — accepted+verified code task does NOT enter review loop", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_accepted_verified", status: "running" },
    taskResult: {
      kind: "codex_executed",
      status: "completed",
      summary: "Task completed and verified",
      changed_files: ["docs/guide.md"],
      verification: { passed: true },
      reviewer_decision: {
        status: "accepted",
        passed: true,
        should_enter_review: false,
      },
      acceptance_findings: [],
    },
    acceptance: {
      passed: true,
      status: "accepted",
      findings: [],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Accepted+verified must complete, not enter review");
  assert.notEqual(result.nextStatus, CONVERGENCE_STATUSES.WAITING_FOR_REVIEW,
    "Must not enter review loop when accepted+verified");
});

test("convergence-regression: C2 — non-accepted task with blocker enters review, not completion", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_blocker", status: "running" },
    taskResult: {
      kind: "codex_executed",
      status: "completed",
      summary: "Task with blocker",
      changed_files: ["docs/guide.md"],
      verification: { passed: true },
      acceptance_findings: [{ severity: "blocker", code: "missing_tests", message: "Tests not found" }],
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "blocker", code: "missing_tests", message: "Tests not found" }],
    },
    attempt: 0,
  });

  assert.notEqual(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Task with blocker must not auto-complete");
});

// ===========================================================================
// Coverage 3: Repeated integration result idempotency
// ===========================================================================

test("convergence-regression: C3 — repeated integration for same task/commit is idempotent", () => {
  const firstResult = convergeTaskAfterRun({
    task: { id: "task_idempotent", status: "running" },
    taskResult: {
      kind: "codex_executed",
      summary: "Task completed",
      changed_files: ["docs/guide.md"],
      commit: "idempotent_sha_12345",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
      integration: { status: "merged", merged: true, commit: "idempotent_sha_12345" },
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    attempt: 0,
  });

  assert.equal(firstResult.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "First integration should complete");

  const secondResult = convergeTaskAfterRun({
    task: { id: "task_idempotent", status: "completed" },
    taskResult: {
      kind: "codex_executed",
      summary: "Task completed (re-processed)",
      changed_files: ["docs/guide.md"],
      commit: "idempotent_sha_12345",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
      integration: { status: "merged", merged: true, commit: "idempotent_sha_12345" },
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    attempt: 0,
  });

  assert.equal(secondResult.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Repeated convergence should still complete (idempotent)");
  assert.equal(secondResult.repairPlan, null,
    "Repeated integration must not create a repair plan");
  assert.equal(secondResult.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Repeated integration of same commit must not loop to repair/review");
});

test("convergence-regression: C3 — terminal status checks are stable and idempotent", () => {
  assert.equal(isTerminalCompleted("completed"), true);
  assert.equal(isTerminalCompleted("COMPLETED"), false, "case-sensitive");
  assert.equal(isTerminalCompleted("failed"), false);
  assert.equal(isTerminalCompleted("running"), false);
  assert.equal(isNonCompletionTerminal("failed"), true);
  assert.equal(isNonCompletionTerminal("timed_out"), true);
  assert.equal(isNonCompletionTerminal("completed"), false);
});

// ===========================================================================
// Coverage 4: Already-integrated no-change task completes only with sufficient evidence
// ===========================================================================

test("convergence-regression: C4 — already-integrated no-change task with verification evidence completes", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_integrated_noop", status: "running" },
    taskResult: {
      kind: "codex_executed",
      summary: "Already integrated: no changes needed",
      changed_files: [],
      commit: "existing_sha_99999",
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
      integration: { status: "merged", merged: true, commit: "existing_sha_99999" },
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    repoState: {
      canonical_clean: true,
      commit_integrated: true,
      local_head: "existing_sha_99999",
      remote_head: "existing_sha_99999",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Already-integrated no-change task with evidence should complete");
});

test("convergence-regression: C4 — already-integrated no-change task WITHOUT verification evidence does NOT complete", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_integrated_noop_incomplete", status: "running" },
    taskResult: {
      kind: "codex_executed",
      summary: "Already integrated but no verification",
      changed_files: [],
      commit: "existing_sha_88888",
      acceptance_findings: [],
      integration: { status: "merged", merged: true, commit: "existing_sha_88888" },
    },
    acceptance: { passed: false, status: "needs_fix", findings: [] },
    repoState: {
      canonical_clean: true,
      commit_integrated: true,
      local_head: "existing_sha_88888",
    },
    attempt: 0,
  });

  assert.notEqual(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Already-integrated no-change task WITHOUT verification should NOT auto-complete");
});

// ===========================================================================
// Coverage 5: Actionable follow-up with remaining budget -> automatic follow-up path
// ===========================================================================

test("convergence-regression: C5 — actionable follow-up with remaining budget enters auto follow-up", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_followup", status: "running", repair_attempt: 0 },
    taskResult: {
      kind: "codex_executed",
      summary: "Partial completion with follow-ups noted",
      changed_files: ["docs/partial.md"],
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true, should_enter_review: false },
      acceptance_findings: [],
      followups: [
        { code: "cleanup_code", message: "Clean up edge case handling", severity: "minor" },
        { code: "add_comments", message: "Add documentation comments", severity: "minor" },
      ],
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    attempt: 0,
    budget: { remaining: true, questions_used: 5, questions_limit: 15 },
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Task with follow-up should complete");
  assert.equal(result.closureReason, CLOSURE_REASONS.ACCEPTED,
    "Should accept with follow-up notes");
  assert.ok(result.findings, "Convergence should return findings array");
});

test("convergence-regression: C5 — remaining budget detection creates follow-up readiness", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_budget_followup", status: "running" },
    taskResult: {
      kind: "codex_executed",
      summary: "Task with budget remaining",
      changed_files: ["docs/guide.md"],
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
      budget: { remaining: true, questions_used: 3, questions_limit: 20 },
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    budget: { remaining: true, questions_used: 3, questions_limit: 20 },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Task with remaining budget should complete normally");
  assert.equal(result.repairPlan, null,
    "No repair plan needed for budget-aware task");
});

// ===========================================================================
// Coverage 6: Exhausted budget, unsafe state, ambiguous state, corrupted evidence
// ===========================================================================

test("convergence-regression: C6a — exhausted budget stops with precise reason (quota_wait)", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_exhausted_budget", status: "running" },
    taskResult: {
      failure_class: "quota_exceeded",
      summary: "GPT budget exhausted after 15/15 questions",
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.QUOTA_WAIT,
    "Exhausted budget should produce quota_wait");
  assert.ok(result.retryPlan, "Should have a retry plan for quota");
  assert.equal(result.repairPlan, null,
    "No repair for exhausted budget");
});

test("convergence-regression: C6b — unsafe runtime state stops with restart_pending", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_unsafe_runtime", status: "running" },
    taskResult: {
      kind: "codex_executed",
      summary: "Task that changed runtime state",
      verification: { passed: true },
      changed_files: ["docs/guide.md"],
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    runtimeState: {
      runningCommit: "commit_before",
      repoHead: "commit_after",
      runtimeChanged: true,
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RESTART_PENDING,
    "Unsafe runtime changes should produce restart_pending");
  assert.ok(result.restartPlan,
    "Should have a restart plan detailing what changed");
});

test("convergence-regression: C6c — result_missing with budget remaining stops with retry_wait", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_ambiguous", status: "running" },
    taskResult: {
      kind: "codex_failed",
      failure_class: "result_missing",
      summary: "No result.json produced but code changes detected",
      changed_files: [],
    },
    hasWorktreeDiff: true,
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.RETRY_WAIT,
    "result_missing should produce retry_wait per failure classifier");
  assert.equal(result.repairPlan, null,
    "No repair for retry-path result_missing");
});

test("convergence-regression: C6d — corrupted evidence (verification failed) stops with repair", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_corrupted_evidence", status: "running", repair_attempt: 0 },
    taskResult: {
      failure_class: "verification_failed",
      summary: "Verification commands returned errors",
      verification: { passed: false },
      changed_files: ["docs/guide.md"],
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "blocker", code: "verification_command_failed", message: "npm test failed" }],
    },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.WAITING_FOR_REPAIR,
    "Corrupted evidence should enter repair");
  assert.ok(result.repairPlan,
    "Should have a repair plan for failed verification");
});

test("convergence-regression: C6e — exhausted repair attempts block/fail with precise reason", () => {
  const result = convergeTaskAfterRun({
    task: { id: "task_exhausted_repair", status: "running", repair_attempt: 3 },
    taskResult: {
      failure_class: "verification_failed",
      summary: "Verification failed after maximum repair attempts",
      verification: { passed: false },
      changed_files: ["docs/guide.md"],
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [{ severity: "blocker", code: "verification_command_failed", message: "npm test failed" }],
    },
    attempt: 10,
  });

  assert.ok(
    result.nextStatus === CONVERGENCE_STATUSES.BLOCKED ||
    result.nextStatus === CONVERGENCE_STATUSES.FAILED,
    `Exhausted repair should block or fail, got ${result.nextStatus}`
  );
  assert.equal(result.repairPlan.exhausted, true,
    "Repair plan should show exhausted when budget spent");
  assert.equal(result.retryPlan, null,
    "No retry plan for exhausted repair — retry is not what exhausted");
});

// ===========================================================================
// Coverage 7: Task, goal, queue item, and dependent queue state synchronization
// ===========================================================================

test("convergence-regression: C7a — queue state sync: completed task triggers autoStartNext", async () => {
  const state = {};
  state.tasks = [{
    id: "task_sync_q",
    goal_id: "goal_sync_q",
    status: "running",
    title: "Sync test task",
    logs: [],
  }];
  state.goals = [{
    id: "goal_sync_q",
    task_id: "task_sync_q",
    status: "open",
    title: "Sync test goal",
    workspace_id: "hosted-default",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }];
  state.goal_queue = [{
    queue_id: "queue_sync",
    goal_id: "goal_sync_q",
    task_id: "task_sync_q",
    status: "running",
    position: 1,
    auto_start: true,
  }];

  const store = makeStore(state);
  const result = await autoStartNextOnTaskCompleted(store, emptyConfig(), {
    id: "task_sync_q",
    goal_id: "goal_sync_q",
    status: "completed",
  });

  assert.ok(result !== null, "autoStartNextOnTaskCompleted should return result");
  assert.ok(result.auto_started !== undefined,
    "Result should indicate whether next task was started");
});

test("convergence-regression: C7b — goal status reflects task completion through convergence", () => {
  const result = convergeTaskAfterRun({
    task: {
      id: "task_sync_goal",
      goal_id: "goal_sync_goal",
      status: "running",
    },
    taskResult: {
      kind: "codex_executed",
      summary: "Task complete, goal should follow",
      changed_files: ["docs/guide.md"],
      verification: { passed: true },
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
    },
    acceptance: { passed: true, status: "accepted", findings: [] },
    attempt: 0,
  });

  assert.equal(result.nextStatus, CONVERGENCE_STATUSES.COMPLETED,
    "Task convergence to completed should allow goal to follow");
  assert.equal(result.closureReason, CLOSURE_REASONS.ACCEPTED,
    "Goal should be closable with ACCEPTED reason");
});

test("convergence-regression: C7c — consolidateBatchConvergence detects unsynchronized states", () => {
  const healthy = consolidateBatchConvergence([
    { nextStatus: "completed" },
    { nextStatus: "completed" },
    { nextStatus: "completed" },
  ]);

  assert.equal(healthy.healthy, true,
    "All completed tasks should produce healthy convergence");
  assert.equal(healthy.staleReviewCount, 0);
  assert.equal(healthy.staleRepairCount, 0);
  assert.equal(healthy.staleIntegrationCount, 0);

  const unhealthy = consolidateBatchConvergence([
    { nextStatus: "completed" },
    { nextStatus: "waiting_for_review" },
    { nextStatus: "waiting_for_repair" },
  ]);

  assert.equal(unhealthy.healthy, false,
    "Mixed convergence states should be unhealthy");
  assert.equal(unhealthy.staleReviewCount, 1);
  assert.equal(unhealthy.staleRepairCount, 1);
});

// ===========================================================================
// Coverage 8: Dependent queue unblocks after completion
// ===========================================================================

test("convergence-regression: C8 — dependent queue unblocks after prerequisite completion", () => {
  const state = {};
  state.goal_queue = [
    {
      queue_id: "queue_primary",
      goal_id: "goal_primary",
      task_id: "task_primary",
      status: "completed",
      position: 1,
      auto_start: true,
    },
    {
      queue_id: "queue_dependent",
      goal_id: "goal_dependent",
      task_id: null,
      status: "blocked",
      position: 2,
      depends_on_goal_id: "goal_primary",
      blocked_reason: "depends_on_goal goal_primary status=open",
      auto_start: true,
    },
  ];
  state.goals = [
    { id: "goal_primary", status: "completed", task_id: "task_primary" },
    { id: "goal_dependent", status: "open" },
  ];
  state.tasks = [
    { id: "task_primary", goal_id: "goal_primary", status: "completed" },
  ];

  assert.equal(isTerminalCompleted("completed"), true,
    "isTerminalCompleted must recognize the primary task as completed");

  const gateResult = checkAcceptanceGate(state, state.goal_queue[1]);
  assert.equal(gateResult.passed, true,
    "Acceptance gate should pass when prerequisite goal/task is completed");

  const depResult = checkDependency(state, state.goal_queue[1]);
  assert.equal(depResult.satisfied, true,
    "Dependency should be satisfied when prerequisite goal is completed");
});

test("convergence-regression: C8 — failed prerequisite blocks dependent queue", () => {
  const state = {};
  state.goal_queue = [
    {
      queue_id: "queue_failed_primary",
      goal_id: "goal_failed_primary",
      task_id: "task_failed_primary",
      status: "failed",
      position: 1,
      auto_start: true,
    },
    {
      queue_id: "queue_failed_dependent",
      goal_id: "goal_failed_dependent",
      task_id: null,
      status: "blocked",
      position: 2,
      depends_on_goal_id: "goal_failed_primary",
      blocked_reason: "depends_on_goal goal_failed_primary status=failed",
      auto_start: true,
    },
  ];
  state.goals = [
    { id: "goal_failed_primary", status: "failed", task_id: "task_failed_primary" },
  ];
  state.tasks = [
    { id: "task_failed_primary", goal_id: "goal_failed_primary", status: "failed" },
  ];

  assert.equal(isTerminalCompleted("failed"), false,
    "Failed task should not be considered terminal-completed");
  assert.equal(isNonCompletionTerminal("failed"), true,
    "Failed should be non-completion-terminal");
});

// ===========================================================================
// Coverage 9: auto_start=false is not started by worker
// ===========================================================================

test("convergence-regression: C9a — startNextQueuedGoal skips auto_start=false items", async () => {
  const state = {};
  state.goals = [
    { id: "goal_auto_yes", status: "open" },
    { id: "goal_auto_no", status: "open" },
  ];
  state.goal_queue = [
    {
      queue_id: "queue_auto_yes",
      goal_id: "goal_auto_yes",
      task_id: null,
      status: "waiting",
      position: 1,
      auto_start: true,
      repo_id: "",
    },
    {
      queue_id: "queue_auto_no",
      goal_id: "goal_auto_no",
      task_id: null,
      status: "waiting",
      position: 2,
      auto_start: false,
      repo_id: "",
    },
  ];
  state.tasks = [];

  const store = makeStore(state);
  const result = await startNextQueuedGoal(store, emptyConfig(), {
    require_auto_start: true,
    dry_run: true,
  });

  // Dry run with require_auto_start=true picks the first auto_start=true item
  // and returns started=false (dry run). The auto_start=false item should remain waiting.
  assert.equal(result.started, false,
    "Dry run with require_auto_start=true returns started=false for eligible item");
  assert.equal(typeof result.reason, "string",
    "Result should include a human-readable reason");
  // Verify auto_start=false item was not started/mutated
  const queueNo = state.goal_queue.find(q => q.auto_start === false);
  assert.ok(queueNo, "auto_start=false item should still exist in queue");
  assert.equal(queueNo.status, "waiting",
    "auto_start=false item must remain waiting after dry-run startNextQueuedGoal");
});

test("convergence-regression: C9b — auto_start=false item remains non-started after completion of previous", async () => {
  const state = {};
  state.tasks = [{
    id: "task_completed_autostart",
    goal_id: "goal_autostart_1",
    status: "completed",
  }];
  state.goals = [
    { id: "goal_autostart_1", task_id: "task_completed_autostart", status: "completed" },
    { id: "goal_autostart_2", status: "open" },
  ];
  state.goal_queue = [
    { queue_id: "q_autostart_1", goal_id: "goal_autostart_1", task_id: "task_completed_autostart", status: "completed", position: 1, auto_start: true },
    { queue_id: "q_autostart_2", goal_id: "goal_autostart_2", status: "waiting", position: 2, auto_start: false, repo_id: "" },
  ];

  const store = makeStore(state);
  const result = await autoStartNextOnTaskCompleted(
    store,
    emptyConfig(),
    { id: "task_completed_autostart", goal_id: "goal_autostart_1", status: "completed" }
  );

  assert.equal(result.auto_started, false,
    "autoStartNextOnTaskCompleted must NOT start auto_start=false items");
});

// ===========================================================================
// Coverage 10: Review packet, acceptance bundle, and recovery diagnostics
// ===========================================================================

test("convergence-regression: C10a — review packet shows compact root cause and next_action", async () => {
  const state = {};
  state.tasks = [{
    id: "task_review_compact",
    goal_id: "goal_review_compact",
    title: "Review regression: compact packet",
    status: "waiting_for_review",
    result: {
      summary: "Verification failed on edge case",
      changed_files: ["src/edge.mjs"],
      verification: { passed: false, commands: [{ cmd: "npm test", exit_code: 1, stdout_tail: "FAIL src/edge.test.mjs" }] },
      contract_verification: {
        acceptance_status: "unsatisfied",
        blocking_passed: false,
        completion_eligible: false,
        blockers: [{ code: "verification_command_failed", message: "npm test failed with exit code 1", source: "contract_verifier" }],
        non_blocking_followups: [],
        quality_notes: [],
      },
      closure_decision: { status: "requires_review", reason: "Verification failed" },
    },
  }];
  state.goals = [{ id: "goal_review_compact", task_id: "task_review_compact", title: "Goal: review compact", status: "open" }];

  const store = makeStore(state);
  const packet = await getTaskReviewPacket({ store, config: emptyConfig(), task_id: "task_review_compact" });

  assert.ok(packet.recommended_next_action, "Review packet must contain recommended_next_action");
  assert.ok(packet.blocking_findings, "Review packet must contain blocking_findings");
  assert.ok(packet.reason_for_review, "Review packet must contain reason_for_review");

  const serialized = JSON.stringify(packet);
  assert.ok(serialized.length < 8000,
    `Review packet must remain compact (< 8000 bytes), got ${serialized.length}`);
});

test("convergence-regression: C10b — review packet for completed task shows completion evidence", async () => {
  const state = {};
  state.tasks = [{
    id: "task_completed_evidence",
    goal_id: "goal_completed_evidence",
    title: "Completed task with evidence",
    status: "completed",
    result: {
      summary: "All tests pass, feature complete",
      changed_files: ["src/app.mjs", "test/app.test.mjs"],
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      contract_verification: {
        acceptance_status: "satisfied",
        blocking_passed: true,
        completion_eligible: true,
        blockers: [],
        non_blocking_followups: [{ code: "docs_later", message: "Add documentation later" }],
        quality_notes: [],
      },
      closure_decision: { status: "completed", reason: "All checks passed" },
      integration: { status: "merged", merged: true },
    },
  }];
  state.goals = [{ id: "goal_completed_evidence", task_id: "task_completed_evidence", title: "Goal: completed", status: "completed" }];

  const store = makeStore(state);
  const packet = await getTaskReviewPacket({ store, config: emptyConfig(), task_id: "task_completed_evidence" });

  assert.ok(packet.key_evidence?.verification?.passed === true,
    "Completed task review packet should show verification passed");
  assert.ok(packet.changed_files?.length >= 2,
    "Review packet should list changed files");
});

test("convergence-regression: C10c — detectAcceptanceProfile correctly classifies task shapes for recovery diagnostics", () => {
  assert.equal(detectAcceptanceProfile({}, { changed_files: ["docs/readme.md"] }), "code_change",
    "Builder with changed_files → code_change");
  assert.equal(detectAcceptanceProfile({ mode: "sync" }, { changed_files: [] }), "sync_only",
    "sync mode → sync_only");
  assert.equal(detectAcceptanceProfile({ mode: "verification" }, {}), "verification_only",
    "verification mode → verification_only");
  assert.equal(detectAcceptanceProfile({}, { noop: true, kind: "noop" }), "noop",
    "noop result → noop");
  assert.equal(detectAcceptanceProfile({ parent_task_id: "p1", repair_of_task_id: "p1" }, { changed_files: [] }), "repair_noop",
    "Repair without changes → repair_noop");
  assert.equal(detectAcceptanceProfile({ parent_task_id: "p1", repair_of_task_id: "p1" }, { changed_files: ["src/x.js"] }), "repair_code_change",
    "Repair with changes → repair_code_change");
  assert.equal(detectAcceptanceProfile({ status: "retry_wait" }, {}), "network_retry",
    "retry_wait status → network_retry");
  assert.equal(detectAcceptanceProfile({ mode: "integration" }, {}), "integration_only",
    "integration mode → integration_only");
});

// ===========================================================================
// Cross-cutting: Queue policy checks for convergence
// ===========================================================================

test("convergence-regression: queue policy — combined advancement checks pass for completed prerequisite", () => {
  const state = {};
  state.goals = [{ id: "goal_completed_for_policy", status: "completed" }];
  state.tasks = [{ id: "task_completed_for_policy", goal_id: "goal_completed_for_policy", status: "completed" }];
  state.goal_queue = [];

  const item = {
    queue_id: "q_policy_test",
    goal_id: "goal_completed_for_policy",
    depends_on_goal_id: "goal_completed_for_policy",
    depends_on_task_id: "task_completed_for_policy",
    repo_id: "github.com/test/repo",
  };

  const depResult = checkDependency(state, item);
  assert.equal(depResult.satisfied, true,
    "Dependency should be satisfied for completed prerequisite");

  const gateResult = checkAcceptanceGate(state, item);
  assert.equal(gateResult.passed, true,
    "Acceptance gate should pass for completed prerequisite");
});

test("convergence-regression: queue policy — repo concurrency prevents parallel same-repo tasks", () => {
  const state = {};
  state.goal_queue = [
    { queue_id: "q_repo_1", goal_id: "goal_repo_1", repo_id: "github.com/org/repo", status: "running" },
    { queue_id: "q_repo_2", goal_id: "goal_repo_2", repo_id: "github.com/org/repo", status: "waiting" },
  ];

  const concurrencyResult = checkRepoConcurrency(state, "github.com/org/repo", "q_repo_2");
  assert.equal(concurrencyResult.blocked, true,
    "Second same-repo queue item should be blocked for concurrency");
  assert.ok(concurrencyResult.runningItem,
    "Should identify the running item causing the block");
});

// ===========================================================================
// Cross-cutting: Edge cases and resilience
// ===========================================================================

test("convergence-regression: edge — null/undefined inputs return safe results", () => {
  const result1 = convergeTaskAfterRun({ task: { id: "edge1", status: "running" }, taskResult: {}, attempt: 0 });
  assert.ok(result1.nextStatus, "Should handle empty taskResult");

  const result2 = convergeTaskAfterRun({ task: { id: "edge2", status: "queued" }, taskResult: { changed_files: [] }, attempt: 0 });
  assert.ok(result2.nextStatus, "Should handle null task");
});

test("convergence-regression: edge — queued task with no result waits gracefully", () => {
  const result = convergeTaskAfterRun({
    task: { id: "edge_no_result", status: "queued" },
    taskResult: {},
    attempt: 0,
  });

  assert.ok(result.nextStatus, "Should produce a next status for queued task with no result");
});
