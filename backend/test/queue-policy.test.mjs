/**
 * queue-policy.test.mjs — Tests for the queue advancement policy module.
 *
 * Covers:
 * 1. isTerminalCompleted + isNonCompletionTerminal
 * 2. resolveDependencyTarget
 * 3. checkDependency (completed_only, terminal_any, unknown policy)
 * 4. checkAcceptanceGate (completed task, failed task, in-progress task)
 * 5. checkRepoConcurrency
 * 6. buildAdvancementChecks (compound checks)
 * 7. allAdvancementChecksPass / firstFailingCheck
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

async function loadPolicy() {
  return import("../src/queue-policy.mjs");
}

function makeState(overrides = {}) {
  return {
    goals: [],
    tasks: [],
    goal_queue: [],
    ...overrides,
  };
}

// ===========================================================================
// Test 1: isTerminalCompleted
// ===========================================================================

test("queue-policy: isTerminalCompleted returns true only for completed status", async () => {
  const { isTerminalCompleted } = await loadPolicy();

  assert.equal(isTerminalCompleted("completed"), true);
  assert.equal(isTerminalCompleted("COMPLETED"), false, "case-sensitive");
  assert.equal(isTerminalCompleted("failed"), false);
  assert.equal(isTerminalCompleted("timed_out"), false);
  assert.equal(isTerminalCompleted("blocked"), false);
  assert.equal(isTerminalCompleted("cancelled"), false);
  assert.equal(isTerminalCompleted("running"), false);
  assert.equal(isTerminalCompleted("assigned"), false);
  assert.equal(isTerminalCompleted(""), false);
  assert.equal(isTerminalCompleted(null), false);
  assert.equal(isTerminalCompleted(undefined), false);
});

// ===========================================================================
// Test 2: isNonCompletionTerminal
// ===========================================================================

test("queue-policy: isNonCompletionTerminal returns true for failed/terminal non-completed", async () => {
  const { isNonCompletionTerminal } = await loadPolicy();

  assert.equal(isNonCompletionTerminal("completed"), false);
  assert.equal(isNonCompletionTerminal("failed"), true);
  assert.equal(isNonCompletionTerminal("timed_out"), true);
  assert.equal(isNonCompletionTerminal("blocked"), true);
  assert.equal(isNonCompletionTerminal("cancelled"), true);
  assert.equal(isNonCompletionTerminal("running"), false);
  assert.equal(isNonCompletionTerminal("assigned"), false);
  assert.equal(isNonCompletionTerminal(""), false);
});

// ===========================================================================
// Test 3: resolveDependencyTarget
// ===========================================================================

test("queue-policy: resolveDependencyTarget with goal dependency", async () => {
  const { resolveDependencyTarget } = await loadPolicy();
  const state = makeState({
    goals: [{ id: "goal_1", status: "completed" }],
  });

  const result = resolveDependencyTarget(state, {
    depends_on_goal_id: "goal_1",
    depends_on_task_id: null,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.kind, "goal");
  assert.equal(result.target_id, "goal_1");
});

test("queue-policy: resolveDependencyTarget with task dependency", async () => {
  const { resolveDependencyTarget } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "task_42", status: "running" }],
  });

  const result = resolveDependencyTarget(state, {
    depends_on_goal_id: null,
    depends_on_task_id: "task_42",
  });

  assert.equal(result.status, "running");
  assert.equal(result.kind, "task");
  assert.equal(result.target_id, "task_42");
});

test("queue-policy: resolveDependencyTarget with no dependency", async () => {
  const { resolveDependencyTarget } = await loadPolicy();

  const result = resolveDependencyTarget(makeState(), {
    depends_on_goal_id: null,
    depends_on_task_id: null,
  });

  assert.equal(result.status, null);
  assert.equal(result.kind, "none");
  assert.equal(result.target_id, null);
});

test("queue-policy: resolveDependencyTarget with missing target", async () => {
  const { resolveDependencyTarget } = await loadPolicy();

  const result = resolveDependencyTarget(makeState(), {
    depends_on_task_id: "task_missing",
  });

  assert.equal(result.status, null);
  assert.equal(result.kind, "task");
  assert.equal(result.target_id, "task_missing");
});

// ===========================================================================
// Test 4: checkDependency — completed_only (default)
// ===========================================================================

test("queue-policy: checkDependency completed_only passes only for completed", async () => {
  const { checkDependency } = await loadPolicy();
  const state = makeState({
    goals: [{ id: "goal_dep", status: "completed" }],
  });

  const r1 = checkDependency(state, { depends_on_goal_id: "goal_dep", dependency_policy: "completed_only" });
  assert.equal(r1.satisfied, true);

  // Status not completed
  const state2 = makeState({ goals: [{ id: "goal_dep", status: "failed" }] });
  const r2 = checkDependency(state2, { depends_on_goal_id: "goal_dep", dependency_policy: "completed_only" });
  assert.equal(r2.satisfied, false);
  assert.match(r2.reason, /not terminal completed/);

  // Status still active
  const state3 = makeState({ goals: [{ id: "goal_dep", status: "running" }] });
  const r3 = checkDependency(state3, { depends_on_goal_id: "goal_dep", dependency_policy: "completed_only" });
  assert.equal(r3.satisfied, false);
});

test("queue-policy: completed task satisfies stale open goal dependency", async () => {
  const { checkDependency, resolveDependencyTarget } = await loadPolicy();
  const state = makeState({
    goals: [{ id: "goal_dep", status: "open" }],
    tasks: [{ id: "task_dep", goal_id: "goal_dep", status: "completed", result: { reviewer_decision: { status: "accepted", passed: true } } }],
  });

  const target = resolveDependencyTarget(state, { depends_on_goal_id: "goal_dep" });
  const dependency = checkDependency(state, { depends_on_goal_id: "goal_dep", dependency_policy: "completed_only" });

  assert.equal(target.status, "completed");
  assert.equal(target.kind, "goal");
  assert.equal(target.actual_source, "completed_task");
  assert.equal(target.task_id, "task_dep");
  assert.equal(dependency.satisfied, true);
  assert.equal(dependency.reason, null);
});

test("queue-policy: checkDependency terminal_any passes for any terminal", async () => {
  const { checkDependency } = await loadPolicy();

  const state1 = makeState({ tasks: [{ id: "t1", status: "completed" }] });
  assert.equal(checkDependency(state1, { depends_on_task_id: "t1", dependency_policy: "terminal_any" }).satisfied, true);

  const state2 = makeState({ tasks: [{ id: "t1", status: "failed" }] });
  assert.equal(checkDependency(state2, { depends_on_task_id: "t1", dependency_policy: "terminal_any" }).satisfied, true);

  const state3 = makeState({ tasks: [{ id: "t1", status: "running" }] });
  assert.equal(checkDependency(state3, { depends_on_task_id: "t1", dependency_policy: "terminal_any" }).satisfied, false);
});

test("queue-policy: checkDependency no dependency is satisfied", async () => {
  const { checkDependency } = await loadPolicy();
  const r = checkDependency(makeState(), {});
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, null);
});

test("queue-policy: checkDependency missing target returns unsatisfied", async () => {
  const { checkDependency } = await loadPolicy();
  const r = checkDependency(makeState(), { depends_on_task_id: "task_ghost" });
  assert.equal(r.satisfied, false);
  assert.match(r.reason, /not found/);
});

test("queue-policy: checkDependency unknown policy returns unsatisfied", async () => {
  const { checkDependency } = await loadPolicy();
  const state = makeState({ goals: [{ id: "g1", status: "completed" }] });
  const r = checkDependency(state, { depends_on_goal_id: "g1", dependency_policy: "bogus" });
  assert.equal(r.satisfied, false);
  assert.match(r.reason, /unknown dependency_policy/);
});

test("queue-policy: repo concurrency normalizes default, empty, and registered repo ids", async () => {
  const { checkRepoConcurrency, buildAdvancementChecks } = await loadPolicy();
  const registered = "github.com/9018/gpt-codex-workspace";
  const config = { defaultRepoId: registered };
  const state = makeState({
    goal_queue: [
      { queue_id: "running_default", goal_id: "goal_running", status: "running", repo_id: "default" },
      { queue_id: "candidate_empty", goal_id: "goal_empty", status: "waiting", repo_id: "" },
      { queue_id: "candidate_registered", goal_id: "goal_registered", status: "waiting", repo_id: registered },
    ],
  });

  const emptyResult = checkRepoConcurrency(state, "", "candidate_empty", config);
  const registeredResult = checkRepoConcurrency(state, registered, "candidate_registered", config);
  const checks = await buildAdvancementChecks(state, state.goal_queue[2], config);
  const repoCheck = checks.find((check) => check.check === "repo_concurrency");

  assert.equal(emptyResult.blocked, true);
  assert.equal(emptyResult.runningItem.queue_id, "running_default");
  assert.equal(registeredResult.blocked, true);
  assert.equal(registeredResult.runningItem.queue_id, "running_default");
  assert.equal(repoCheck.passed, false);
  assert.equal(repoCheck.repo_id, registered);
  assert.equal(repoCheck.blocking_item_queue_id, "running_default");
});

// ===========================================================================
// Test 5: checkAcceptanceGate
// ===========================================================================

test("queue-policy: checkAcceptanceGate passes when no task dependency", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const r = checkAcceptanceGate(makeState(), { depends_on_task_id: null });
  assert.equal(r.passed, true);
  assert.equal(r.reason, null);
});

test("queue-policy: checkAcceptanceGate passes when prerequisite completed", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "t1", status: "completed" }],
  });
  const r = checkAcceptanceGate(state, { depends_on_task_id: "t1" });
  assert.equal(r.passed, true);
  assert.equal(r.reason, null);
});

test("queue-policy: checkAcceptanceGate blocks on failed prerequisite", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "t1", status: "failed" }],
  });
  const r = checkAcceptanceGate(state, { depends_on_task_id: "t1" });
  assert.equal(r.passed, false);
  assert.match(r.reason, /must not advance/);
});

test("queue-policy: checkAcceptanceGate blocks on timed_out prerequisite", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "t1", status: "timed_out" }],
  });
  const r = checkAcceptanceGate(state, { depends_on_task_id: "t1" });
  assert.equal(r.passed, false);
  assert.match(r.reason, /must not advance/);
});

test("queue-policy: checkAcceptanceGate blocks on in-progress prerequisite", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "t1", status: "running" }],
  });
  const r = checkAcceptanceGate(state, { depends_on_task_id: "t1" });
  assert.equal(r.passed, false);
  assert.match(r.reason, /not yet complete/);
});

test("queue-policy: checkAcceptanceGate blocks on missing prerequisite task", async () => {
  const { checkAcceptanceGate } = await loadPolicy();
  const r = checkAcceptanceGate(makeState(), { depends_on_task_id: "ghost" });
  assert.equal(r.passed, false);
  assert.match(r.reason, /not found/);
});

// ===========================================================================
// Test 6: checkRepoConcurrency
// ===========================================================================

test("queue-policy: checkRepoConcurrency no concurrent repo found", async () => {
  const { checkRepoConcurrency } = await loadPolicy();
  const state = makeState({
    goal_queue: [
      { queue_id: "q1", repo_id: "repo-a", status: "running" },
      { queue_id: "q2", repo_id: "repo-b", status: "waiting" },
    ],
  });
  const r = checkRepoConcurrency(state, "repo-c");
  assert.equal(r.blocked, false);
});

test("queue-policy: checkRepoConcurrency blocks when same repo is running", async () => {
  const { checkRepoConcurrency } = await loadPolicy();
  const state = makeState({
    goal_queue: [
      { queue_id: "q1", repo_id: "repo-a", status: "running", goal_id: "goal_a" },
      { queue_id: "q2", repo_id: "repo-a", status: "waiting", goal_id: "goal_b" },
    ],
  });
  const r = checkRepoConcurrency(state, "repo-a", "q2");
  assert.equal(r.blocked, true);
  assert.equal(r.runningItem.queue_id, "q1");
});

test("queue-policy: checkRepoConcurrency excludes self from check", async () => {
  const { checkRepoConcurrency } = await loadPolicy();
  const state = makeState({
    goal_queue: [
      { queue_id: "q1", repo_id: "repo-a", status: "running", goal_id: "goal_a" },
    ],
  });
  // Excluding q1 means it shouldn't see itself as a blocker
  const r = checkRepoConcurrency(state, "repo-a", "q1");
  assert.equal(r.blocked, false);
});

test("queue-policy: checkRepoConcurrency empty repoId is not blocked", async () => {
  const { checkRepoConcurrency } = await loadPolicy();
  const r = checkRepoConcurrency(makeState(), "");
  assert.equal(r.blocked, false);
});

test("queue-policy: checkRepoConcurrency not blocked by other repo running", async () => {
  const { checkRepoConcurrency } = await loadPolicy();
  const state = makeState({
    goal_queue: [
      { queue_id: "qx", repo_id: "repo-x", status: "running" },
    ],
  });
  const r = checkRepoConcurrency(state, "repo-y");
  assert.equal(r.blocked, false);
});

// ===========================================================================
// Test 7: buildAdvancementChecks
// ===========================================================================

test("queue-policy: buildAdvancementChecks returns checks for item with dependency", async () => {
  const { buildAdvancementChecks } = await loadPolicy();
  const state = makeState({
    goals: [{ id: "goal_dep", status: "completed" }],
    goal_queue: [{ queue_id: "q1", depends_on_goal_id: "goal_dep", repo_id: "repox" }],
  });

  const checks = await buildAdvancementChecks(state, state.goal_queue[0]);
  assert.ok(Array.isArray(checks));
  assert.equal(checks.length, 3);

  const depCheck = checks.find((c) => c.check === "dependency");
  assert.ok(depCheck);
  assert.equal(depCheck.passed, true);

  const acceptCheck = checks.find((c) => c.check === "acceptance_gate");
  assert.ok(acceptCheck);
  assert.equal(acceptCheck.passed, true);

  const concurrencyCheck = checks.find((c) => c.check === "repo_concurrency");
  assert.ok(concurrencyCheck);
  assert.equal(concurrencyCheck.passed, true);
});

test("queue-policy: buildAdvancementChecks includes failed acceptance check", async () => {
  const { buildAdvancementChecks } = await loadPolicy();
  const state = makeState({
    tasks: [{ id: "t_fail", status: "failed" }],
    goal_queue: [{ queue_id: "q1", depends_on_task_id: "t_fail" }],
  });

  const checks = await buildAdvancementChecks(state, state.goal_queue[0]);
  const acceptCheck = checks.find((c) => c.check === "acceptance_gate");
  assert.ok(acceptCheck);
  assert.equal(acceptCheck.passed, false);
});

test("queue-policy: buildAdvancementChecks no repo_id skips concurrency check", async () => {
  const { buildAdvancementChecks } = await loadPolicy();
  const state = makeState({
    goal_queue: [{ queue_id: "q1" }],
  });

  const checks = await buildAdvancementChecks(state, state.goal_queue[0]);
  const concurrencyCheck = checks.find((c) => c.check === "repo_concurrency");
  assert.ok(concurrencyCheck);
  assert.equal(concurrencyCheck.passed, true);
  assert.match(concurrencyCheck.detail, /no repo_id/);
});

// ===========================================================================
// Test 8: allAdvancementChecksPass / firstFailingCheck
// ===========================================================================

test("queue-policy: allAdvancementChecksPass true for empty checks", async () => {
  const { allAdvancementChecksPass } = await loadPolicy();
  assert.equal(allAdvancementChecksPass([]), true);
});

test("queue-policy: allAdvancementChecksPass true when all pass", async () => {
  const { allAdvancementChecksPass } = await loadPolicy();
  assert.equal(allAdvancementChecksPass([{ passed: true }, { passed: true }]), true);
});

test("queue-policy: allAdvancementChecksPass false when one fails", async () => {
  const { allAdvancementChecksPass } = await loadPolicy();
  assert.equal(allAdvancementChecksPass([{ passed: true }, { passed: false }]), false);
});

test("queue-policy: firstFailingCheck returns correct check", async () => {
  const { firstFailingCheck } = await loadPolicy();
  const checks = [
    { check: "dep", passed: true },
    { check: "accept", passed: false, detail: "blocked" },
    { check: "concurrency", passed: true },
  ];
  const fail = firstFailingCheck(checks);
  assert.ok(fail);
  assert.equal(fail.check, "accept");
});

test("queue-policy: firstFailingCheck null for all passing", async () => {
  const { firstFailingCheck } = await loadPolicy();
  assert.equal(firstFailingCheck([{ passed: true }]), null);
});

// ===========================================================================
// Test 9: Integration with goal-queue — isDependencySatisfied delegates
// ===========================================================================

test("queue-policy: goal-queue re-exports checkDependency from policy", async () => {
  const gq = await import("../src/goal-queue.mjs");
  assert.equal(typeof gq.checkDependency, "function", "goal-queue re-exports checkDependency");
  assert.equal(typeof gq.checkAcceptanceGate, "function", "goal-queue re-exports checkAcceptanceGate");
  assert.equal(typeof gq.checkRepoConcurrency, "function", "goal-queue re-exports checkRepoConcurrency");
  assert.equal(typeof gq.buildAdvancementChecks, "function", "goal-queue re-exports buildAdvancementChecks");
  assert.equal(typeof gq.isTerminalCompleted, "function", "goal-queue re-exports isTerminalCompleted");
});
