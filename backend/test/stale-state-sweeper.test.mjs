/**
 * stale-state-sweeper.test.mjs — Tests for the stale task state auto-sweeper.
 *
 * P0: Covers all six sweepable states:
 *   waiting_for_integration → completed (when local/remote aligned)
 *   waiting_for_integration → queued (when stale)
 *   waiting_for_repair → completed (when parent accepted)
 *   waiting_for_repair → failed (stale or exhausted)
 *   waiting_for_review → completed (when verified or stale with no blockers)
 *   retry_wait → queued (backoff elapsed) / blocked (exhausted)
 *   quota_wait → queued (backoff elapsed) / blocked (exhausted)
 *   applySweepActions store mutation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sweepStaleTaskStates, applySweepActions } from "../src/stale-state-sweeper.mjs";

// ===========================================================================
// waiting_for_integration sweeper
// ===========================================================================

test("sweeper: waiting_for_integration aligned local/remote → completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_int_1",
      status: "waiting_for_integration",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        commit: "abc123def456",
        remote_head: "abc123def456",
      },
    }],
    repoState: {
      localHead: "abc123def456",
      remoteHead: "abc123def456",
    },
    now,
  });

  assert.equal(actions.length, 1, "Should produce one sweep action");
  assert.equal(actions[0].taskId, "task_int_1");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.equal(actions[0].currentStatus, "waiting_for_integration");
  assert.ok(actions[0].reason.includes("aligned"), `Reason should mention aligned: ${actions[0].reason}`);
});

test("sweeper: waiting_for_integration aligned via repoState → completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_int_2",
      status: "waiting_for_integration",
      updated_at: new Date(now - 1000).toISOString(),
      result: {},
    }],
    repoState: {
      localHead: "xyz789",
      remoteHead: "xyz789",
    },
    now,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "completed");
});

test("sweeper: waiting_for_integration stale → queued", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_int_stale",
      status: "waiting_for_integration",
      updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
      result: {
        commit: "abc123",
        remote_head: "def456",
      },
    }],
    repoState: {
      localHead: "abc123",
      remoteHead: "def456",
    },
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "queued");
  assert.ok(actions[0].reason.includes("re-queuing"), `Reason should mention re-queuing: ${actions[0].reason}`);
});

test("sweeper: waiting_for_integration aligned only when heads actually equal", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "task_int_mismatch",
      status: "waiting_for_integration",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        commit: "abc111",
        remote_head: "abc222",
      },
    }],
    repoState: {
      localHead: "abc111",
      remoteHead: "abc222",
    },
    now,
  });

  assert.equal(actions.length, 0, "Mismatched heads with non-stale task should yield no action");
});

// ===========================================================================
// waiting_for_repair sweeper
// ===========================================================================

test("sweeper: waiting_for_repair parent completed → completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [
      { id: "parent_done", status: "completed" },
      {
        id: "repair_child",
        status: "waiting_for_repair",
        parent_task_id: "parent_done",
        updated_at: new Date(now - 1000).toISOString(),
      },
    ],
    now,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].taskId, "repair_child");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("parent"), `Reason should mention parent: ${actions[0].reason}`);
});

test("sweeper: waiting_for_repair parent not completed → no immediate action", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [
      { id: "parent_active", status: "running" },
      {
        id: "repair_child_2",
        status: "waiting_for_repair",
        parent_task_id: "parent_active",
        repair_attempt: 0,
        max_attempts: 2,
        updated_at: new Date(now - 1000).toISOString(),
      },
    ],
    now,
  });

  assert.equal(actions.length, 0);
});

test("sweeper: waiting_for_repair stale with max attempts exceeded → failed", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "repair_exhausted",
      status: "waiting_for_repair",
      parent_task_id: "parent_active",
      repair_attempt: 2,
      max_attempts: 2,
      updated_at: new Date(now - staleThresholdMs * 3).toISOString(),
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "failed");
  assert.ok(actions[0].reason.includes("exceeded"), `Reason should mention exceeded: ${actions[0].reason}`);
});

test("sweeper: waiting_for_repair stale with no parent → failed", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "repair_no_parent",
      status: "waiting_for_repair",
      parent_task_id: "parent_nonexistent",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "failed");
});

// ===========================================================================
// waiting_for_review sweeper
// ===========================================================================

test("sweeper: waiting_for_review verified + no blockers → completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_verified",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        verification: { passed: true },
      },
    }],
    now,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "completed");
});

test("sweeper: waiting_for_review non-blocker findings for sync profile → completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_sync",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      mode: "sync",
      result: {
        acceptance_findings: [{ severity: "major", code: "tests_missing", message: "No tests" }],
        acceptance_profile: "sync_only",
      },
    }],
    now,
  });

  assert.equal(actions.length, 1, "Sync-only with tests_missing should sweep to completed");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("sync_only"), `Reason should mention profile: ${actions[0].reason}`);
});

test("sweeper: waiting_for_review stale code_change with empty result NOT completed (P0-UA1)", () => {
  // P0-UA1: code_change tasks without structured evidence must remain blocking
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_stale_code_change",
      status: "waiting_for_review",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
      result: {},
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 0, "code_change with empty result should NOT auto-complete even when stale");
});

test("sweeper: waiting_for_review stale sync_only with no blockers → completed", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_stale_sync",
      status: "waiting_for_review",
      mode: "sync",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
      result: {
        verification: { passed: true },
        changed_files: [],
      },
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("verification passed"), `Reason should mention verification passed: ${actions[0].reason}`);
});

test("sweeper: waiting_for_review with blocker findings NOT completed for code_change", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_blocked",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      mode: "builder",
      result: {
        acceptance_findings: [
          { severity: "blocker", code: "codex_failed", message: "Codex failed" },
        ],
        acceptance_profile: "code_change",
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "code_change with blocker findings should not auto-complete");
});

test("sweeper: waiting_for_review stale with sync-specific blockers → completed", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_stale_sync",
      status: "waiting_for_review",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
      mode: "sync",
      result: {
        acceptance_findings: [
          { severity: "major", code: "tests_missing", message: "No tests" },
          { severity: "major", code: "changed_files_mismatch", message: "No files" },
        ],
        acceptance_profile: "sync_only",
      },
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("sync_only"), `Reason should mention profile: ${actions[0].reason}`);
});


// ===========================================================================
// P0-UA1: Evidence gate tests for waiting_for_review sweeper
// ===========================================================================
// These verify that auto-completion requires both closure/finalizer decision
// AND at least one reliable structured evidence -- not just finalizer alone.

test("P0-UA1: finalizer completed alone with NO evidence \u2192 NOT auto-completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_finalizer_no_evidence",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        finalizer_decision: { status: "completed" },
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "finalizer completed + no evidence should NOT auto-complete");
});

test("P0-UA1: finalizer completed + verification.passed \u2192 auto-completed", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_finalizer_with_verification",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        finalizer_decision: { status: "completed" },
        verification: { passed: true },
      },
    }],
    now,
  });

  assert.equal(actions.length, 1, "finalizer + verification evidence should auto-complete");
  assert.equal(actions[0].recommendedStatus, "completed");
});

test("P0-UA1: closure decision + acceptance_gate.passed clears findings (no syn verification)", () => {
  // Evidence gate clears acceptance findings but does NOT synthesise
  // verification.passed. Auto-completion still needs Rule 1.
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_closure_with_acceptance_gate",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        closure_decision: { status: "auto_completed_clean" },
        acceptance_gate: { passed: true },
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "evidence gate clears findings but does not synthesise verification.passed");
});

test("P0-UA1: contract_verification blocking_passed without verification.passed stays in review", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_contract_verif",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        closure_decision: { status: "auto_completed_clean" },
        contract_verification: { blocking_passed: true },
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "evidence without verification.passed keeps task in review");
});

test("P0-UA1: no-mutation profile with empty changed_files clears findings (needs Rule 1 or stale)", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_no_mutation_empty_files",
      status: "waiting_for_review",
      mode: "sync",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        finalizer_decision: { status: "completed" },
        changed_files: [],
        acceptance_profile: "sync_only",
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "evidence gate clears findings but needs Rule 1 or stale to complete");
});

test("P0-UA1: summary alone must NOT be accepted as evidence (requirement 2)", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_summary_only",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        closure_decision: { status: "auto_completed_clean" },
        summary: "Completed the implementation and all tasks are done",
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "summary alone must NOT be accepted as evidence");
});

test("P0-UA1: blocker findings preserved when no evidence to reconcile (requirement 3)", () => {
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "gate_blocker_findings_preserved",
      status: "waiting_for_review",
      updated_at: new Date(now - 1000).toISOString(),
      result: {
        finalizer_decision: { status: "completed" },
        acceptance_findings: [
          { severity: "blocker", code: "codex_failed", message: "Codex execution failed" },
        ],
      },
    }],
    now,
  });

  assert.equal(actions.length, 0, "blocker findings must be preserved when no evidence to reconcile");
});

test("P0-UA1: stale sync_only with empty result auto-completes via stale fallback (non-code_change)", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_stale_sync_fallback",
      status: "waiting_for_review",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
      mode: "sync",
      result: {
        acceptance_profile: "sync_only",
        changed_files: [],
      },
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "stale sync_only should auto-complete via stale fallback");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("stale"), `Should mention stale: ${actions[0].reason}`);
});

test("P0-UA1: stale code_change with verification evidence still auto-completes via Rule 1", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "review_stale_code_change_with_verified",
      status: "waiting_for_review",
      updated_at: new Date(now - staleThresholdMs * 4).toISOString(),
      result: {
        verification: { passed: true },
        commit: "abc1234",
      },
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "stale code_change with verification evidence should auto-complete");
  assert.equal(actions[0].recommendedStatus, "completed");
  assert.ok(actions[0].reason.includes("verification passed"), `Should complete via verification: ${actions[0].reason}`);
});


// ===========================================================================
// retry_wait sweeper
// ===========================================================================

test("sweeper: retry_wait backoff elapsed → queued", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "retry_backoff_done",
      status: "retry_wait",
      updated_at: new Date(now - 30_000).toISOString(),
      result: { failure_class: "gateway_error" },
      healing_retry_count: 0,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "Retry with backoff elapsed should re-queue");
  assert.equal(actions[0].recommendedStatus, "queued");
  assert.ok(actions[0].reason.includes("retry due"), `Reason should mention retry due: ${actions[0].reason}`);
});

test("sweeper: retry_wait budget exhausted → blocked", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "retry_exhausted",
      status: "retry_wait",
      updated_at: new Date(now - 30_000).toISOString(),
      result: { failure_class: "rate_limited" },
      healing_retry_count: 3,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "blocked");
  assert.ok(actions[0].reason.includes("budget exhausted"), `Reason should mention exhausted: ${actions[0].reason}`);
});

test("sweeper: retry_wait backoff not yet elapsed → no action", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  // gateway_error: baseDelay=10000, attempt=0 → minBackoff=10000
  // staleFor = 1000 < 10000 → not yet due
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "retry_not_due",
      status: "retry_wait",
      updated_at: new Date(now - 1000).toISOString(),
      result: { failure_class: "gateway_error" },
      healing_retry_count: 0,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 0, "Retry not yet due should yield no action");
});

// ===========================================================================
// quota_wait sweeper
// ===========================================================================

test("sweeper: quota_wait backoff elapsed → queued", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  // rate_limited: baseDelay=30000, attempt=0 → minBackoff=30000
  // staleFor = 60000 > 30000 → re-queue
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "quota_backoff_done",
      status: "quota_wait",
      updated_at: new Date(now - 60_000).toISOString(),
      result: { failure_class: "rate_limited" },
      healing_retry_count: 0,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1, "Quota with backoff elapsed should re-queue");
  assert.equal(actions[0].recommendedStatus, "queued");
  assert.ok(actions[0].reason.includes("quota wait"), `Reason should mention quota: ${actions[0].reason}`);
});

test("sweeper: quota_wait budget exhausted → blocked", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "quota_exhausted",
      status: "quota_wait",
      updated_at: new Date(now - 60_000).toISOString(),
      result: { failure_class: "rate_limited" },
      healing_retry_count: 3,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedStatus, "blocked");
  assert.ok(actions[0].reason.includes("budget exhausted"), `Reason should mention exhausted: ${actions[0].reason}`);
});

test("sweeper: quota_wait backoff not yet elapsed → no action", () => {
  const staleThresholdMs = 300_000;
  const now = Date.now();
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "quota_not_due",
      status: "quota_wait",
      updated_at: new Date(now - 1000).toISOString(),
      result: { failure_class: "rate_limited" },
      healing_retry_count: 0,
    }],
    now,
    staleThresholdMs,
  });

  assert.equal(actions.length, 0, "Quota not yet due should yield no action");
});

// ===========================================================================
// applySweepActions — store mutation tests
// ===========================================================================

test("sweeper: applySweepActions updates task status via store", async () => {
  // P0-MA11-R3: applySweepActions now uses store.mutate() (the correct
  // StateStore API), not store.updateTask() which never existed.
  // Use a real StateStore for the test.
  const { StateStore } = await import("../src/state-store.mjs");
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "sweeper-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.tasks = [{
    id: "task_complete_me",
    status: "waiting_for_review",
    logs: [],
  }];
  await store.save();

  const sweepActions = [{
    taskId: "task_complete_me",
    currentStatus: "waiting_for_review",
    recommendedStatus: "completed",
    reason: "Auto-sweep: verification passed",
    actions: [{
      type: "update_task_status",
      payload: { status: "completed" },
    }],
  }];

  const result = await applySweepActions(store, sweepActions);

  assert.equal(result.applied, 1);
  assert.equal(result.errors.length, 0);

  // Verify the store was actually mutated
  const state = await store.load();
  const task = state.tasks.find(t => t.id === "task_complete_me");
  assert.ok(task !== null);
  assert.equal(task.status, "completed");
  assert.ok(Array.isArray(task.logs));
  assert.ok(task.swept_at);
});

test("sweeper: applySweepActions reports error for non-existent task", async () => {
  // P0-MA11-R3: applySweepActions uses store.mutate() and reports errors
  // when a task ID is not found in state.
  const { StateStore } = await import("../src/state-store.mjs");
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "sweeper-test-"));
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.tasks = [];
  await store.save();

  const sweepActions = [{
    taskId: "task_missing",
    currentStatus: "retry_wait",
    recommendedStatus: "queued",
    reason: "Retry due",
    actions: [{
      type: "update_task_status",
      payload: { status: "queued" },
    }],
  }];

  const result = await applySweepActions(store, sweepActions);

  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].taskId, "task_missing");
  assert.ok(result.errors[0].error.includes("not found"));
});

test("sweeper: applySweepActions handles empty sweep actions", async () => {
  // P0-MA11-R3: applySweepActions does not require store.mutate when
  // there are no actions to apply.
  const result = await applySweepActions({}, []);

  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 0);
});
