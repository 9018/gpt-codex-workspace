/**
 * p0-c8-queue-auto-advance.test.mjs
 *
 * P0-C8: Queue Auto-Advance Reconciler
 *
 * Tests covering:
 *   1. Upstream readonly closure unblocks dependent
 *   2. Upstream mutating task accepted but not integrated does NOT unblock
 *   3. Upstream integrated completion unblocks dependent
 *   4. Repair successor success resolves original and unblocks dependent
 *   5. Failed terminal blocks or routes dependent according to explicit policy
 *   6. Stale blocker detection
 *   7. Dry-run diagnostics
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ===========================================================================
// Imports from queue-reconciler
// ===========================================================================

import {
  QUEUE_TERMINAL_COMPLETED,
  isQueueTerminalCompleted,
  isQueueTerminalFailed,
  isQueueTerminal,
  resolveQueueDependencyState,
  detectStaleBlockers,
  diagnoseQueueItems,
  reconcileQueue,
  propagateRepairSuccess,
  explainQueueDecision,
} from "../src/queue-reconciler.mjs";

// ===========================================================================
// Imports from queue-policy
// ===========================================================================

import {
  QUEUE_EXTENDED_COMPLETED_STATUSES,
  ALL_QUEUE_TERMINAL_COMPLETED,
  isExtendedTerminalCompleted,
  isIntegrationNotRequired,
  isIntegrationSatisfied,
} from "../src/queue-policy.mjs";

// ===========================================================================
// SCENARIO 1: Upstream readonly closure unblocks dependent
// ===========================================================================

test("P0-C8 SCENARIO 1: Upstream readonly closure unblocks dependent", async (t) => {
  await t.test("isExtendedTerminalCompleted recognizes readonly_closed", () => {
    assert.equal(isExtendedTerminalCompleted("readonly_closed"), true);
    assert.equal(QUEUE_EXTENDED_COMPLETED_STATUSES.has("readonly_closed"), true);
    assert.equal(ALL_QUEUE_TERMINAL_COMPLETED.has("readonly_closed"), true);
  });

  await t.test("resolveQueueDependencyState: readonly completed task unblocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_readonly",
          status: "completed",
          result: {
            operation_kind: "readonly_validation",
            needs_integration: false,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_readonly",
          blocked_reason: "waiting for task_readonly",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, true);
    assert.equal(depState.readonly_operation, true);
    assert.equal(depState.integration_required_and_missing, false);
    assert.match(depState.detail, /readonly/);
  });

  await t.test("diagnoseQueueItems: readonly completed shows can_advance=true", () => {
    const state = {
      tasks: [
        {
          id: "task_readonly",
          status: "completed",
          result: {
            operation_kind: "readonly_validation",
            needs_integration: false,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          goal_title: "Dependent Goal",
          status: "blocked",
          depends_on_task_id: "task_readonly",
          blocked_reason: "waiting for task_readonly",
        },
      ],
      goals: [],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.dry_run, true);
    assert.equal(diag.queue_items_count, 1);
    assert.equal(diag.scans.length, 1);
    assert.equal(diag.scans[0].can_advance, true);
    assert.equal(diag.scans[0].action, "unblock");
    assert.equal(diag.scans[0].readonly_operation, true);
    assert.equal(diag.scans[0].integration_required_and_missing, false);
  });

  await t.test("isIntegrationNotRequired recognizes readonly operations", () => {
    assert.equal(isIntegrationNotRequired({ operation_kind: "readonly_validation" }), true);
    assert.equal(isIntegrationNotRequired({ operation_kind: "diagnostic" }), true);
    assert.equal(isIntegrationNotRequired({ operation_kind: "already_integrated" }), true);
    assert.equal(isIntegrationNotRequired({ kind: "noop" }), true);
    assert.equal(isIntegrationNotRequired({ integration: { status: "skipped" } }), true);
    assert.equal(isIntegrationNotRequired({ integration: { status: "not_required" } }), true);
    assert.equal(isIntegrationNotRequired({ needs_integration: false }), true);
    assert.equal(isIntegrationNotRequired({}), false);
    assert.equal(isIntegrationNotRequired(null), false);
  });

  await t.test("explainQueueDecision: readonly closure returns advance", () => {
    const state = {
      tasks: [
        {
          id: "task_readonly",
          status: "completed",
          result: { operation_kind: "readonly_validation" },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_readonly",
        },
      ],
      goals: [],
    };

    const decision = explainQueueDecision(state, state.goal_queue[0]);
    assert.equal(decision.decision, "advance");
    assert.equal(decision.readonly_operation, true);
    assert.equal(decision.integration_required_and_missing, false);
    assert.ok(decision.reason);
  });
});

// ===========================================================================
// SCENARIO 2: Upstream mutating task accepted but not integrated
// ===========================================================================

test("P0-C8 SCENARIO 2: Upstream mutating task accepted but not integrated does NOT unblock", async (t) => {
  await t.test("isIntegrationSatisfied returns false for non-integrated mutating task", () => {
    assert.equal(isIntegrationSatisfied({ commit: "abc123", needs_integration: true }), false);
    assert.equal(isIntegrationSatisfied({ commit: "abc123" }), false);
    assert.equal(isIntegrationSatisfied({}), false);
    assert.equal(isIntegrationSatisfied(null), false);
  });

  await t.test("isIntegrationSatisfied returns true for integrated tasks", () => {
    assert.equal(isIntegrationSatisfied({ integration: { merged: true } }), true);
    assert.equal(isIntegrationSatisfied({ integration: { status: "merged" } }), true);
    assert.equal(isIntegrationSatisfied({ auto_integration_completion: { completed: true } }), true);
    assert.equal(isIntegrationSatisfied({ delivery_result_recovery: { commit_integrated: true } }), true);
  });

  await t.test("resolveQueueDependencyState: completed mutating + not integrated blocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_mutating",
          status: "completed",
          result: {
            commit: "abc123",
            needs_integration: true,
            integration: { required: true },
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_mutating",
          blocked_reason: "waiting for task_mutating",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, false);
    assert.equal(depState.integration_required_and_missing, true);
    assert.equal(depState.readonly_operation, false);
    assert.match(depState.detail, /integration still required/);
  });

  await t.test("resolveQueueDependencyState: completed mutating + no integration needs blocks when needs_integration", () => {
    // When task result.commit is set and needs_integration is not explicitly false,
    // the reconciler should treat it as potentially needing integration
    const state = {
      tasks: [
        {
          id: "task_mutating",
          status: "completed",
          result: {
            commit: "abc123",
            // No explicit integration info — but has commit, so likely needs integration
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "waiting",
          depends_on_task_id: "task_mutating",
        },
      ],
      goals: [],
    };

    // Without explicit integration info and without commit,
    // the policy should fall back to standard "completed" check
    // which checks if the task has needs_integration or integration.required
    // Since the task has no integration metadata, the fallback is
    // to check via isIntegrationRequired... which the current code
    // only checks when status is "completed" and we have task result.
    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    // Task result has commit but no explicit integration info
    // The check: if (needsIntegration || task?.result?.commit) — will be true
    // because task.result.commit is truthy
    assert.equal(depState.integration_required_and_missing, true);
    assert.equal(depState.effective_completed, false);
  });

  await t.test("diagnoseQueueItems: non-integrated mutating shows can_advance=false with integration_required_and_missing", () => {
    const state = {
      tasks: [
        {
          id: "task_mutating",
          status: "completed",
          result: {
            commit: "abc123",
            needs_integration: true,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          goal_title: "Dependent Goal",
          status: "waiting",
          depends_on_task_id: "task_mutating",
        },
      ],
      goals: [],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.scans.length, 1);
    assert.equal(diag.scans[0].can_advance, false);
    assert.equal(diag.scans[0].integration_required_and_missing, true);
    assert.equal(diag.scans[0].action, "block_on_integration");
    assert.equal(diag.summary.integration_required_and_missing, 1);
  });

  await t.test("checkDependencyExtended would not satisfy for unintegrated mutating task", () => {
    // This tests the critical constraint: "Do not unblock dependents
    // when upstream is only accepted but integration is still required"
    const state = {
      tasks: [
        {
          id: "task_unintegrated",
          status: "completed",
          result: {
            commit: "def456",
            needs_integration: true,
            // no integration.merged, no auto_integration_completion
          },
        },
      ],
      goals: [],
    };

    // resolveQueueDependencyState should flag this
    const item = {
      depends_on_task_id: "task_unintegrated",
    };

    const depState = resolveQueueDependencyState(state, item);
    assert.equal(depState.integration_required_and_missing, true,
      "must_not: unblock on accepted but unintegrated mutating task");
    assert.equal(depState.effective_completed, false);
  });

  await t.test("explainQueueDecision: unintegrated mutating returns block_on_integration_required", () => {
    const state = {
      tasks: [
        {
          id: "task_mutating",
          status: "completed",
          result: { commit: "abc123", needs_integration: true },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "waiting",
          depends_on_task_id: "task_mutating",
        },
      ],
      goals: [],
    };

    const decision = explainQueueDecision(state, state.goal_queue[0]);
    assert.equal(decision.decision, "block_on_integration_required");
    assert.equal(decision.integration_required_and_missing, true);
  });
});

// ===========================================================================
// SCENARIO 3: Upstream integrated completion unblocks dependent
// ===========================================================================

test("P0-C8 SCENARIO 3: Upstream integrated completion unblocks dependent", async (t) => {
  await t.test("resolveQueueDependencyState: completed + integrated unblocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_integrated",
          status: "completed",
          result: {
            commit: "abc123",
            integration: { merged: true, status: "merged" },
            needs_integration: true,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_integrated",
          blocked_reason: "waiting for task_integrated",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, true);
    assert.equal(depState.integration_required_and_missing, false);
    assert.match(depState.detail, /integrated/);
  });

  await t.test("resolveQueueDependencyState: auto-integration completed unblocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_auto_integrated",
          status: "completed",
          result: {
            auto_integration_completion: { completed: true },
            needs_integration: true,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_auto_integrated",
          blocked_reason: "waiting for task_auto_integrated",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, true);
    assert.equal(depState.integration_required_and_missing, false);
  });

  await t.test("diagnoseQueueItems: integrated completion shows can_advance=true", () => {
    const state = {
      tasks: [
        {
          id: "task_integrated",
          status: "completed",
          result: {
            commit: "abc123",
            integration: { merged: true, status: "merged" },
            needs_integration: true,
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          goal_title: "Dependent Goal",
          status: "waiting",
          depends_on_task_id: "task_integrated",
        },
      ],
      goals: [],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.scans.length, 1);
    assert.equal(diag.scans[0].can_advance, true);
    assert.equal(diag.scans[0].integration_required_and_missing, false);
  });

  await t.test("isIntegrationSatisfied recognizes auto-integration completion", () => {
    assert.equal(
      isIntegrationSatisfied({ auto_integration_completion: { completed: true } }),
      true
    );
  });

  await t.test("isIntegrationSatisfied recognizes delivery recovery with integrated commit", () => {
    assert.equal(
      isIntegrationSatisfied({ delivery_result_recovery: { commit_integrated: true } }),
      true
    );
  });

  await t.test("isIntegrationSatisfied recognizes normalized delivery state", () => {
    assert.equal(
      isIntegrationSatisfied({
        commit: "abc123",
        verification: { passed: true },
        delivery_state_normalized: true,
      }),
      true
    );
  });
});

// ===========================================================================
// SCENARIO 4: Repair successor success resolves original and unblocks dependent
// ===========================================================================

test("P0-C8 SCENARIO 4: Repair successor success resolves original and unblocks dependent", async (t) => {
  await t.test("QUEUE_EXTENDED_COMPLETED_STATUSES includes resolved_by_successor", () => {
    assert.equal(QUEUE_EXTENDED_COMPLETED_STATUSES.has("resolved_by_successor"), true);
    assert.equal(QUEUE_EXTENDED_COMPLETED_STATUSES.has("superseded"), true);
  });

  await t.test("isExtendedTerminalCompleted recognizes resolved_by_successor", () => {
    assert.equal(isExtendedTerminalCompleted("resolved_by_successor"), true);
    assert.equal(isExtendedTerminalCompleted("superseded"), true);
  });

  await t.test("resolveQueueDependencyState: resolved_by_successor unblocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_repaired",
          status: "resolved_by_successor",
          result: {
            repair_outcome: "repaired",
            repaired_by_task_id: "task_repair_1",
          },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_repaired",
          blocked_reason: "waiting for task_repaired",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, true);
    assert.equal(depState.is_repair_successor, true);
    assert.match(depState.detail, /repair successor/);
  });

  await t.test("propagateRepairSuccess: dry-run reports what would change", async () => {
    const state = {
      tasks: [
        { id: "task_original", status: "completed", result: { repair_outcome: "repaired", repaired_by_task_id: "task_repair" } },
        { id: "task_repair", status: "completed", root_task_id: "task_original", parent_task_id: "task_original", result: { repair_outcome: "repaired" } },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_original",
          blocked_reason: "waiting for original task",
        },
      ],
    };

    const result = await propagateRepairSuccess(state, state.tasks[1], { dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.propagated, true);
    assert.equal(result.affected_count, 1);
    assert.equal(result.affected[0].action, "would_unblock");
    assert.equal(result.unblocked_count, 1);
  });

  await t.test("propagateRepairSuccess: unblocks dependents when applied", async () => {
    const state = {
      tasks: [
        { id: "task_original", status: "resolved_by_successor" },
        { id: "task_repair", status: "completed", root_task_id: "task_original", parent_task_id: "task_original" },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_original",
          blocked_reason: "waiting for original",
        },
      ],
    };

    const result = await propagateRepairSuccess(state, state.tasks[1], { dryRun: false });
    assert.equal(result.propagated, true);
    assert.equal(result.affected_count, 1);
    assert.equal(result.affected[0].action, "unblocked");

    // Check state mutation
    assert.equal(state.goal_queue[0].status, "ready");
    assert.equal(state.goal_queue[0].blocked_reason, null);
  });

  await t.test("diagnoseQueueItems: superseded status shows can_advance=true", () => {
    const state = {
      tasks: [
        {
          id: "task_superseded",
          status: "superseded",
          result: { superseded_by_task_id: "task_successor" },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          status: "blocked",
          depends_on_task_id: "task_superseded",
          blocked_reason: "waiting for task_superseded",
        },
      ],
      goals: [],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.scans.length, 1);
    assert.equal(diag.scans[0].can_advance, true);
    assert.equal(diag.scans[0].is_repair_successor, true);
    assert.equal(diag.scans[0].action, "unblock");
  });
});

// ===========================================================================
// SCENARIO 5: Failed terminal blocks or routes dependent
// ===========================================================================

test("P0-C8 SCENARIO 5: Failed terminal blocks or routes dependent", async (t) => {
  await t.test("isQueueTerminalFailed recognizes failure statuses", () => {
    assert.equal(isQueueTerminalFailed("failed"), true);
    assert.equal(isQueueTerminalFailed("timed_out"), true);
    assert.equal(isQueueTerminalFailed("blocked"), true);
    assert.equal(isQueueTerminalFailed("cancelled"), true);
    assert.equal(isQueueTerminalFailed("completed"), false);
    assert.equal(isQueueTerminalFailed("running"), false);
  });

  await t.test("resolveQueueDependencyState: failed task blocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_failed",
          status: "failed",
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "waiting",
          depends_on_task_id: "task_failed",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_completed, false);
    assert.equal(depState.effective_failed, true);
    assert.match(depState.detail, /terminal failed/);
  });

  await t.test("resolveQueueDependencyState: timed_out task blocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_timedout",
          status: "timed_out",
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "waiting",
          depends_on_task_id: "task_timedout",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_failed, true);
    assert.equal(depState.effective_completed, false);
  });

  await t.test("resolveQueueDependencyState: cancelled task blocks dependent", () => {
    const state = {
      tasks: [
        {
          id: "task_cancelled",
          status: "cancelled",
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "waiting",
          depends_on_task_id: "task_cancelled",
        },
      ],
      goals: [],
    };

    const depState = resolveQueueDependencyState(state, state.goal_queue[0]);
    assert.equal(depState.effective_failed, true);
  });

  await t.test("diagnoseQueueItems: failed terminal shows can_advance=false with block_on_failed", () => {
    const state = {
      tasks: [
        {
          id: "task_failed",
          status: "failed",
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          status: "waiting",
          depends_on_task_id: "task_failed",
        },
      ],
      goals: [],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.scans.length, 1);
    assert.equal(diag.scans[0].can_advance, false);
    assert.equal(diag.scans[0].effective_failed, true);
    // For a "waiting" item with a failed dependency, the action is block_on_dependency
    // since checkDependency returns unsatisfied
    assert.ok(diag.scans[0].action.startsWith("block_"));
  });

  await t.test("detectStaleBlockers: failed dependency is identified but not stale", () => {
    const state = {
      tasks: [
        {
          id: "task_failed",
          status: "failed",
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_failed",
          blocked_reason: "waiting for task_failed",
        },
      ],
      goals: [],
    };

    const stale = detectStaleBlockers(state);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale_type, "dependency_failed_terminal");
    assert.equal(stale[0].recommendation, "keep blocked: upstream failed terminally");
  });

  await t.test("detectStaleBlockers: blocked item with completed dependency IS stale", () => {
    const state = {
      tasks: [
        {
          id: "task_completed",
          status: "completed",
          result: { operation_kind: "readonly_validation" },
        },
      ],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          status: "blocked",
          depends_on_task_id: "task_completed",
          blocked_reason: "waiting for task_completed",
        },
      ],
      goals: [],
    };

    const stale = detectStaleBlockers(state);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale_type, "dependency_resolved");
    assert.equal(stale[0].recommendation, "unblock: set status to ready and re-check");
  });
});

// ===========================================================================
// SCENARIO 6: Dry-run diagnostics
// ===========================================================================

test("P0-C8 SCENARIO 6: Dry-run diagnostics and stale blocker detection", async (t) => {
  await t.test("diagnoseQueueItems returns dry_run=true and has summary", () => {
    const state = {
      tasks: [],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_no_dep",
          position: 1,
          goal_title: "No Dependency",
          status: "waiting",
        },
      ],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.dry_run, true);
    assert.equal(diag.queue_items_count, 1);
    assert.ok(diag.timestamp);
    assert.ok(diag.summary);
    assert.equal(diag.summary.total, 1);
    assert.equal(diag.summary.can_advance, 1); // No dependency → can advance
  });

  await t.test("diagnoseQueueItems reports errors for missing tasks", () => {
    const state = {
      tasks: [],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          status: "blocked",
          depends_on_task_id: "task_nonexistent",
          blocked_reason: "waiting for task_nonexistent",
        },
      ],
    };

    const diag = diagnoseQueueItems(state);
    assert.equal(diag.scans.length, 1);
    // Dependency target not found — effective_completed=false
    assert.equal(diag.scans[0].can_advance, false);
    assert.equal(diag.scans[0].dependency.target_id, "task_nonexistent");
    assert.equal(diag.scans[0].dependency.status, null);
  });

  await t.test("reconcileQueue dry-run returns diagnostics without mutation", async () => {
    const state = {
      tasks: [
        {
          id: "task_readonly",
          status: "completed",
          result: { operation_kind: "readonly_validation" },
        },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          status: "blocked",
          depends_on_task_id: "task_readonly",
          blocked_reason: "waiting for task_readonly",
        },
      ],
    };

    const result = await reconcileQueue(state, {}, { dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.reconciled, false);
    assert.ok(result.scans);
    assert.ok(result.summary);
    assert.ok(result.note);
  });

  await t.test("reconcileQueue applies changes when dryRun=false", async () => {
    const state = {
      tasks: [
        {
          id: "task_readonly",
          status: "completed",
          result: { operation_kind: "readonly_validation" },
        },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_dep",
          position: 1,
          status: "blocked",
          depends_on_task_id: "task_readonly",
          blocked_reason: "waiting for task_readonly",
        },
      ],
    };

    const result = await reconcileQueue(state, {}, { dryRun: false });
    assert.equal(result.dry_run, false);
    assert.equal(result.reconciled, true);
    assert.ok(result.actions);
    assert.ok(result.summary);

    // Check state was mutated
    assert.equal(state.goal_queue[0].status, "ready");
    assert.equal(state.goal_queue[0].blocked_reason, null);
  });

  await t.test("reconcileQueue handles items with no dependency correctly", async () => {
    const state = {
      tasks: [],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1",
          goal_id: "goal_no_dep",
          position: 1,
          status: "waiting",
        },
      ],
    };

    const result = await reconcileQueue(state, {}, { dryRun: true });
    assert.equal(result.summary.can_advance, 1);
  });

  await t.test("stale blocker detection: mix of stale, failed, and in-progress blockers", () => {
    const state = {
      tasks: [
        { id: "t1", status: "completed", result: { operation_kind: "readonly_validation" } },
        { id: "t2", status: "failed" },
        { id: "t3", status: "running" },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1", goal_id: "g1",
          status: "blocked", depends_on_task_id: "t1",
          blocked_reason: "waiting for t1",
        },
        {
          queue_id: "q2", goal_id: "g2",
          status: "blocked", depends_on_task_id: "t2",
          blocked_reason: "waiting for t2",
        },
        {
          queue_id: "q3", goal_id: "g3",
          status: "blocked", depends_on_task_id: "t3",
          blocked_reason: "waiting for t3",
        },
      ],
    };

    const stale = detectStaleBlockers(state);
    assert.equal(stale.length, 3);
    assert.equal(stale.find((s) => s.queue_id === "q1").stale_type, "dependency_resolved");
    assert.equal(stale.find((s) => s.queue_id === "q2").stale_type, "dependency_failed_terminal");
    assert.equal(stale.find((s) => s.queue_id === "q3").stale_type, "dependency_in_progress");
  });
});

// ===========================================================================
// SCENARIO 7: Queue terminal state definitions
// ===========================================================================

test("P0-C8 SCENARIO 7: Queue terminal state definitions", async (t) => {
  await t.test("QUEUE_TERMINAL_COMPLETED includes all expected states", () => {
    const expected = ["completed", "readonly_closed", "integration_not_required",
      "integrated", "superseded", "resolved_by_successor"];
    for (const s of expected) {
      assert.equal(QUEUE_TERMINAL_COMPLETED.has(s), true, `${s} should be in QUEUE_TERMINAL_COMPLETED`);
    }
  });

  await t.test("isQueueTerminalCompleted works correctly", () => {
    assert.equal(isQueueTerminalCompleted("completed"), true);
    assert.equal(isQueueTerminalCompleted("readonly_closed"), true);
    assert.equal(isQueueTerminalCompleted("integration_not_required"), true);
    assert.equal(isQueueTerminalCompleted("integrated"), true);
    assert.equal(isQueueTerminalCompleted("superseded"), true);
    assert.equal(isQueueTerminalCompleted("resolved_by_successor"), true);
    assert.equal(isQueueTerminalCompleted("failed"), false);
    assert.equal(isQueueTerminalCompleted("running"), false);
  });

  await t.test("isQueueTerminal combines completed and failed", () => {
    assert.equal(isQueueTerminal("completed"), true);
    assert.equal(isQueueTerminal("failed"), true);
    assert.equal(isQueueTerminal("readonly_closed"), true);
    assert.equal(isQueueTerminal("running"), false);
    assert.equal(isQueueTerminal("waiting"), false);
  });

  await t.test("explainQueueDecision produces decisions with reasons", () => {
    const state = {
      tasks: [
        { id: "t_failed", status: "failed" },
      ],
      goals: [],
      goal_queue: [
        {
          queue_id: "q1", goal_id: "g1",
          status: "waiting", depends_on_task_id: "t_failed",
        },
      ],
    };

    const decision = explainQueueDecision(state, state.goal_queue[0]);
    assert.equal(decision.decision, "block_on_failed");
    assert.ok(decision.reason);
  });
});

// ===========================================================================
// SCENARIO 8: Integration with goal-queue.mjs exports
// ===========================================================================

test("P0-C8 SCENARIO 8: Integration with goal-queue exports", async (t) => {
  await t.test("reconciler functions are exported from goal-queue", async () => {
    const gq = await import("../src/goal-queue.mjs");
    assert.equal(typeof gq.reconcileQueue, "function");
    assert.equal(typeof gq.diagnoseQueueItems, "function");
    assert.equal(typeof gq.propagateRepairSuccess, "function");
    assert.equal(typeof gq.explainQueueDecision, "function");
    assert.equal(typeof gq.detectStaleBlockers, "function");
  });
});
