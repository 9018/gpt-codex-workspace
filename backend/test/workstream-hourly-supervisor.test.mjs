/**
 * workstream-hourly-supervisor.test.mjs — Hourly supervisor contract
 * for workstream state advancement, drift/stall recovery, and repair.
 *
 * Contract cases:
 *   1. Normal advancement via runTick
 *   2. Drift correction via detectDrift
 *   3. Stall recovery via detectStall
 *   4. ChatGPT direct edit prioritized over repair task when applicable
 *   5. Fallback repair task when direct edit is unavailable/budget limited
 *   6. Idempotency (same input => same output)
 *   7. Documentation enforcement via acceptance decision
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// -- Tick / supervisor imports (G4 + G5) --
import {
  runTick,
  tickDriftDetection,
  tickStallDetection,
  tickAcceptanceEvaluation,
  tickTaskAdvancement,
  tickReviewReconciliation,
  MAX_STATE_TRANSITIONS,
  TRANSITION_KIND,
} from "../src/orchestration/workstream-tick.mjs";

// -- Drift detector (G5) --
import {
  detectDrift,
  detectWrongPhaseDrift,
  detectWrongScopeDrift,
  detectStaleProgressDrift,
  detectTerminalQueueMismatchDrift,
  DRIFT_TYPE,
} from "../src/orchestration/workstream-drift-detector.mjs";

// -- Stall detector (G5) --
import {
  detectStall,
  detectDeadTuiStall,
  detectStaleWorkerStall,
  detectStaleLockStall,
  detectTerminalMismatchStall,
  STALL_TYPE,
} from "../src/orchestration/workstream-stall-detector.mjs";

// -- Acceptance / repair (G5) --
import {
  evaluateAcceptance,
  VERDICT,
} from "../src/acceptance/workstream-acceptance-decision.mjs";
import {
  scheduleRepairAction,
  buildDirectCorrectionPayload,
  buildRepairGoalPayload,
  buildChatGptEscalationPayload,
  MAX_REPAIR_ATTEMPTS,
  REPAIR_KIND,
} from "../src/acceptance/workstream-repair-task-factory.mjs";
import {
  runAcceptanceController,
} from "../src/acceptance/workstream-acceptance-controller.mjs";

// ---------------------------------------------------------------------------
// 1. Normal advancement
// ---------------------------------------------------------------------------

test("tickTaskAdvancement — advances eligible tasks through statuses", () => {
  const tasks = [
    { id: "task_1", status: "assigned" },
    { id: "task_2", status: "queued" },
    { id: "task_3", status: "running" },  // should not advance
    { id: "task_4", status: "waiting_for_lock" },
  ];

  const result = tickTaskAdvancement({ tasks, workstream: {} });
  assert.equal(result.kind, TRANSITION_KIND.TASK_ADVANCED);
  assert.equal(result.count, 3);
  assert.equal(result.advancements.length, 3);

  const advMap = {};
  for (const a of result.advancements) {
    advMap[a.task_id] = { old: a.old_status, new: a.new_status };
  }
  assert.equal(advMap.task_1.old, "assigned");
  assert.equal(advMap.task_1.new, "queued");
  assert.equal(advMap.task_2.old, "queued");
  assert.equal(advMap.task_2.new, "running");
  assert.equal(advMap.task_4.old, "waiting_for_lock");
  assert.equal(advMap.task_4.new, "running");
  // task_3 (running) should not be in advancements
  assert.equal(advMap.task_3, undefined);
});

test("tickTaskAdvancement — no advancement for already-advanced tasks", () => {
  const tasks = [
    { id: "task_1", status: "assigned", tick_advanced: true },
  ];

  const result = tickTaskAdvancement({ tasks, workstream: {} });
  assert.equal(result.count, 1);
  assert.ok(result.advancements[0].reason.includes("Already advanced"));
});

test("tickDriftDetection — no drift when everything matches", () => {
  const result = tickDriftDetection({
    workstream: { phase: "build", workflow_id: "wf_test" },
    tasks: [{ id: "task_1", phase: "build", scope: "wf_test", created_at: new Date().toISOString() }],
    progress: { updated_at: new Date().toISOString() },
  });
  assert.equal(result.kind, TRANSITION_KIND.DRIFT_DETECTED);
  assert.equal(result.count, 0);
  assert.equal(result.summary, "No drift.");
});

// ---------------------------------------------------------------------------
// 2. Drift correction
// ---------------------------------------------------------------------------

test("detectDrift — detects wrong phase drift", () => {
  const result = detectDrift({
    task: { id: "task_1", phase: "test" },
    workstream: {},
    expectedPhase: "build",
    expectedScopes: ["wf_scope"],
  });
  assert.ok(result.drifted);
  const phases = result.findings.filter((f) => f.type === DRIFT_TYPE.WRONG_PHASE);
  assert.equal(phases.length, 1);
  assert.match(phases[0].message, /phase.*test.*does not match.*build/);
});

test("detectDrift — detects wrong scope drift", () => {
  const result = detectDrift({
    task: { id: "task_1", scope: "unexpected_scope" },
    workstream: {},
    expectedPhase: "",
    expectedScopes: ["wf_correct"],
  });
  assert.ok(result.drifted);
  const scopes = result.findings.filter((f) => f.type === DRIFT_TYPE.WRONG_SCOPE);
  assert.equal(scopes.length, 1);
});

test("detectDrift — detects stale progress drift", () => {
  const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
  const result = detectDrift({
    task: { id: "task_1", status: "running" },
    progress: { updated_at: staleDate },
    expectedPhase: "",
    expectedScopes: [],
    staleThresholdHours: 2,
  });
  assert.ok(result.drifted);
  const stale = result.findings.filter((f) => f.type === DRIFT_TYPE.STALE_PROGRESS);
  assert.equal(stale.length, 1);
  assert.match(stale[0].message, /stale|Progress/i);
});

test("detectDrift — detects terminal queue mismatch", () => {
  const result = detectDrift({
    task: { id: "task_1", status: "completed" },
    parentTask: { id: "parent", status: "running" },
    expectedPhase: "",
    expectedScopes: [],
  });
  assert.ok(result.drifted);
  const mismatch = result.findings.filter((f) => f.type === DRIFT_TYPE.TERMINAL_QUEUE_MISMATCH);
  assert.equal(mismatch.length, 1);
});

test("detectDrift — no drift when task status is terminal and parent also terminal", () => {
  const result = detectDrift({
    task: { id: "task_1", status: "completed" },
    parentTask: { id: "parent", status: "integrated" },
    expectedPhase: "",
    expectedScopes: [],
  });
  assert.equal(result.drifted, false);
});

// ---------------------------------------------------------------------------
// 3. Stall recovery
// ---------------------------------------------------------------------------

test("detectStall — detects dead TUI session", () => {
  const oldHeartbeat = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const result = detectStall({
    task: {},
    tuiSession: {
      session_id: "tui_dead",
      last_heartbeat_at: oldHeartbeat,
      status: "active",
    },
    maxHeartbeatAgeMinutes: 10,
  });
  assert.ok(result.stalled);
  assert.ok(result.findings.some((f) => f.type === STALL_TYPE.DEAD_TUI));
});

test("detectStall — detects stale worker stall", () => {
  const oldUpdate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const result = detectStall({
    task: { id: "task_w", assignee: "codex", status: "running", updated_at: oldUpdate },
    maxWorkerIdleMinutes: 15,
  });
  assert.ok(result.stalled);
  assert.ok(result.findings.some((f) => f.type === STALL_TYPE.STALE_WORKER));
});

test("detectStall — detects stale lock stall", () => {
  const oldLock = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  const result = detectStall({
    lock: { lock_id: "lock_1", acquired_at: oldLock },
    maxLockAgeMinutes: 60,
  });
  assert.ok(result.stalled);
  assert.ok(result.findings.some((f) => f.type === STALL_TYPE.STALE_LOCK));
});

test("detectStall — detects terminal mismatch stall", () => {
  const result = detectStall({
    task: {},
    parentTask: { status: "running" },
    siblingTasks: [
      { id: "s1", status: "completed" },
      { id: "s2", status: "completed" },
      { id: "s3", status: "running" },
    ],
  });
  assert.ok(result.stalled);
  const terminal = result.findings.filter((f) => f.type === STALL_TYPE.TERMINAL_MISMATCH);
  assert.equal(terminal.length, 1);
});

test("detectStall — no stall when all conditions normal", () => {
  const now = new Date().toISOString();
  const result = detectStall({
    task: { id: "task_active", assignee: "codex", status: "running", updated_at: now },
    tuiSession: { session_id: "tui_ok", last_heartbeat_at: now, status: "active" },
    lock: { lock_id: "lock_ok", acquired_at: now },
    parentTask: { status: "running" },
    siblingTasks: [{ id: "s1", status: "running" }],
  });
  assert.equal(result.stalled, false);
});

test("detectStall — idempotent: same input produces same output", () => {
  const oldHeartbeat = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const input = {
    task: {},
    tuiSession: { session_id: "tui_dead", last_heartbeat_at: oldHeartbeat, status: "active" },
    maxHeartbeatAgeMinutes: 10,
  };

  const first = detectStall(input);
  const second = detectStall(input);
  assert.equal(first.stalled, second.stalled);
  assert.equal(first.stall_count, second.stall_count);
  assert.equal(first.idempotency_key, second.idempotency_key);
});

// ---------------------------------------------------------------------------
// 4. ChatGPT direct edit prioritized
// ---------------------------------------------------------------------------

test("scheduleRepairAction — direct_correction chosen when corrections available", () => {
  const action = scheduleRepairAction({
    task: { id: "task_direct", root_task_id: "root_direct" },
    goal: { id: "goal_direct" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "changed_files_mismatch", message: "No files" }],
    },
    repairRecords: [],
    corrections: [{ file: "src/foo.mjs", patch: "--- a/src/foo.mjs", description: "Fix import" }],
    currentAttempt: 0,
  });
  assert.equal(action.action, "direct_correction");
  assert.ok(action.payload);
  assert.equal(action.payload.kind, REPAIR_KIND.DIRECT_CORRECTION);
  assert.equal(action.payload.corrections.length, 1);
});

test("scheduleRepairAction — falls back to repair goal when no corrections available", () => {
  const action = scheduleRepairAction({
    task: { id: "task_repair", root_task_id: "root_repair" },
    goal: { id: "goal_repair" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_fail", message: "Test failed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 0,
  });
  assert.equal(action.action, "create_repair_goal");
  assert.ok(action.payload);
  assert.equal(action.payload.assign_to_codex, true);
});

test("scheduleRepairAction — converges for partial acceptance", () => {
  const action = scheduleRepairAction({
    task: { id: "task_conv", root_task_id: "root_conv" },
    goal: { id: "goal_conv" },
    acceptanceDecision: {
      verdict: "partial",
      findings: [{ severity: "blocker", code: "docs_updated", message: "Docs needed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 0,
  });
  assert.equal(action.action, "create_convergence_goal");
});

test("scheduleRepairAction — escalates when budget exhausted", () => {
  const action = scheduleRepairAction({
    task: { id: "task_esc", root_task_id: "root_esc" },
    goal: {},
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_fail", message: "Test failed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 2, // MAX_REPAIR_ATTEMPTS = 2
  });
  assert.equal(action.action, "chatgpt_escalation");
});

// ---------------------------------------------------------------------------
// 5. Fallback repair task when direct edit is unavailable
// ---------------------------------------------------------------------------

test("scheduleRepairAction — fallback to repair task when no corrections and budget available", () => {
  // With 0 current attempt and no corrections, should create repair goal
  const action = scheduleRepairAction({
    task: { id: "task_fallback", root_task_id: "root_fallback" },
    goal: { id: "goal_fallback" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "verification_not_passed", message: "Verification failed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 0,
  });
  assert.equal(action.action, "create_repair_goal");
  assert.equal(action.payload.repair_attempt, 1);

  // Second attempt still budget (1 < 2)
  const action2 = scheduleRepairAction({
    task: { id: "task_fallback", root_task_id: "root_fallback" },
    goal: { id: "goal_fallback" },
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "verification_not_passed", message: "Verification failed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 1,
  });
  assert.equal(action2.action, "create_repair_goal");
  assert.equal(action2.payload.repair_attempt, 2);
});

test("scheduleRepairAction — escalation after max repair attempts", () => {
  // currentAttempt = 2 (already made 2 attempts) -> should escalate
  const action = scheduleRepairAction({
    task: { id: "task_exhausted", root_task_id: "root_exhausted" },
    goal: {},
    acceptanceDecision: {
      verdict: "failed",
      findings: [{ severity: "blocker", code: "test_fail", message: "Test failed" }],
    },
    repairRecords: [],
    corrections: [],
    currentAttempt: 2, // MAX_REPAIR_ATTEMPTS
  });
  assert.equal(action.action, "chatgpt_escalation");
});

// ---------------------------------------------------------------------------
// 6. Idempotency
// ---------------------------------------------------------------------------

test("evaluateAcceptance — idempotent: same input same verdict", () => {
  const input = {
    task: { id: "task_pass" },
    goal: { id: "goal_pass" },
    result: {
      summary: "Done",
      status: "completed",
      commit: "abc123",
      changed_files: ["src/foo.mjs"],
      tests: "all pass",
      verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
    contract: { intent: { operation_kind: "implementation" } },
    gitState: { dirty: false, diff_empty: false },
  };

  const first = evaluateAcceptance(input);
  const second = evaluateAcceptance(input);
  assert.equal(first.verdict, second.verdict);
  assert.equal(first.idempotency_key, second.idempotency_key);
  assert.equal(first.blocker_count, second.blocker_count);
});

test("detectDrift — idempotent: same input same result", () => {
  const input = {
    task: { id: "task_drift", phase: "wrong" },
    workstream: {},
    expectedPhase: "correct",
    expectedScopes: [],
  };
  const first = detectDrift(input);
  const second = detectDrift(input);
  assert.equal(first.drifted, second.drifted);
  assert.equal(first.drift_count, second.drift_count);
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test("detectStall — idempotent: same input same result", () => {
  const oldLock = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  const input = {
    lock: { lock_id: "lock_same", acquired_at: oldLock },
    maxLockAgeMinutes: 60,
  };
  const first = detectStall(input);
  const second = detectStall(input);
  assert.equal(first.stalled, second.stalled);
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test("tickDriftDetection — idempotent: same tasks same result", () => {
  const input = {
    workstream: { phase: "build" },
    tasks: [{ id: "t1", phase: "build" }],
    progress: {},
  };
  const first = tickDriftDetection(input);
  const second = tickDriftDetection(input);
  assert.equal(first.count, second.count);
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test("tickStallDetection — idempotent: same state same result", () => {
  const input = {
    task: { id: "t1", assignee: "codex", status: "running", updated_at: new Date().toISOString() },
    tuiSession: { session_id: "tui_a", last_heartbeat_at: new Date().toISOString(), status: "active" },
  };
  const first = tickStallDetection(input);
  const second = tickStallDetection(input);
  assert.equal(first.stalled, second.stalled);
  assert.equal(first.count, second.count);
});

test("scheduleRepairAction — idempotent: same input same action", () => {
  const input = {
    task: { id: "t_idem", root_task_id: "root_idem" },
    goal: {},
    acceptanceDecision: { verdict: "passed", findings: [] },
  };
  const first = scheduleRepairAction(input);
  const second = scheduleRepairAction(input);
  assert.equal(first.action, second.action);
});

// ---------------------------------------------------------------------------
// 7. Documentation enforcement
// ---------------------------------------------------------------------------

test("evaluateAcceptance — enforces documentation for docs_only profile", () => {
  const result = evaluateAcceptance({
    task: { id: "task_doc" },
    goal: { id: "goal_doc" },
    result: {
      summary: "Docs update",
      status: "completed",
      commit: "abc",
      changed_files: ["src/foo.mjs"],  // NOT docs files
      tests: "pass",
      verification: { passed: true, commands: [] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true },
    contract: { intent: { operation_kind: "docs_only" } },
    gitState: { dirty: false },
  });

  const docDim = result.dimensions.find((d) => d.dimension === "documentation_updated");
  assert.ok(docDim);
  assert.equal(docDim.passed, false, "docs_only profile should require .md files in changed_files");
});

test("evaluateAcceptance — passes documentation check when docs are present", () => {
  const result = evaluateAcceptance({
    task: { id: "task_doc_ok" },
    goal: { id: "goal_doc_ok" },
    result: {
      summary: "Docs update",
      status: "completed",
      commit: "def456",
      changed_files: ["docs/current-status.md", "README.md"],
      tests: "pass",
      verification: { passed: true, commands: [] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true },
    contract: { intent: { operation_kind: "docs_only" } },
    gitState: { dirty: false },
  });

  const docDim = result.dimensions.find((d) => d.dimension === "documentation_updated");
  assert.ok(docDim);
  assert.equal(docDim.passed, true);
});

test("evaluateAcceptance — documentation not required for non-docs profiles", () => {
  const result = evaluateAcceptance({
    task: { id: "task_impl" },
    goal: { id: "goal_impl" },
    result: {
      summary: "Implementation",
      status: "completed",
      commit: "ghi789",
      changed_files: ["src/new-feature.mjs"],
      tests: "pass",
      verification: { passed: true, commands: [] },
      reviewer_decision: "accepted",
    },
    verification: { passed: true },
    contract: { intent: { operation_kind: "implementation" } },
    gitState: { dirty: false },
  });

  const docDim = result.dimensions.find((d) => d.dimension === "documentation_updated");
  assert.equal(docDim.summary, "docs_not_required");
  assert.equal(docDim.passed, true);
});

// ---------------------------------------------------------------------------
// Combined tick flow: full runTick with eligible tasks
// ---------------------------------------------------------------------------

test("runTick — processes all 5 transition steps with eligible tasks", async () => {
  const result = await runTick({
    workstream: { phase: "build", workflow_id: "wf_test" },
    tasks: [
      { id: "t1", status: "assigned", phase: "build", scope: "wf_test" },
      { id: "t2", status: "completed", phase: "build", scope: "wf_test", result: {
        summary: "Done", status: "completed", commit: "abc",
        changed_files: ["src/a.mjs"], tests: "pass",
        verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
        reviewer_decision: "accepted",
      }},
    ],
    goal: { id: "goal_tick", acceptance_contract: { intent: { operation_kind: "implementation" } } },
    progress: { updated_at: new Date().toISOString() },
    maxTransitions: 5,
  });

  assert.ok(result.tick_id);
  assert.ok(result.transition_count >= 1);
  const kinds = result.transitions.map((t) => t.kind);
  assert.ok(kinds.includes(TRANSITION_KIND.DRIFT_DETECTED));
  assert.ok(kinds.includes(TRANSITION_KIND.STALL_DETECTED));
  assert.ok(kinds.includes(TRANSITION_KIND.ACCEPTANCE_EVALUATED));
  assert.ok(kinds.includes(TRANSITION_KIND.TASK_ADVANCED));
  assert.ok(kinds.includes(TRANSITION_KIND.REVIEW_RECONCILED));
});
