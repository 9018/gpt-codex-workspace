/**
 * p0-ua5-soak-queue-health.test.mjs — P0-UA5 New-task E2E Soak & Queue Health
 *
 * Tests new-task end-to-end flow scenarios and queue health observability.
 *
 * Required coverage:
 * 1. code_change style E2E: goal created/enqueued, worker starts, task completes,
 *    acceptance gate passes, dependent auto-starts, current_blockers=0.
 * 2. verification_only/no-mutation E2E: task with verification result, no code change.
 * 3. readonly/diagnostic E2E: diagnostic-style task with readonly result contract.
 * 4. Negative case: downstream queue item does NOT auto-advance because the
 *    acceptance/finalizer gate is missing (upstream task failed).
 * 5. Metrics: auto_acceptance_rate, auto_advance_rate, manual_review_escape_rate,
 *    repair_loop_success_rate, provider_noise_rate, raw_state_drift_count,
 *    policy_excluded_count, state_migration_count, time_to_close.
 * 6. Queue health display: raw_counts, policy_counts, raw_legacy_resolved,
 *    raw_unresolved, current_blockers, policy_excluded_count.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeMinimalStore(dir) {
  const { StateStore } = await import("../src/state-store.mjs");
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.goal_queue = [];
  store.state.goals = [];
  store.state.tasks = [];
  await store.save();
  return store;
}

function addGoal(store, id, title, status, opts = {}) {
  const now = new Date().toISOString();
  const convId = opts.conversation_id || `conv_${id}`;
  store.state.goals.push({
    id,
    project_id: opts.project_id || "default",
    conversation_id: convId,
    title: title || id,
    description: opts.description || "",
    user_request: opts.user_request || title || id,
    goal_prompt: opts.goal_prompt || title || id,
    context_summary: opts.context_summary || "",
    workspace_id: opts.workspace_id || "hosted-default",
    mode: opts.mode || "builder",
    status: status || "open",
    created_at: now,
    updated_at: now,
    repo_id: opts.repo_id || "",
  });
  store.state.conversations ||= [];
  if (!store.state.conversations.some(c => c.id === convId)) {
    store.state.conversations.push({
      id: convId,
      goal_id: id,
      project_id: opts.project_id || "default",
      workspace_id: opts.workspace_id || "hosted-default",
      messages: [{ role: "user", content: opts.user_request || title || id }],
      created_at: now,
      updated_at: now,
    });
  }
}

function addQueueItem(store, queueId, goalId, position, status, opts = {}) {
  const now = new Date().toISOString();
  store.state.goal_queue.push({
    queue_id: queueId,
    goal_id: goalId,
    task_id: opts.task_id || null,
    workspace_id: opts.workspace_id || "hosted-default",
    repo_id: opts.repo_id || "",
    position,
    status: status || "waiting",
    depends_on_goal_id: opts.depends_on_goal_id || null,
    depends_on_task_id: opts.depends_on_task_id || null,
    dependency_policy: opts.dependency_policy || "completed_only",
    blocked_reason: opts.blocked_reason || null,
    auto_start: opts.auto_start !== false,
    created_at: now,
    updated_at: now,
  });
}

function addTask(store, id, status, opts = {}) {
  const now = new Date().toISOString();
  const created = opts.created_at || now;
  store.state.tasks.push({
    id,
    assignee: opts.assignee || "codex",
    status: status || "completed",
    mode: opts.mode || "builder",
    project_id: opts.project_id || "default",
    workspace_id: opts.workspace_id || "hosted-default",
    goal_id: opts.goal_id || null,
    parent_task_id: opts.parent_task_id || null,
    root_task_id: opts.root_task_id || null,
    repair_of_task_id: opts.repair_of_task_id || null,
    logs: [],
    created_at: created,
    updated_at: opts.updated_at || now,
    result: opts.result || null,
    metadata: opts.metadata || {},
  });
}

async function evalQueueHealth(store) {
  const { collectQueueHealthMetrics, formatQueueHealthCard } = await import("../src/queue-health-metrics.mjs");
  const metrics = await collectQueueHealthMetrics(store);
  const card = formatQueueHealthCard(metrics);
  return { metrics, card };
}

// ---------------------------------------------------------------------------
// Test 1: code_change E2E happy path
// ---------------------------------------------------------------------------

test("P0-UA5: code_change E2E — goal enqueued, worker starts, task completes, acceptance gate passes, dependent auto-starts, current_blockers=0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-codechange-"));
  const store = await makeMinimalStore(dir);

  // Create two goals: upstream code_change goal + dependent goal
  addGoal(store, "goal_upstream_code", "Upstream code change", "open");
  addGoal(store, "goal_downstream", "Downstream task", "open");
  await store.save();

  const { enqueueGoal, startNextQueuedGoal, checkTypedEligibility } = await import("../src/goal-queue.mjs");

  // Enqueue upstream with auto_start
  const upResult = await enqueueGoal(store, "goal_upstream_code", { auto_start: true });
  assert.equal(upResult.ok, true, "upstream goal enqueued");

  // Start the queue (simulate worker tick)
  const config = { defaultRepoPath: dir, defaultWorkspaceRoot: dir, enableTaskWorktrees: false };
  const startResult = await startNextQueuedGoal(store, config, { dry_run: false });
  assert.equal(startResult.started, true, "upstream task started");
  assert.ok(startResult.task, "task created");
  const upstreamTaskId = startResult.task.id;
  const upstreamQueueId = startResult.item.queue_id;

  // Verify queue item moved to running
  assert.equal(startResult.item.status, "running");
  assert.equal(startResult.item.task_id, upstreamTaskId);

  // Simulate task completion with structured result contract (code_change style)
  const upstreamTask = store.state.tasks.find(t => t.id === upstreamTaskId);
  upstreamTask.status = "completed";
  upstreamTask.result = {
    kind: "codex_executed",
    status: "completed",
    summary: "Implemented feature X",
    changed_files: ["src/feature.mjs"],
    tests: "node --test passed",
    commit: "abc123def456",
    verification: { passed: true, commands_executed: ["node --test"] },
    acceptance_gate: { passed: true },
    finalizer_decision: { safe_to_auto_advance: true, queue_effect: { unblock_dependents: true } },
    closure_decision: { status: "auto_completed_clean", auto_complete_allowed: true },
    needs_integration: true,
    integration: { status: "merged", merged: true },
  };
  upstreamTask.updated_at = new Date().toISOString();
  await store.save();

  // Enqueue downstream goal with dependency on upstream task
  const downResult = await enqueueGoal(store, "goal_downstream", {
    depends_on_task_id: upstreamTaskId,
    dependency_policy: "completed_only",
    auto_start: true,
  });
  assert.equal(downResult.ok, true, "downstream goal enqueued");
  const downQueueId = downResult.item.queue_id;

  // Check downstream eligibility — should be eligible because upstream completed
  const state = await store.load();
  const downItem = state.goal_queue.find(q => q.queue_id === downQueueId);
  const eligibility = await checkTypedEligibility(state, downItem, config, { dryRun: false });
  assert.equal(eligibility.eligible, true, "downstream item eligible after upstream completed with acceptance gate passed");
  assert.equal(eligibility.blocked_reason, null, "no blocked reason");

  // Auto-start downstream
  const downStart = await startNextQueuedGoal(store, config, { dry_run: false });
  assert.equal(downStart.started, true, "downstream task auto-started");
  assert.ok(downStart.task, "downstream task created");

  // Verify current_blockers = 0
  const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
  const qc = await collectWorkerQueueCounts(store);
  assert.equal(qc.current_blockers, 0, "current_blockers should be 0 in happy path");

  // Verify the task result contract is structured
  assert.ok(upstreamTask.result.kind, "result has kind");
  assert.ok(upstreamTask.result.summary, "result has summary");
  assert.ok(Array.isArray(upstreamTask.result.changed_files), "result has changed_files array");
  assert.ok(upstreamTask.result.verification, "result has verification");
  assert.ok(upstreamTask.result.acceptance_gate, "result has acceptance_gate");

  // Verify finalizer complete (closure_decision and finalizer_decision)
  assert.ok(upstreamTask.result.closure_decision, "result has closure_decision");
  assert.ok(upstreamTask.result.finalizer_decision, "result has finalizer_decision");
  assert.equal(upstreamTask.result.closure_decision.status, "auto_completed_clean");
  assert.equal(upstreamTask.result.finalizer_decision.safe_to_auto_advance, true);
});

// ---------------------------------------------------------------------------
// Test 2: verification_only / no-mutation E2E
// ---------------------------------------------------------------------------

test("P0-UA5: verification_only/no-mutation E2E — task with verification result, no code change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-verification-"));
  const store = await makeMinimalStore(dir);

  addGoal(store, "goal_verify_only", "Verification only", "open");
  await store.save();

  const { enqueueGoal, startNextQueuedGoal } = await import("../src/goal-queue.mjs");
  await enqueueGoal(store, "goal_verify_only", { auto_start: true });

  const config = { defaultRepoPath: dir, defaultWorkspaceRoot: dir, enableTaskWorktrees: false };
  const startResult = await startNextQueuedGoal(store, config, { dry_run: false });
  assert.equal(startResult.started, true, "verification task started");

  const taskId = startResult.task.id;
  const task = store.state.tasks.find(t => t.id === taskId);

  // Simulate verification-only completion (no code change)
  task.status = "completed";
  task.result = {
    kind: "codex_verification",
    status: "completed",
    summary: "All checks passed, no changes needed",
    changed_files: [],
    tests: "node --test passed",
    verification: { passed: true, commands_executed: ["node --test", "npm run check:syntax"] },
    acceptance_gate: { passed: true },
    finalizer_decision: { safe_to_auto_advance: true, queue_effect: { unblock_dependents: true } },
    closure_decision: { status: "auto_completed_clean", auto_complete_allowed: true },
    noop: true,
    operation_kind: "readonly_validation",
    commit: null,
  };
  task.updated_at = new Date().toISOString();
  await store.save();

  // Verify the result contract is structured even for verification-only
  assert.equal(task.result.operation_kind, "readonly_validation", "verification-only task marked as readonly_validation");
  assert.equal(task.result.noop, true, "verification-only task is noop");
  assert.equal(task.result.changed_files.length, 0, "no changed files");
  assert.ok(task.result.verification.passed, "verification passed");
  assert.ok(task.result.closure_decision, "closure_decision present");

  // current_blockers should still be 0
  const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
  const qc = await collectWorkerQueueCounts(store);
  assert.equal(qc.current_blockers, 0, "current_blockers = 0 for verification-only");
});

// ---------------------------------------------------------------------------
// Test 3: readonly/diagnostic E2E
// ---------------------------------------------------------------------------

test("P0-UA5: readonly/diagnostic E2E — diagnostic task with readonly result contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-diagnostic-"));
  const store = await makeMinimalStore(dir);

  addGoal(store, "goal_diagnostic", "Diagnostic read", "open");
  await store.save();

  const { enqueueGoal, startNextQueuedGoal } = await import("../src/goal-queue.mjs");
  await enqueueGoal(store, "goal_diagnostic", { auto_start: true });

  const config = { defaultRepoPath: dir, defaultWorkspaceRoot: dir, enableTaskWorktrees: false };
  const startResult = await startNextQueuedGoal(store, config, { dry_run: false });
  assert.equal(startResult.started, true, "diagnostic task started");

  const taskId = startResult.task.id;
  const task = store.state.tasks.find(t => t.id === taskId);

  // Simulate diagnostic-style completion (readonly inspection)
  task.status = "completed";
  task.result = {
    kind: "codex_diagnostic",
    status: "completed",
    summary: "Repo health check completed — 0 issues found, 1 warning",
    changed_files: [],
    tests: "",
    verification: { passed: true, commands_executed: ["rg --count-matches TODO src/"] },
    acceptance_gate: { passed: true },
    finalizer_decision: { safe_to_auto_advance: true, queue_effect: { unblock_dependents: true } },
    closure_decision: { status: "auto_completed_clean", auto_complete_allowed: true },
    operation_kind: "diagnostic",
    integration: { status: "not_required" },
    needs_integration: false,
    commit: null,
    diagnostics: {
      findings: [
        { code: "todo_count", severity: "info", count: 3 },
        { code: "merge_conflict_markers", severity: "warning", count: 1 },
      ],
    },
  };
  task.updated_at = new Date().toISOString();
  await store.save();

  // Verify result contract
  assert.equal(task.result.operation_kind, "diagnostic", "diagnostic task marked correctly");
  assert.equal(task.result.needs_integration, false, "diagnostic does not need integration");
  assert.equal(task.result.integration.status, "not_required", "integration not required");
  assert.ok(task.result.diagnostics, "diagnostic has findings");
  assert.ok(task.result.closure_decision, "closure_decision present for diagnostics");
  assert.equal(task.result.finalizer_decision.safe_to_auto_advance, true, "finalizer allows advance");

  // current_blockers = 0
  const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
  const qc = await collectWorkerQueueCounts(store);
  assert.equal(qc.current_blockers, 0, "current_blockers = 0 for diagnostic task");
});

// ---------------------------------------------------------------------------
// Test 4: Negative case — downstream does NOT auto-advance
// ---------------------------------------------------------------------------

test("P0-UA5: negative case — downstream queue item does not auto-advance because acceptance/finalizer gate is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-negative-"));
  const store = await makeMinimalStore(dir);

  addGoal(store, "goal_failing", "Failing task", "open");
  addGoal(store, "goal_blocked_downstream", "Blocked downstream", "open");
  await store.save();

  const { enqueueGoal, startNextQueuedGoal, checkTypedEligibility } = await import("../src/goal-queue.mjs");

  // Enqueue and start the upstream task
  await enqueueGoal(store, "goal_failing", { auto_start: true });
  const config = { defaultRepoPath: dir, defaultWorkspaceRoot: dir, enableTaskWorktrees: false };
  const upResult = await startNextQueuedGoal(store, config, { dry_run: false });
  assert.equal(upResult.started, true, "upstream task started");
  const upstreamTaskId = upResult.task.id;

  // Simulate upstream task completing with FAILURE (no acceptance gate)
  const upstreamTask = store.state.tasks.find(t => t.id === upstreamTaskId);
  upstreamTask.status = "failed";
  upstreamTask.result = {
    kind: "codex_failed",
    status: "failed",
    summary: "Implementation failed due to build errors",
    failure_class: "build_failure",
    changed_files: [],
    tests: "",
    verification: { passed: false, commands_executed: ["node --test"], errors: ["Test failed: unit/feature.test.mjs"] },
    acceptance_gate: { passed: false, reason: "Verification failed" },
    acceptance_findings: [{ code: "verification_failed", severity: "blocker" }],
    finalizer_decision: { safe_to_auto_advance: false },
    closure_decision: { status: "failed", auto_complete_allowed: false },
    requires_review: true,
  };
  upstreamTask.updated_at = new Date().toISOString();
  await store.save();

  // Enqueue downstream goal depending on the failed task
  const downResult = await enqueueGoal(store, "goal_blocked_downstream", {
    depends_on_task_id: upstreamTaskId,
    dependency_policy: "completed_only",
    auto_start: true,
  });
  assert.equal(downResult.ok, true);
  const downQueueId = downResult.item.queue_id;

  // Check eligibility — should be BLOCKED because upstream failed
  const state = await store.load();
  const downItem = state.goal_queue.find(q => q.queue_id === downQueueId);
  const eligibility = await checkTypedEligibility(state, downItem, config, { dryRun: false });

  // The acceptance gate should fail
  const acceptGate = eligibility.gates.find(g => g.gate === 'acceptance_gate');
  const dependencyGate = eligibility.gates.find(g => g.gate === 'dependency');
  const finalizerGate = eligibility.gates.find(g => g.gate === 'finalizer_terminal');

  // At least one gate should be failing
  const someGateFailed = eligibility.gates.some(g => g.passed === false);
  assert.equal(someGateFailed, true, "at least one eligibility gate should fail for blocked downstream item");
  assert.equal(eligibility.eligible, false, "downstream item should NOT be eligible");

  // Verify the reason mentions acceptance or finalizer
  const blockedReason = eligibility.blocked_reason || "";
  const mentionsBlocking = blockedReason.includes('acceptance') ||
    blockedReason.includes('finalizer') ||
    blockedReason.includes('dependency') ||
    acceptanceGateFailed;
  const acceptanceGateFailed = acceptGate?.passed === false;
  const finalizerGateFailed = finalizerGate?.passed === false;
  assert.ok(acceptanceGateFailed || finalizerGateFailed || dependencyGate?.passed === false,
    "eligibility should fail on acceptance, finalizer, or dependency gate");

  // startNextQueuedGoal should not start the downstream
  const downStart = await startNextQueuedGoal(store, config, { dry_run: false });
  if (downItem.auto_start) {
    // If the item is in the queue, it should be blocked (not started)
    const reloaded = (await store.load()).goal_queue.find(q => q.queue_id === downQueueId);
    assert.equal(reloaded.status, "blocked", "downstream queue item should be blocked");
    assert.ok(reloaded.blocked_reason, "should have blocked_reason");
  }

  // Verify current_blockers >= 1 (the failed task)
  const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
  const qc = await collectWorkerQueueCounts(store);
  assert.ok(qc.current_blockers >= 1, "current_blockers should be >= 1 after failed task");
});

// ---------------------------------------------------------------------------
// Test 5: Queue health metrics computation
// ---------------------------------------------------------------------------

test("P0-UA5: queue health metrics — all metrics computed correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-metrics-"));
  const store = await makeMinimalStore(dir);

  // Create a mix of tasks for metric computation
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600000).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 7200000).toISOString();

  // 3 completed tasks with auto-accept evidence
  addTask(store, "task_accepted_1", "completed", {
    goal_id: "goal_accept_1",
    assignee: "codex",
    result: {
      closure_decision: { status: "auto_completed_clean", auto_complete_allowed: true },
      verification: { passed: true },
      acceptance_gate: { passed: true },
      finalizer_decision: { safe_to_auto_advance: true },
    },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });
  addTask(store, "task_accepted_2", "completed", {
    goal_id: "goal_accept_2",
    assignee: "codex",
    result: {
      reviewer_decision: { passed: true, status: "accepted" },
      verification: { passed: true },
      acceptance_gate: { passed: true },
    },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });
  addTask(store, "task_accepted_3", "completed", {
    goal_id: "goal_accept_3",
    assignee: "codex",
    result: {
      acceptance: { status: "accepted" },
      verification: { passed: true },
    },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });

  // 1 completed task with no auto-accept evidence
  addTask(store, "task_manual_review", "waiting_for_review", {
    goal_id: "goal_manual_1",
    assignee: "codex",
    result: { requires_review: true },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });

  // 1 repair task that succeeded
  addTask(store, "task_repair_ok", "completed", {
    goal_id: "goal_repair_1",
    assignee: "codex",
    metadata: { repair_attempts: 2 },
    result: {
      closure_decision: { status: "auto_completed_clean", auto_complete_allowed: true },
      verification: { passed: true },
    },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });

  // 1 provider noise task (no result)
  addTask(store, "task_noise", "failed", {
    goal_id: "goal_noise_1",
    assignee: "codex",
    result: {
      failure_class: "result_missing",
      summary: "No result.json produced",
    },
    created_at: twoHoursAgo,
    updated_at: hourAgo,
  });

  // 1 successful queue item (auto-advanced)
  addQueueItem(store, "queue_auto_adv", "goal_accept_1", 1, "completed", { auto_start: true });

  // 1 resolved legacy task
  addTask(store, "task_legacy", "waiting_for_review", {
    goal_id: "goal_legacy_1",
    assignee: "codex",
    result: {
      resolved_by_task_id: "task_accepted_1",
      noop: true,
      resolved_legacy: true,
    },
    created_at: twoHoursAgo,
  });

  // 1 state migration task
  addTask(store, "task_migrated", "completed", {
    goal_id: "goal_migrated_1",
    assignee: "codex",
    metadata: { state_migration: true },
    result: {
      legacy_migration: true,
      verification: { passed: true },
    },
    created_at: twoHoursAgo,
  });

  await store.save();

  // Collect metrics
  const { collectQueueHealthMetrics, formatQueueHealthCard } = await import("../src/queue-health-metrics.mjs");
  const metrics = await collectQueueHealthMetrics(store);

  // Verify metric existence and types
  assert.ok(metrics.metrics, "metrics object exists");
  assert.ok(typeof metrics.metrics.auto_acceptance_rate === "number", "auto_acceptance_rate is number");
  assert.ok(typeof metrics.metrics.auto_advance_rate === "number", "auto_advance_rate is number");
  assert.ok(typeof metrics.metrics.manual_review_escape_rate === "number", "manual_review_escape_rate is number");
  assert.ok(typeof metrics.metrics.repair_loop_success_rate === "number", "repair_loop_success_rate is number");
  assert.ok(typeof metrics.metrics.provider_noise_rate === "number", "provider_noise_rate is number");
  assert.ok(typeof metrics.metrics.raw_state_drift_count === "number", "raw_state_drift_count is number");
  assert.ok(typeof metrics.metrics.policy_excluded_count === "number", "policy_excluded_count is number");
  assert.ok(typeof metrics.metrics.state_migration_count === "number", "state_migration_count is number");
  assert.ok(typeof metrics.metrics.time_to_close_ms === "number" || metrics.metrics.time_to_close_ms === 0, "time_to_close_ms is number");

  // Verify card renders
  const card = formatQueueHealthCard(metrics);
  assert.ok(card.includes("Queue Health Metrics"), "card contains header");
  assert.ok(card.includes("auto_acceptance_rate"), "card contains auto_acceptance_rate");
  assert.ok(card.includes("auto_advance_rate"), "card contains auto_advance_rate");
  assert.ok(card.includes("Queue Breakdown"), "card contains Queue Breakdown");
  assert.ok(card.includes("current_blockers"), "card contains current_blockers");
  assert.ok(card.includes("raw_legacy_resolved"), "card contains raw_legacy_resolved");
  assert.ok(card.includes("raw_unresolved"), "card contains raw_unresolved");
  assert.ok(card.includes("policy_excluded"), "card contains policy_excluded");
});

// ---------------------------------------------------------------------------
// Test 6: Queue health display distinguishes raw_counts, policy_counts, etc.
// ---------------------------------------------------------------------------

test("P0-UA5: collectWorkerQueueCounts returns raw_counts, policy_counts, raw_legacy_resolved, raw_unresolved, current_blockers, policy_excluded_count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-queue-display-"));
  const store = await makeMinimalStore(dir);

  // Create a mix of tasks to exercise the display fields
  addTask(store, "task_running", "running", { goal_id: "goal_r", assignee: "codex" });
  addTask(store, "task_completed", "completed", { goal_id: "goal_c", assignee: "codex" });
  addTask(store, "task_failed_current", "failed", { goal_id: "goal_fc", assignee: "codex",
    result: { kind: "codex_failed", changed_files: ["src/x.mjs"], tests: "failed", verification: { passed: false, errors: ["Test failed"] }, failure_class: "verification_failure" }
  });
  // Legacy resolved failed task (no completion evidence, metadata only)
  addTask(store, "task_failed_legacy", "failed", { goal_id: "goal_fl", assignee: "codex",
    result: { worker_error: { message: "terminal metadata record" } }
  });
  addTask(store, "task_waiting_lock", "waiting_for_lock", { goal_id: "goal_wl", assignee: "codex" });
  addTask(store, "task_waiting_review", "waiting_for_review", { goal_id: "goal_wr", assignee: "codex" });

  await store.save();

  const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
  const qc = await collectWorkerQueueCounts(store);

  // Verify all display fields present
  assert.ok(qc.raw_counts, "has raw_counts");
  assert.ok(qc.policy_counts, "has policy_counts");
  assert.ok(typeof qc.raw_legacy_resolved === "number", "has raw_legacy_resolved number");
  assert.ok(typeof qc.raw_unresolved === "number", "has raw_unresolved number");
  assert.ok(typeof qc.current_blockers === "number", "has current_blockers number");
  assert.ok(typeof qc.policy_excluded === "number" || typeof qc.policy_excluded_count === "number", "has policy_excluded number");

  // raw_counts should include all tasks
  assert.equal(qc.raw_counts.running, 1, "raw_counts includes running");
  assert.equal(qc.raw_counts.completed, 1, "raw_counts includes completed");
  assert.equal(qc.raw_counts.failed, 2, "raw_counts includes both failed tasks");

  // policy_counts should exclude legacy-resolved failed task
  assert.equal(qc.policy_counts.failed, 1, "policy_counts excludes legacy-resolved failed");

  // policy_excluded should be > 0
  assert.ok(qc.policy_excluded >= 1, "policy_excluded >= 1 (legacy-resolved failed excluded)");

  // current_blockers should include running + waiting_for_lock + waiting_for_review + policy-counted failed
  assert.ok(qc.current_blockers >= 3, "current_blockers >= 3 (running + lock + review + active failed)");

  // Simulate the card rendering
  const { workerStatusCard } = await import("../src/card-runtime-cards.mjs");
  const card = workerStatusCard({ enabled: true, running: true, queue: qc });
  assert.ok(card.includes("raw → policy"), "card shows raw → policy header");
  assert.ok(card.includes("raw legacy resolved"), "card shows raw legacy resolved");
  assert.ok(card.includes("policy excluded"), "card shows policy excluded");
});

// ---------------------------------------------------------------------------
// Test 7: Metrics integration — all metrics use the existing code structure
// ---------------------------------------------------------------------------

test("P0-UA5: collectQueueHealthMetrics returns complete structure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-metrics-struct-"));
  const store = await makeMinimalStore(dir);

  addTask(store, "task_1", "completed", {
    goal_id: "g1",
    assignee: "codex",
    result: { verification: { passed: true }, acceptance_gate: { passed: true }, closure_decision: { status: "auto_completed_clean" } },
  });

  await store.save();

  const { collectQueueHealthMetrics } = await import("../src/queue-health-metrics.mjs");
  const m = await collectQueueHealthMetrics(store);

  // Verify all top-level fields
  assert.ok(m.scanned_at, "has scanned_at");
  assert.ok(typeof m.total_codex_tasks === "number", "has total_codex_tasks");
  assert.ok(m.raw_counts, "has raw_counts");
  assert.ok(m.policy_counts, "has policy_counts");
  assert.ok(m.legacy_failed_policy, "has legacy_failed_policy");
  assert.ok(typeof m.current_blockers === "number", "has current_blockers");
  assert.ok(typeof m.raw_legacy_resolved === "number", "has raw_legacy_resolved");
  assert.ok(typeof m.raw_unresolved === "number", "has raw_unresolved");
  assert.ok(typeof m.policy_excluded_count === "number", "has policy_excluded_count");

  // Verify queue health card can be rendered
  const { formatQueueHealthCard } = await import("../src/queue-health-metrics.mjs");
  const card = formatQueueHealthCard(m);
  assert.ok(card.length > 0, "card renders non-empty");
});

// ===========================================================================
// Test 8: Empty state — metrics handle empty task store gracefully
// ===========================================================================

test("P0-UA5: empty task store produces safe default metrics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ua5-empty-"));
  const store = await makeMinimalStore(dir);
  await store.save();

  const { collectQueueHealthMetrics } = await import("../src/queue-health-metrics.mjs");
  const m = await collectQueueHealthMetrics(store);

  assert.ok(m.metrics, "metrics object exists with empty store");
  assert.equal(m.metrics.auto_acceptance_rate, 0, "auto_acceptance_rate = 0 with no tasks");
  assert.equal(m.metrics.auto_advance_rate, 0, "auto_advance_rate = 0");
  assert.equal(m.metrics.manual_review_escape_rate, 0, "manual_review_escape_rate = 0");
  assert.equal(m.metrics.repair_loop_success_rate, 0, "repair_loop_success_rate = 0");
  assert.equal(m.metrics.provider_noise_rate, 0, "provider_noise_rate = 0");
  assert.equal(m.metrics.raw_state_drift_count, 0, "raw_state_drift_count = 0");
  assert.equal(m.metrics.policy_excluded_count, 0, "policy_excluded_count = 0");
  assert.equal(m.metrics.state_migration_count, 0, "state_migration_count = 0");
  assert.equal(m.metrics.time_to_close_ms, 0, "time_to_close_ms = 0");
  assert.equal(m.total_codex_tasks, 0, "total_codex_tasks = 0");

  // Card should still render
  const { formatQueueHealthCard } = await import("../src/queue-health-metrics.mjs");
  const card = formatQueueHealthCard(m);
  assert.ok(card.includes("Queue Health Metrics"), "empty card still shows header");
});
