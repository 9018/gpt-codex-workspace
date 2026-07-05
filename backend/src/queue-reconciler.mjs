/**
 * queue-reconciler.mjs — Queue Auto-Advance Reconciler (P0-C8)
 *
 * Scans queue items systematically and computes deterministic advancement
 * decisions based on terminal states of dependency targets.
 *
 * ## Terminal State Definitions
 *
 * Queue-dependent items can advance ONLY when their upstream dependency
 * has reached a terminal *completed* state.  Terminal completion includes:
 *
 *   - completed               — Standard task completion
 *   - readonly_closed         — Readonly operation (validation/diagnostic) completed cleanly
 *   - integration_not_required— Upstream is done and does not need merging
 *   - integrated              — Commit has been merged or integrated
 *   - superseded              — Task was superseded by a successor
 *   - resolved_by_successor   — Task was resolved by a repair successor
 *
 * Terminal *failed* states (failed, timed_out, blocked, cancelled) do NOT
 * unblock dependents — they block or route according to explicit policy.
 *
 * ## Critical Rule
 *
 * A mutating task whose status is "completed" but whose integration
 * requirement is NOT satisfied MUST NOT unblock dependents.  This prevents
 * the queue from advancing past an accepted-but-unintegrated change.
 */

import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isCompletedStatus,
  isFailedTerminalStatus,
} from "./task-status-taxonomy.mjs";

import {
  TERMINAL_COMPLETED_STATUSES,
  NON_COMPLETION_TERMINAL_STATUSES,
  isTerminalCompleted,
  isNonCompletionTerminal,
  resolveDependencyTarget,
  checkDependency,
  checkAcceptanceGate,
} from "./queue-policy.mjs";

import { normalizeRepoId, repoIdsEqual } from "./repo-identity.mjs";

// ---------------------------------------------------------------------------
// Queue-specific terminal completion states
// ---------------------------------------------------------------------------

/**
 * Extended set of statuses that count as "terminal completed" for queue
 * auto-advance decisions.  This includes the base completed status plus
 * readonly, integration-not-required, integrated, and superseded states.
 */
export const QUEUE_TERMINAL_COMPLETED = Object.freeze(
  new Set([
    TASK_STATUSES.COMPLETED,
    "readonly_closed",
    "integration_not_required",
    "integrated",
    "superseded",
    "resolved_by_successor",
  ])
);

/**
 * Check if a status string represents a terminal-completed state
 * for queue auto-advance purposes.
 */
export function isQueueTerminalCompleted(status) {
  return QUEUE_TERMINAL_COMPLETED.has(status) || TERMINAL_COMPLETED_STATUSES.has(status);
}

/**
 * Check if a status string represents a terminal-failed state
 * for queue auto-advance purposes (these block dependents).
 */
export function isQueueTerminalFailed(status) {
  return isFailedTerminalStatus(status) || NON_COMPLETION_TERMINAL_STATUSES.has(status);
}

/**
 * Check if a status string is any queue-terminal state (completed or failed).
 */
export function isQueueTerminal(status) {
  return isQueueTerminalCompleted(status) || isQueueTerminalFailed(status);
}

// ---------------------------------------------------------------------------
// Dependency state resolution for queue advancement
// ---------------------------------------------------------------------------

/**
 * Resolve the full dependency state for a queue item, including
 * integration status, readonly detection, and repair-chain awareness.
 *
 * @param {object} state — Full state object (goals[], tasks[], goal_queue[])
 * @param {object} item  — Queue item with depends_on_goal_id / depends_on_task_id
 * @returns {object} Dependency state descriptor with:
 *   - status {string|null}  — Effective terminal status of the dependency
 *   - kind {"goal"|"task"|"successor"|"none"}
 *   - target_id {string|null}
 *   - effective_completed {boolean}
 *   - effective_failed {boolean}
 *   - integration_required_and_missing {boolean}
 *   - readonly_operation {boolean}
 *   - is_repair_successor {boolean}
 *   - detail {string}
 */
export function resolveQueueDependencyState(state, item) {
  const base = resolveDependencyTarget(state, item);
  const { status, kind, target_id } = base;

  // No dependency — trivially satisfied
  if (kind === "none") {
    return {
      status: null,
      kind: "none",
      target_id: null,
      effective_completed: true,
      effective_failed: false,
      integration_required_and_missing: false,
      readonly_operation: false,
      is_repair_successor: false,
      detail: "no dependency",
    };
  }

  // Target not found
  if (status === null) {
    return {
      status: null,
      kind,
      target_id,
      effective_completed: false,
      effective_failed: false,
      integration_required_and_missing: false,
      readonly_operation: false,
      is_repair_successor: false,
      detail: `dependency target ${target_id} not found`,
    };
  }

  // ---- Detect the prerequisite task backing this dependency. Goal-level
  // dependencies use their latest completed task so integration evidence is
  // not lost after the goal itself is marked completed.
  const task = kind === "task" && target_id
    ? (Array.isArray(state.tasks) ? state.tasks.find((t) => t.id === target_id) : null)
    : (kind === "goal" && target_id && Array.isArray(state.tasks)
      ? [...state.tasks].reverse().find((t) => t.goal_id === target_id && isCompletedStatus(t.status))
      : null);

  // Check if the task's result indicates a readonly/non-mutating operation
  const isReadonly =
    task?.result?.operation_kind === "readonly_validation" ||
    task?.result?.operation_kind === "diagnostic" ||
    task?.result?.operation_kind === "already_integrated" ||
    task?.result?.kind === "noop" ||
    status === "readonly_closed";

  // Check if the task's result indicates integration was not required or already satisfied
  const integrationNotRequired =
    task?.result?.integration?.status === "skipped" ||
    task?.result?.integration?.status === "not_required" ||
    task?.result?.needs_integration === false ||
    status === "integration_not_required";

  // Check if the task is already integrated
  const isIntegrated =
    task?.result?.integration?.merged === true ||
    task?.result?.integration?.status === "merged" ||
    task?.result?.auto_integration_completion?.completed === true ||
    status === "integrated";

  // Check if the task is a repair successor (resolved_by_task_id / superseded_by_task_id)
  const isRepairSuccessor =
    Boolean(task?.result?.repair_outcome === "repaired" || task?.result?.repaired_by_task_id) ||
    task?.result?.kind === "repair_successor" ||
    status === "resolved_by_successor" ||
    status === "superseded";

  // ---- Determine effective completion ----
  const isTerminalCompletedStatus = isQueueTerminalCompleted(status);

  // A status of "completed" is only truly terminal-completed for queue purposes
  // if the integration requirement is satisfied (or not needed).
  // This implements: "Do not unblock dependents when upstream is only accepted
  // but integration is still required and not terminal."
  let integrationRequiredAndMissing = false;
  if (status === TASK_STATUSES.COMPLETED && !isReadonly && !integrationNotRequired && !isIntegrated) {
    // Check if the task's result indicates it needs integration
    const needsIntegration =
      task?.result?.needs_integration === true ||
      task?.result?.integration?.required === true;
    if (needsIntegration || task?.result?.commit) {
      integrationRequiredAndMissing = true;
    }
  }

  const effectiveCompleted = isTerminalCompletedStatus &&
    (status !== TASK_STATUSES.COMPLETED || integrationNotRequired || isIntegrated || isReadonly || isRepairSuccessor);

  const effectiveFailed = isQueueTerminalFailed(status);

  const detail = buildDetailString({
    status,
    kind,
    target_id,
    effectiveCompleted,
    effectiveFailed,
    integrationRequiredAndMissing,
    isReadonly,
    isRepairSuccessor,
    integrationNotRequired,
    isIntegrated,
  });

  return {
    status,
    kind,
    target_id,
    effective_completed: effectiveCompleted,
    effective_failed: effectiveFailed,
    integration_required_and_missing: integrationRequiredAndMissing,
    readonly_operation: isReadonly,
    is_repair_successor: isRepairSuccessor,
    detail,
  };
}

function buildDetailString({
  status,
  kind,
  target_id,
  effectiveCompleted,
  effectiveFailed,
  integrationRequiredAndMissing,
  isReadonly,
  isRepairSuccessor,
  integrationNotRequired,
  isIntegrated,
}) {
  if (integrationRequiredAndMissing) {
    return `depends_on_${kind} ${target_id} status=${status} — completed but integration still required and not yet satisfied; dependent blocked until integrated`;
  }
  if (effectiveCompleted) {
    const extra = isReadonly ? " (readonly)" : isRepairSuccessor ? " (repair successor)" : integrationNotRequired ? " (integration not required)" : isIntegrated ? " (integrated)" : "";
    return `depends_on_${kind} ${target_id} status=${status}${extra} — terminal completed, can advance`;
  }
  if (effectiveFailed) {
    return `depends_on_${kind} ${target_id} status=${status} — terminal failed, dependent blocked`;
  }
  if (isQueueTerminalCompleted(status)) {
    return `depends_on_${kind} ${target_id} status=${status} — terminal completed but integration required and not yet satisfied`;
  }
  return `depends_on_${kind} ${target_id} status=${status} — not terminal, waiting`;
}

// ---------------------------------------------------------------------------
// Stale blocker detection
// ---------------------------------------------------------------------------

/**
 * Detect stale blockers in the queue.
 *
 * A stale blocker is a queue item in "blocked" status whose dependency
 * has reached a terminal state (either completed or failed), yet the
 * item has NOT been updated to reflect this.
 *
 * @param {object} state — Full state object
 * @returns {Array<object>} Stale blocker diagnostics
 */
export function detectStaleBlockers(state) {
  const items = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const stale = [];

  for (const item of items) {
    if (item.status !== "blocked") continue;
    if (!item.depends_on_goal_id && !item.depends_on_task_id) continue;

    const depState = resolveQueueDependencyState(state, item);
    const now = new Date().toISOString();

    if (depState.effective_completed) {
      // Dependency is terminal-completed but item is still blocked — stale blocker
      stale.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        current_status: item.status,
        blocked_reason: item.blocked_reason || "(no reason recorded)",
        dependency: {
          kind: depState.kind,
          target_id: depState.target_id,
          status: depState.status,
        },
        stale_type: "dependency_resolved",
        recommendation: "unblock: set status to ready and re-check",
        detected_at: now,
        detail: depState.detail,
      });
    } else if (depState.effective_failed) {
      // Dependency is terminal-failed — still blocked, but not stale
      stale.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        current_status: item.status,
        blocked_reason: item.blocked_reason || "(no reason recorded)",
        dependency: {
          kind: depState.kind,
          target_id: depState.target_id,
          status: depState.status,
        },
        stale_type: "dependency_failed_terminal",
        recommendation: "keep blocked: upstream failed terminally",
        detected_at: now,
        detail: depState.detail,
      });
    } else {
      // Not stale — dependency is still in progress
      stale.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        current_status: item.status,
        blocked_reason: item.blocked_reason || "(no reason recorded)",
        dependency: {
          kind: depState.kind,
          target_id: depState.target_id,
          status: depState.status,
        },
        stale_type: "dependency_in_progress",
        recommendation: "keep blocked: upstream still in progress",
        detected_at: now,
        detail: depState.detail,
      });
    }
  }

  return stale;
}

// ---------------------------------------------------------------------------
// Dry-run diagnostic report
// ---------------------------------------------------------------------------

/**
 * Build a dry-run diagnostic report for all queue items.
 *
 * @param {object} state — Full state object
 * @param {object} [config] — Optional config
 * @returns {object} Diagnostic report
 */
export function diagnoseQueueItems(state, config = {}) {
  const items = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const scans = [];
  const errors = [];

  for (const item of items) {
    try {
      const depState = resolveQueueDependencyState(state, item);
      const staleCheck = detectStaleBlockers(state).find(
        (s) => s.queue_id === item.queue_id
      );

      let canAdvance = false;
      let action = "no_action";
      let whyNot = null;

      // Items eligible for advancement: "waiting", "ready", or "blocked" with resolved dependency
      if (item.status === "waiting" || item.status === "ready") {
        // Use the reconciler's richer dependency state that includes
        // integration awareness, readonly detection, and repair-chain
        if (depState.effective_completed) {
          // Check acceptance gate
          const acceptResult = checkAcceptanceGate(state, item);
          if (acceptResult.passed) {
            canAdvance = true;
            action = "advance";
          } else {
            whyNot = acceptResult.reason;
            action = "block_on_acceptance";
          }
        } else if (depState.integration_required_and_missing) {
          whyNot = depState.detail;
          action = "block_on_integration";
        } else if (depState.effective_failed) {
          whyNot = depState.detail;
          action = "block_on_failed_dependency";
        } else {
          whyNot = depState.detail;
          action = "block_on_dependency";
        }
      } else if (item.status === "blocked") {
        // Re-evaluate blocked items
        if (depState.effective_completed) {
          canAdvance = true;
          action = "unblock";
        } else if (depState.effective_failed) {
          action = "block_on_failed_dependency";
          whyNot = depState.detail;
        } else {
          action = "block_on_incomplete_dependency";
          whyNot = depState.detail;
        }
      }

      const entry = {
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        goal_title: item.goal_title || null,
        position: item.position,
        item_status: item.status,
        blocked_reason: item.blocked_reason || null,
        dependency: {
          kind: depState.kind,
          target_id: depState.target_id,
          status: depState.status,
        },
        can_advance: canAdvance,
        action: action,
        why_not: whyNot,
        effective_completed: depState.effective_completed,
        effective_failed: depState.effective_failed,
        integration_required_and_missing: depState.integration_required_and_missing,
        readonly_operation: depState.readonly_operation,
        is_repair_successor: depState.is_repair_successor,
        stale_blocker: staleCheck?.stale_type === "dependency_resolved" || false,
        stale_type: staleCheck?.stale_type || null,
        detail: depState.detail,
      };

      scans.push(entry);
    } catch (err) {
      errors.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        error: err.message || String(err),
      });
    }
  }

  // Summary statistics
  const total = items.length;
  const canAdvanceCount = scans.filter((s) => s.can_advance).length;
  const blockedCount = scans.filter((s) => s.action.startsWith("block_")).length;
  const staleCount = scans.filter((s) => s.stale_blocker).length;
  const noActionCount = scans.filter((s) => s.action === "no_action").length;
  const integrationMissingCount = scans.filter((s) => s.integration_required_and_missing).length;

  return {
    dry_run: true,
    timestamp: new Date().toISOString(),
    queue_items_count: total,
    scans,
    errors,
    summary: {
      total,
      can_advance: canAdvanceCount,
      blocked: blockedCount,
      stale_blockers: staleCount,
      no_action: noActionCount,
      integration_required_and_missing: integrationMissingCount,
    },
    warnings: errors.length > 0
      ? [`${errors.length} item(s) produced errors during diagnosis`]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Reconciler: apply resolved decisions to queue state
// ---------------------------------------------------------------------------

/**
 * Run the full queue reconciler.
 *
 * Scans all queue items, computes deterministic advancement decisions,
 * and (unless dryRun is true) mutates the queue state accordingly.
 *
 * @param {object} state — Full mutable state object (goals[], tasks[], goal_queue[])
 * @param {object} config — Config object
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] — When true, only produce diagnostics, no mutation
 * @param {boolean} [options.fixStaleBlockers=false] — When true, auto-fix stale blockers by unblocking items whose dependency has resolved
 * @returns {Promise<object>} Reconciler report
 */
export async function reconcileQueue(state, config = {}, options = {}) {
  const dryRun = options.dryRun !== false;
  const fixStaleBlockers = options.fixStaleBlockers === true;

  // Run diagnostics first
  const diagnostics = diagnoseQueueItems(state, config);

  // If dry run, return diagnostics without mutation
  if (dryRun) {
    return {
      reconciled: false,
      dry_run: true,
      ...diagnostics,
      summary: {
        ...diagnostics.summary,
        fix_stale_blockers: fixStaleBlockers,
      },
      note: "Dry run — no queue state was mutated. Re-run with { dryRun: false } to apply changes.",
    };
  }

  // Apply changes
  const actions = [];
  const errors = [];
  const now = new Date().toISOString();
  let itemsAdvanced = 0;
  let itemsBlocked = 0;
  let itemsUnblocked = 0;
  let staleFixed = 0;

  for (const scan of diagnostics.scans) {
    try {
      const item = Array.isArray(state.goal_queue)
        ? state.goal_queue.find((qi) => qi.queue_id === scan.queue_id)
        : null;
      if (!item) {
        errors.push({ queue_id: scan.queue_id, error: "queue item not found in state" });
        continue;
      }

      if (scan.can_advance && (scan.action === "advance" || scan.action === "unblock")) {
        // Advance the item
        const previousStatus = item.status;
        item.status = scan.item_status === "blocked" ? "ready" : "waiting";
        item.blocked_reason = null;
        item.updated_at = now;

        if (previousStatus === "blocked") {
          itemsUnblocked++;
          actions.push({
            queue_id: scan.queue_id,
            goal_id: scan.goal_id,
            action: "unblocked",
            from_status: previousStatus,
            to_status: item.status,
            reason: scan.detail,
          });
        } else {
          itemsAdvanced++;
          actions.push({
            queue_id: scan.queue_id,
            goal_id: scan.goal_id,
            action: "advanced",
            from_status: previousStatus,
            to_status: item.status,
            reason: scan.detail,
          });
        }

        if (scan.stale_blocker && fixStaleBlockers) {
          staleFixed++;
        }
      } else if (
        scan.action === "block_on_failed_dependency" &&
        fixStaleBlockers &&
        scan.stale_blocker
      ) {
        // The dependency failed — record the blocking decision explicitly
        item.blocked_reason = item.blocked_reason || scan.detail;
        item.updated_at = now;
        staleFixed++;
        actions.push({
          queue_id: scan.queue_id,
          goal_id: scan.goal_id,
          action: "confirmed_blocked_on_failed_dependency",
          detail: scan.detail,
        });
      }
    } catch (err) {
      errors.push({
        queue_id: scan.queue_id,
        error: err.message || String(err),
      });
    }
  }

  return {
    reconciled: true,
    dry_run: false,
    timestamp: now,
    queue_items_count: diagnostics.queue_items_count,
    actions,
    errors,
    summary: {
      total: diagnostics.queue_items_count,
      unblocked: itemsUnblocked,
      advanced: itemsAdvanced,
      already_blocked: diagnostics.summary.blocked,
      stale_fixed: staleFixed,
      errors: errors.length,
      actions_count: actions.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Repair success propagation
// ---------------------------------------------------------------------------

/**
 * After a repair task succeeds, re-evaluate queue items that depend on the
 * root task or its goal and unblock them if the dependency is now satisfied.
 *
 * @param {object} state — Full mutable state object
 * @param {object} completedTask — The repair task that just completed
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] — When true, only report what would change
 * @returns {Promise<object>} Propagation report
 */
export async function propagateRepairSuccess(state, completedTask, options = {}) {
  const dryRun = options.dryRun !== false;
  const now = new Date().toISOString();
  const rootTaskId = completedTask.root_task_id || completedTask.parent_task_id || completedTask.repair_of_task_id || completedTask.id;
  const goalId = completedTask.goal_id || completedTask.repair_of_goal_id || null;
  const affected = [];

  if (!rootTaskId && !goalId) {
    return {
      propagated: false,
      reason: "no root task or goal on completed task",
      affected: [],
    };
  }

  // Find queue items that depend on the root task or its goal
  const queueItems = Array.isArray(state.goal_queue) ? state.goal_queue : [];

  for (const item of queueItems) {
    const dependsOn =
      item.depends_on_task_id || item.depends_on_goal_id;

    if (!dependsOn) continue;
    if (dependsOn !== rootTaskId && dependsOn !== goalId) continue;

    const depState = resolveQueueDependencyState(state, item);
    const isBlocked = item.status === "blocked";
    const isWaiting = item.status === "waiting" || item.status === "ready";

    if (!isBlocked && !isWaiting) continue;

    if (depState.effective_completed) {
      if (!dryRun) {
        item.status = "ready";
        item.blocked_reason = null;
        item.updated_at = now;
      }
      affected.push({
        queue_id: item.queue_id,
        goal_id: item.goal_id,
        action: dryRun ? "would_unblock" : "unblocked",
        depends_on: dependsOn,
        detail: depState.detail,
      });
    } else if (depState.effective_failed) {
      if (isBlocked && item.blocked_reason) {
        // Already properly blocked — note but don't change
        affected.push({
          queue_id: item.queue_id,
          goal_id: item.goal_id,
          action: "stays_blocked",
          depends_on: dependsOn,
          detail: depState.detail,
        });
      } else if (!dryRun) {
        item.status = "blocked";
        item.blocked_reason = depState.detail;
        item.updated_at = now;
      }
    }
  }

  return {
    propagated: affected.length > 0,
    dry_run: dryRun,
    root_task_id: rootTaskId,
    goal_id: goalId,
    affected,
    affected_count: affected.length,
    unblocked_count: affected.filter((a) => a.action === "unblocked" || a.action === "would_unblock").length,
  };
}

// ---------------------------------------------------------------------------
// Convenience: Explainable decision report for a single queue item
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable explainable decision for a queue item.
 *
 * @param {object} state — Full state object
 * @param {object} item — Queue item
 * @returns {object} Explainable decision
 */
export function explainQueueDecision(state, item) {
  const depState = resolveQueueDependencyState(state, item);

  return {
    queue_id: item.queue_id,
    goal_id: item.goal_id,
    current_status: item.status,
    dependency: {
      kind: depState.kind,
      target_id: depState.target_id,
      status: depState.status,
    },
    decision: depState.effective_completed
      ? "advance"
      : depState.effective_failed
        ? "block_on_failed"
        : depState.integration_required_and_missing
          ? "block_on_integration_required"
          : "block_on_incomplete_dependency",
    reason: depState.detail,
    integration_required_and_missing: depState.integration_required_and_missing,
    readonly_operation: depState.readonly_operation,
    is_repair_successor: depState.is_repair_successor,
  };
}
