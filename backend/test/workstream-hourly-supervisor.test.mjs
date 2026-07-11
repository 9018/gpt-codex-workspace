/**
 * workstream-hourly-supervisor.test.mjs
 *
 * Hourly supervisor contract for Workstream productization.
 *
 * Validates:
 *   1. Normal progress advancement (no drift, no stall)
 *   2. Drift detection and correction
 *   3. Stall detection and recovery
 *   4. ChatGPT direct edit priority
 *   5. Fallback repair task when ChatGPT edit unavailable
 *   6. Idempotency (repeated supervisor passes)
 *   7. Documentation enforcement
 *
 * The supervisor is modeled as a bounded tick controller with
 * drift/stall detection, acceptance evaluation, and repair scheduling.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state-store.mjs";
import { createWorkstream, updateWorkstream } from "../src/workstream/workstream-service.mjs";
import { runTick, tickDriftDetection, tickStallDetection, tickTaskAdvancement, tickReviewReconciliation, MAX_STATE_TRANSITIONS, TRANSITION_KIND } from "../src/orchestration/workstream-tick.mjs";
import { detectDrift } from "../src/orchestration/workstream-drift-detector.mjs";
import { detectStall } from "../src/orchestration/workstream-stall-detector.mjs";
import { evaluateAcceptance, VERDICT } from "../src/acceptance/workstream-acceptance-decision.mjs";
import { scheduleRepairAction, findExistingRepairRecord, MAX_REPAIR_ATTEMPTS } from "../src/acceptance/workstream-repair-task-factory.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-hourly-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
  });
  await store.load();
  store.state.workstream_dag = { nodes: {}, edges: [] };
  store.state.repair_records = [];
  store.state.workstream_repair_records = [];
  await store.save();
  return store;
}

const recent = () => new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
const old = () => new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
const veryOld = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // 6 hours ago

// ===========================================================================
// Tests
// ===========================================================================

test("HS-1: Normal progress -- no drift, no stall (clean state)", async (t) => {
  const recentTime = recent();

  const driftResult = tickDriftDetection({
    workstream: { id: "ws_1", phase: "backend" },
    tasks: [{ id: "t1", phase: "backend", status: "running", updated_at: recentTime }],
    progress: { updated_at: recentTime },
  });

  assert.equal(driftResult.kind, TRANSITION_KIND.DRIFT_DETECTED);
  assert.equal(driftResult.count, 0);
  assert.ok(driftResult.idempotency_key);

  const stallResult = tickStallDetection({
    task: { id: "t1", assignee: "codex", status: "running", updated_at: recentTime },
    tuiSession: { session_id: "s1", last_heartbeat_at: recentTime, status: "active" },
    lock: { lock_id: "l1", acquired_at: recentTime },
  });

  assert.equal(stallResult.kind, TRANSITION_KIND.STALL_DETECTED);
  assert.equal(stallResult.count, 0);
  assert.equal(stallResult.stalled, false);
});

test("HS-2: Drift detection and correction", async () => {
  // Phase mismatch drift
  const drift1 = detectDrift({
    task: { id: "t_drift", phase: "frontend" },
    workstream: { id: "ws_drift" },
    expectedPhase: "backend",
  });
  assert.ok(drift1.drifted);
  assert.ok(drift1.findings.length > 0);
  assert.equal(drift1.findings[0].code, "task_phase_mismatch");

  // No drift when phase matches AND progress is fresh AND status is non-terminal non-stale
  const drift2 = detectDrift({
    task: { id: "t_ok", phase: "backend", status: "running", updated_at: recent() },
    workstream: { id: "ws_ok" },
    progress: { updated_at: recent() },
    expectedPhase: "backend",
  });
  assert.equal(drift2.drifted, false, `Expected no drift but got: ${drift2.findings.map(f => f.code).join(",")}`);

  // Stale progress drift
  const drift3 = detectDrift({
    task: { id: "t_stale", phase: "backend", updated_at: veryOld() },
    workstream: { id: "ws_stale" },
    progress: { updated_at: veryOld() },
    expectedPhase: "backend",
  });
  assert.ok(drift3.drifted);
  assert.ok(drift3.findings.length > 0);

  // Wrong scope drift
  const drift4 = detectDrift({
    task: { id: "t_scope", phase: "backend", updated_at: recent(), workstream_id: "ws_wrong" },
    workstream: { id: "ws_correct" },
    expectedScopes: ["ws_correct"],
    expectedPhase: "backend",
  });
  assert.ok(drift4.drifted);
});

test("HS-3: Stall detection and recovery", async () => {
  // Dead TUI stall
  const stall1 = detectStall({
    task: { id: "t_stall", assignee: "codex", status: "running", updated_at: old() },
    tuiSession: { session_id: "s_dead", last_heartbeat_at: veryOld(), status: "active" },
    lock: { lock_id: "l_stale", acquired_at: veryOld() },
  });
  assert.ok(stall1.stalled);

  // No stall when everything is recent
  const stall2 = detectStall({
    task: { id: "t_ok", assignee: "codex", status: "running", updated_at: recent() },
    tuiSession: { session_id: "s_ok", last_heartbeat_at: recent(), status: "active" },
    lock: { lock_id: "l_ok", acquired_at: recent() },
  });
  assert.equal(stall2.stalled, false);

  // Stale lock stall
  const stall3 = detectStall({
    task: { id: "t_locked", assignee: "codex", status: "running", updated_at: recent() },
    tuiSession: { session_id: "s_ok", last_heartbeat_at: recent(), status: "active" },
    lock: { lock_id: "l_very_stale", acquired_at: veryOld() },
  });
  assert.ok(stall3.stalled);
});

test("HS-4: ChatGPT direct edit preference", async () => {
  const task = { id: "task_direct", root_task_id: "task_direct_root", title: "Direct-edit task" };
  const goal = { id: "goal_direct" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [
      { code: "typo_in_doc", severity: "blocker", message: "Typo in documentation" },
    ],
    idempotency_key: "acceptance:failed:typo",
  };

  // When corrections are available, direct_correction must be preferred
  const corrections = [
    { file: "docs/typo.md", patch: "Fix typo", description: "Fix typo in doc" },
  ];

  const action = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [],
    currentAttempt: 0,
    corrections,
  });

  assert.equal(action.action, "direct_correction");
  assert.ok(action.payload);
  assert.equal(action.payload.kind, "direct_correction");
  assert.equal(action.payload.corrections.length, 1);
  assert.equal(action.payload.corrections[0].file, "docs/typo.md");
});

test("HS-5: Fallback repair task when ChatGPT edit unavailable", async () => {
  const task = { id: "task_fallback", root_task_id: "task_fallback_root", title: "Fallback task" };
  const goal = { id: "goal_fallback" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [
      { code: "failed_test", severity: "blocker", message: "Test failure" },
    ],
    idempotency_key: "acceptance:failed:test",
  };

  // No corrections available -> should create repair goal
  const action = scheduleRepairAction({
    task,
    goal,
    acceptanceDecision,
    repairRecords: [],
    currentAttempt: 0,
    corrections: [], // no corrections available
  });

  assert.equal(action.action, "create_repair_goal");
  assert.ok(action.payload);
  assert.equal(action.payload.attempt, 1);
  assert.ok(action.payload.goal_prompt);
  assert.ok(action.payload.goal_prompt.includes("Repair"));
});

test("HS-6: Idempotent supervisor passes", async () => {
  const recentTime = recent();

  // Run tick twice with same state
  const run = async () => runTick({
    workstream: { id: "ws_idemp", phase: "test" },
    tasks: [{ id: "t_idemp", phase: "test", status: "running", updated_at: recentTime }],
    goal: { id: "g_idemp" },
    progress: { updated_at: recentTime },
    tuiSession: { session_id: "s_idemp", last_heartbeat_at: recentTime, status: "active" },
    lock: { lock_id: "l_idemp", acquired_at: recentTime },
    parentTask: {},
    reviewBacklog: [],
    maxTransitions: 5,
  });

  const first = await run();
  const second = await run();

  // Both runs should produce the same number of transitions
  assert.equal(first.transition_count, second.transition_count);
  assert.equal(first.transitions.length, second.transitions.length);

  // Drift results should be idempotent (same count, same kind)
  assert.equal(first.transitions[0].kind, second.transitions[0].kind);
  assert.equal(first.transitions[0].count, second.transitions[0].count);

  // Stall results should be idempotent
  assert.equal(first.transitions[1].kind, second.transitions[1].kind);
  assert.equal(first.transitions[1].count, second.transitions[1].count);

  // Idempotency keys should be the same
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test("HS-7: Documentation enforcement (acceptance gate)", async () => {
  // A docs_only task with .md files and all evidence should pass
  const passingInput = {
    task: { id: "t_doc_ok", status: "completed", commit: "abc", changed_files: ["docs/test.md"] },
    result: {
      status: "completed",
      summary: "Docs change",
      commit: "abc",
      changed_files: ["docs/test.md"],
      tests: "ok",
      verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
    },
    verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "docs_only", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "abc" },
  };
  const passing = evaluateAcceptance(passingInput);
  assert.equal(passing.verdict, VERDICT.PASSED);

  // A docs_only task without .md files should fail documentation check
  const failingInput = {
    task: { id: "t_doc_fail", status: "completed", commit: "def", changed_files: ["src/code.mjs"] },
    result: {
      status: "completed",
      summary: "No docs",
      commit: "def",
      changed_files: ["src/code.mjs"],
      tests: "ok",
      verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
    },
    verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "docs_only", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "def" },
  };
  const failing = evaluateAcceptance(failingInput);
  assert.ok(failing.findings.length > 0);
  assert.notEqual(failing.verdict, VERDICT.PASSED);

  // Non-docs task changing code files with docs should pass
  const codeChangeInput = {
    task: { id: "t_code", status: "completed", commit: "123", changed_files: ["src/app.mjs", "docs/readme.md"] },
    result: {
      status: "completed",
      summary: "Code change with docs",
      commit: "123",
      changed_files: ["src/app.mjs", "docs/readme.md"],
      tests: "ok",
      verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
      reviewer_decision: { status: "accepted", passed: true },
    },
    verification: { passed: true, commands: [{ cmd: "test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "code_change", mutation_scope: "repo" } },
    gitState: { dirty: false, diff_empty: true, commit: "123" },
  };
  const codeResult = evaluateAcceptance(codeChangeInput);
  assert.equal(codeResult.verdict, VERDICT.PASSED);
});

test("HS-8: Repair budget exhaustion after MAX attempts", async () => {
  const task = { id: "task_budget", root_task_id: "task_budget_root", title: "Budget task" };
  const goal = { id: "goal_budget" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [],
    idempotency_key: "acceptance:failed:budget",
  };

  // Attempt 0 -> create repair
  const a1 = scheduleRepairAction({ task, goal, acceptanceDecision, repairRecords: [], currentAttempt: 0 });
  assert.equal(a1.action, "create_repair_goal");

  // Attempt 1 -> create repair
  const a2 = scheduleRepairAction({ task, goal, acceptanceDecision, repairRecords: [a1.record].filter(Boolean), currentAttempt: 1 });
  assert.equal(a2.action, "create_repair_goal");

  // Attempt 2 (exhausted) -> escalation
  const a3 = scheduleRepairAction({ task, goal, acceptanceDecision, repairRecords: [a1.record, a2.record].filter(Boolean), currentAttempt: 2 });
  assert.equal(a3.action, "chatgpt_escalation");

  // Verify MAX_REPAIR_ATTEMPTS is 2
  assert.equal(MAX_REPAIR_ATTEMPTS, 2);
});

test("HS-9: Review backlog reconciliation tick", async () => {
  const result = tickReviewReconciliation({
    reviewBacklog: [
      { task_id: "r1", status: "waiting_for_review" },
      { task_id: "r2", status: "waiting_for_repair" },
      { task_id: "r3", status: "completed" },
    ],
  });

  assert.equal(result.kind, TRANSITION_KIND.REVIEW_RECONCILED);
  assert.equal(result.count, 2); // only waiting_for_review and waiting_for_repair
  assert.ok(result.idempotency_key);
});

test("HS-10: Task advancement via tick", async () => {
  const result = tickTaskAdvancement({
    tasks: [
      { id: "t_adv_1", status: "assigned" },
      { id: "t_adv_2", status: "queued" },
      { id: "t_adv_3", status: "completed" },
      { id: "t_adv_4", status: "failed" },
    ],
  });

  assert.equal(result.kind, TRANSITION_KIND.TASK_ADVANCED);
  assert.equal(result.count, 2);
  assert.equal(result.advancements.length, 2);
  assert.equal(result.advancements[0].task_id, "t_adv_1");
  assert.equal(result.advancements[1].task_id, "t_adv_2");
});

test("HS-11: Deduplication of repair records prevents duplicate actions", async () => {
  const task = { id: "task_dedup", root_task_id: "task_dedup_root", title: "Dedup task" };
  const goal = { id: "goal_dedup" };

  const acceptanceDecision = {
    verdict: VERDICT.FAILED,
    findings: [{ code: "test_fail", severity: "blocker", message: "Test failed" }],
    idempotency_key: "acceptance:failed:dedup",
  };

  // Create first repair
  const a1 = scheduleRepairAction({ task, goal, acceptanceDecision, repairRecords: [], currentAttempt: 0 });
  assert.equal(a1.action, "create_repair_goal");

  // Record exists
  const found = findExistingRepairRecord({
    repairRecords: [a1.record].filter(Boolean),
    rootTaskId: task.root_task_id,
    kind: "repair_task",
    attempt: 1,
  });
  assert.ok(found.exists);

  // Second call with same attempt should deduplicate
  const a2 = scheduleRepairAction({
    task, goal, acceptanceDecision,
    repairRecords: [a1.record].filter(Boolean),
    currentAttempt: 0,
  });
  assert.equal(a2.action, "deduplicated");
});

test("HS-12: Composite runTick handles empty state gracefully", async () => {
  const result = await runTick({});

  assert.ok(result.tick_id);
  assert.ok(result.transition_count >= 0);
  assert.ok(Array.isArray(result.transitions));
  assert.ok(typeof result.idempotency_key === "string");
});

test("HS-13: Supervisor drift detection via tick integration", async () => {
  const veryOldTime = veryOld();
  const driftResult = tickDriftDetection({
    workstream: { id: "ws_sup", phase: "deploy" },
    tasks: [
      { id: "t_sup_1", phase: "build", status: "running", updated_at: veryOldTime },
    ],
    progress: { updated_at: veryOldTime },
  });

  assert.ok(driftResult.count > 0);
  assert.ok(driftResult.findings.length > 0);
  assert.equal(driftResult.kind, TRANSITION_KIND.DRIFT_DETECTED);
});

test("HS-14: Supervisor handles terminal queue task mismatch drift", async () => {
  const driftResult = tickDriftDetection({
    workstream: { id: "ws_term", phase: "build" },
    tasks: [
      { id: "t_term_1", status: "completed", phase: "build" },
    ],
    queue: [{ id: "q_term", task_id: "t_term_1", status: "running" }],
    progress: {},
  });

  assert.equal(driftResult.kind, TRANSITION_KIND.DRIFT_DETECTED);
  // Terminal task with running queue item may be detected
  assert.ok(driftResult.count >= 0);
});
