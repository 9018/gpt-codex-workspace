/**
 * stale-state-sweeper.mjs — Auto-sweep mechanism for stale task states.
 *
 * P0: Automatically resolves tasks stuck in non-terminal states when the
 * conditions for advancement are already met.
 *
 * Swept states:
 *   waiting_for_review     → completed (if acceptance + verification passed)
 *   waiting_for_repair     → completed (if parent already accepted)
 *   waiting_for_integration → completed (if local/remote aligned)
 *   retry_wait             → assigned (if retry due + attempts remain)
 *   quota_wait             → assigned (if quota due)
 *   retry_wait/quota exhausted → blocked/failed
 *
 * The sweeper is a pure function that returns recommended actions. The
 * caller (e.g., worker loop or reconciliation service) applies them.
 */

import { isCommitAncestorOfHead } from './current-blocker-policy.mjs';
import { classifyFailureStructured } from "./failure-classifier.mjs";
import { isRetryBudgetExhausted, getRetryExhaustedStatus } from "./task-retry.mjs";
import {
  TASK_STATUSES,
  isCompletedStatus,
  isHumanReviewStatus,
  isRepairStatus,
} from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Sweep result schema
// ---------------------------------------------------------------------------
// Each sweep produces a list of actions:
// {
//   taskId: string,
//   currentStatus: string,
//   recommendedStatus: string,
//   reason: string,
//   actions: Array<{ type: string, payload: object }>,
// }

// ---------------------------------------------------------------------------
// Main sweep function
// ---------------------------------------------------------------------------

/**
 * Sweep stale task states and return recommended actions.
 *
 * @param {object} options
 * @param {Array<object>} options.tasks - All tasks to scan
 * @param {object} [options.repoState] - Repository state { localHead, remoteHead, ahead, behind }
 * @param {number} [options.now] - Current timestamp (ms)
 * @param {number} [options.staleThresholdMs=300_000] - How long a task can be stale before sweep
 * @returns {Array<object>} Sweep actions
 */
export function sweepStaleTaskStates({ tasks = [], repoState = {}, now, staleThresholdMs = 300_000 } = {}) {
  const actions = [];
  const currentTime = now || Date.now();

  for (const task of tasks) {
    if (!task || !task.status) continue;

    const updatedAt = task.updated_at ? new Date(task.updated_at).getTime() : 0;
    const staleFor = currentTime - updatedAt;

    if (isHumanReviewStatus(task.status)) {
      actions.push(...sweepWaitingForReview(task, currentTime, staleFor, staleThresholdMs));
      continue;
    }

    if (isRepairStatus(task.status)) {
      actions.push(...sweepWaitingForRepair(task, tasks, currentTime, staleFor, staleThresholdMs));
      continue;
    }

    switch (task.status) {
      case TASK_STATUSES.WAITING_FOR_INTEGRATION:
        actions.push(...sweepWaitingForIntegration(task, repoState, currentTime, staleFor, staleThresholdMs));
        break;

      case "retry_wait":
        actions.push(...sweepRetryWait(task, currentTime, staleFor));
        break;

      case "quota_wait":
        actions.push(...sweepQuotaWait(task, currentTime, staleFor));
        break;
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// State-specific sweepers
// ---------------------------------------------------------------------------

/**
 * Sweep waiting_for_review tasks.
 *
 * Rules:
 * 1. If acceptance passed + verification passed + no blockers → completed
 * 2. If profile is sync_only/verification_only and non-blocker findings only → completed
 * 3. If tests_missing and profile allows → completed
 * 4. Otherwise → keep as-is (needs human or will be handled by convergence)
 */
function sweepWaitingForReview(task, currentTime, staleFor, staleThresholdMs) {
  const actions = [];
  const result = task.result || {};

  // Check if task has acceptance evidence
  const acceptanceFindings = result.acceptance_findings || result.verification?.findings || [];
  const verificationPassed = result.verification?.passed === true;
  const blockerFindings = acceptanceFindings.filter(f => f.severity === "blocker" || f.severity === "major");
  const profile = result.acceptance_profile || detectProfileFromTask(task, result);

  // Rule 1: accepted + verified + no blockers
  if (verificationPassed && blockerFindings.length === 0) {
    actions.push({
      taskId: task.id,
      currentStatus: TASK_STATUSES.WAITING_FOR_REVIEW,
      recommendedStatus: TASK_STATUSES.COMPLETED,
      reason: `Auto-sweep: acceptance passed + verification passed + no blockers for profile=${profile}`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.COMPLETED } }],
    });
    return actions;
  }

  // Rule 2-3: Non-blocker findings only and profile allows
  if (blockerFindings.length > 0) {
    const allAllowedForProfile = blockerFindings.every(f =>
      isNonBlockerForProfile(f.code, profile)
    );
    if (allAllowedForProfile) {
      actions.push({
        taskId: task.id,
        currentStatus: TASK_STATUSES.WAITING_FOR_REVIEW,
        recommendedStatus: TASK_STATUSES.COMPLETED,
        reason: `Auto-sweep: profile=${profile} allows non-blocker findings: ${blockerFindings.map(f => f.code).join(", ")}`,
        actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.COMPLETED } }],
      });
      return actions;
    }
  }

  // Rule 4: Stale with no progress → escalate
  if (staleFor > staleThresholdMs * 3 && blockerFindings.length === 0) {
    actions.push({
      taskId: task.id,
      currentStatus: TASK_STATUSES.WAITING_FOR_REVIEW,
      recommendedStatus: TASK_STATUSES.COMPLETED,
      reason: `Auto-sweep: stale waiting_for_review (${Math.round(staleFor / 1000)}s) with no blockers — force completing.`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.COMPLETED } }],
    });
  }

  return actions;
}

/**
 * Sweep waiting_for_repair tasks.
 *
 * Rules:
 * 1. If parent task is already completed → complete this task
 * 2. If parent is waiting_for_repair → check if repair creation succeeded
 * 3. If max repair attempts exceeded → failed
 * P0-MA11-R1: Also check for already-integrated commit with passing verification
 */
function sweepWaitingForRepair(task, tasks, currentTime, staleFor, staleThresholdMs) {
  const actions = [];
  // P0-MA11-R2: already-integrated commit with passing verification
  // Check via delivery_recovery, integration status, or repo HEAD reachability
  if (task.result) {
    const result = task.result;
    const deliveryRecovery = result.delivery_result_recovery || result.delivery_recovery || null;
    const commit = result.commit || (deliveryRecovery && deliveryRecovery.commit) || null;
    const verificationPassed = result.verification?.passed === true || Boolean(result.tests);
    const isAlreadyIntegrated = (deliveryRecovery && deliveryRecovery.reason === 'already_integrated' && deliveryRecovery.recovered === true)
      || (result.integration && (result.integration.merged === true || ['merged', 'ff_only_merged', 'already_integrated', 'skipped', 'not_required'].includes(String(result.integration.status))));

    if (commit && verificationPassed && isAlreadyIntegrated) {
      actions.push({
        taskId: task.id,
        currentStatus: TASK_STATUSES.WAITING_FOR_REPAIR,
        recommendedStatus: TASK_STATUSES.COMPLETED,
        reason: 'Auto-sweep: task commit ' + commit.slice(0, 7) + ' already integrated, verification passed',
        actions: [{ type: 'update_task_status', payload: { status: TASK_STATUSES.COMPLETED } }],
      });
      return actions;
    }
  }

  // P0-MA11-R2: Also check repo HEAD reachability for legacy commits
  if (task.result && task.result.commit && (task.result.verification?.passed === true || Boolean(task.result.tests))) {
    const commitReachable = isCommitAncestorOfHead(task.result.commit, task.result.execution_cwd || process.cwd());
    if (commitReachable) {
      actions.push({
        taskId: task.id,
        currentStatus: TASK_STATUSES.WAITING_FOR_REPAIR,
        recommendedStatus: TASK_STATUSES.COMPLETED,
        reason: 'Auto-sweep: task commit ' + task.result.commit.slice(0, 7) + ' reachable from repo HEAD, verification passed',
        actions: [{ type: 'update_task_status', payload: { status: TASK_STATUSES.COMPLETED } }],
      });
      return actions;
    }
  }

  const parentTaskId = task.parent_task_id || task.repair_of_task_id;

  if (parentTaskId) {
    const parentTask = tasks.find(t => t.id === parentTaskId);

    // Rule 1: parent already completed
    if (parentTask && isCompletedStatus(parentTask.status)) {
      actions.push({
        taskId: task.id,
        currentStatus: TASK_STATUSES.WAITING_FOR_REPAIR,
        recommendedStatus: TASK_STATUSES.COMPLETED,
        reason: `Auto-sweep: parent task ${parentTaskId} already completed`,
        actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.COMPLETED } }],
      });
      return actions;
    }

    // Rule 3: repair attempt exceeded
    if (staleFor > staleThresholdMs * 2) {
      const maxAttempts = task.max_attempts || task.maxAttempts || 2;
      const currentAttempt = task.repair_attempt || 0;
      if (currentAttempt >= maxAttempts) {
        actions.push({
          taskId: task.id,
          currentStatus: TASK_STATUSES.WAITING_FOR_REPAIR,
          recommendedStatus: TASK_STATUSES.FAILED,
          reason: `Auto-sweep: repair attempt ${currentAttempt} exceeded max ${maxAttempts}`,
          actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.FAILED } }],
        });
        return actions;
      }
    }
  }

  // Stale repair with no parent → just mark as failed
  if (staleFor > staleThresholdMs * 3) {
    actions.push({
      taskId: task.id,
      currentStatus: TASK_STATUSES.WAITING_FOR_REPAIR,
      recommendedStatus: TASK_STATUSES.FAILED,
      reason: `Auto-sweep: stale waiting_for_repair (${Math.round(staleFor / 1000)}s) with no parent resolution`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.FAILED } }],
    });
  }

  return actions;
}

/**
 * Sweep waiting_for_integration tasks.
 *
 * Rules:
 * 1. If local head matches remote head → completed
 * 2. If stale with no progress → retry integration
 */
function sweepWaitingForIntegration(task, repoState, currentTime, staleFor, staleThresholdMs) {
  const actions = [];
  const result = task.result || {};

  // Rule 1: local/remote aligned
  const remoteHead = repoState.remoteHead || result.remote_head || "";
  const localHead = repoState.localHead || result.commit || "";
  if (remoteHead && localHead && remoteHead === localHead) {
    actions.push({
      taskId: task.id,
      currentStatus: TASK_STATUSES.WAITING_FOR_INTEGRATION,
      recommendedStatus: TASK_STATUSES.COMPLETED,
      reason: "Auto-sweep: local/remote heads aligned",
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.COMPLETED } }],
    });
    return actions;
  }

  // Rule 2: Stale → retry integration
  if (staleFor > staleThresholdMs * 2) {
    actions.push({
      taskId: task.id,
      currentStatus: TASK_STATUSES.WAITING_FOR_INTEGRATION,
      recommendedStatus: TASK_STATUSES.QUEUED,
      reason: `Auto-sweep: stale waiting_for_integration (${Math.round(staleFor / 1000)}s) — re-queuing for integration`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.QUEUED } }, { type: "schedule_integration", payload: { taskId: task.id } }],
    });
  }

  return actions;
}

/**
 * Sweep retry_wait tasks.
 *
 * Rules:
 * 1. If retry due (backoff elapsed) + attempts remain → assign
 * 2. If attempts exhausted → blocked/failed
 */
function sweepRetryWait(task, currentTime, staleFor) {
  const actions = [];
  const result = task.result || {};
  const failureClass = result.failure_class || "unknown";
  const attempt = task.retry_attempt || task.healing_retry_count || 0;

  const budget = isRetryBudgetExhausted({ attempt, failureClass });

  if (budget.exhausted) {
    const fallbackStatus = getRetryExhaustedStatus(failureClass);
    actions.push({
      taskId: task.id,
      currentStatus: "retry_wait",
      recommendedStatus: fallbackStatus,
      reason: `Auto-sweep: retry budget exhausted: ${budget.reason}`,
      actions: [{ type: "update_task_status", payload: { status: fallbackStatus } }],
    });
    return actions;
  }

  // Retry is due — check if enough time has passed
  // Use backoff: if staleFor > baseDelay, re-assign
  if (staleFor > computeMinBackoffMs(failureClass, attempt)) {
    actions.push({
      taskId: task.id,
      currentStatus: "retry_wait",
      recommendedStatus: TASK_STATUSES.QUEUED,
      reason: `Auto-sweep: retry due after backoff (attempt ${attempt + 1})`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.QUEUED, retry_attempt: attempt + 1 } }],
    });
  }

  return actions;
}

/**
 * Sweep quota_wait tasks.
 *
 * Rules:
 * 1. If enough time passed (backoff) → assign
 * 2. If attempts exhausted → blocked
 */
function sweepQuotaWait(task, currentTime, staleFor) {
  const actions = [];
  const result = task.result || {};
  const failureClass = result.failure_class || "rate_limited";
  const attempt = task.retry_attempt || task.healing_retry_count || 0;

  const budget = isRetryBudgetExhausted({ attempt, failureClass });

  if (budget.exhausted) {
    actions.push({
      taskId: task.id,
      currentStatus: "quota_wait",
      recommendedStatus: TASK_STATUSES.BLOCKED,
      reason: `Auto-sweep: quota retry budget exhausted: ${budget.reason}`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.BLOCKED } }],
    });
    return actions;
  }

  // Quota wait is due
  if (staleFor > computeMinBackoffMs(failureClass, attempt)) {
    actions.push({
      taskId: task.id,
      currentStatus: "quota_wait",
      recommendedStatus: TASK_STATUSES.QUEUED,
      reason: `Auto-sweep: quota wait elapsed (attempt ${attempt + 1})`,
      actions: [{ type: "update_task_status", payload: { status: TASK_STATUSES.QUEUED, retry_attempt: attempt + 1 } }],
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonBlockerForProfile(code, profile) {
  if (code === "tests_missing") {
    return ["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop", "network_retry"].includes(profile);
  }
  if (code === "changed_files_mismatch") {
    return ["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop"].includes(profile);
  }
  return false;
}

function detectProfileFromTask(task, result) {
  if (task.mode === "sync" || task.mode === "github_sync") return task.mode === "github_sync" ? "github_sync_only" : "sync_only";
  if (looksLikeSyncOnlyTask(task, result)) return "sync_only";
  if (task.mode === "verification") return "verification_only";
  if (result.noop || task.mode === "noop") return "noop";
  if (task.parent_task_id || task.repair_of_task_id) return "repair_noop";
  return "code_change";
}

function looksLikeSyncOnlyTask(task = {}, result = {}) {
  const files = result.changed_files || task.changed_files || [];
  if (Array.isArray(files) && files.length > 0) return false;
  const text = String([task.title, task.description, result.summary, result.kind].filter(Boolean).join(" ")).toLowerCase();
  const hasSyncIntent = /\b(sync|synchroni[sz]e|remote|origin\/main|ahead\/behind|local_head|remote_head)\b/.test(text) ||
    text.includes("同步") || text.includes("远端");
  if (!hasSyncIntent) return false;
  return result.verification?.passed === true || Boolean(result.remote_head) || Boolean(result.commit) ||
    text.includes("ahead") || text.includes("behind") || text.includes("local=remote");
}

function computeMinBackoffMs(failureClass, attempt) {
  const delays = {
    rate_limited: 30_000,
    quota_exceeded: 60_000,
    gateway_error: 10_000,
    service_unavailable: 10_000,
    transient_network_error: 5_000,
    provider_interruption: 15_000,
    execution_timeout: 30_000,
    startup_timeout: 10_000,
    result_missing: 5_000,
  };
  const base = delays[failureClass] || 10_000;
  return Math.min(base * Math.pow(2, attempt), 300_000);
}

// ---------------------------------------------------------------------------
// Integrated convergence: sweep stale states + complete queued agent_runs
// ---------------------------------------------------------------------------

function hasResultEvidence(task = {}) {
  const result = task.result || {};
  if (!result || Object.keys(result).length === 0) return false;
  if (result.commit) return true;
  if (Array.isArray(result.changed_files) && result.changed_files.length > 0) return true;
  if (result.verification?.passed === true) return true;
  if (result.reviewer_decision?.passed === true) return true;
  if (result.integration?.merged === true) return true;
  if (typeof result.summary === 'string' && result.summary.length > 10) return true;
  if (result.delivery_result_recovery?.recovered === true) return true;
  return false;
}

/**
 * Perform a full convergence sweep: sweep stale task states AND complete
 * queued agent_runs for tasks with terminal or result evidence.
 */
export async function convergeStaleTaskStates(store, { repoState, now, dryRun = false } = {}) {
  const state = await store.load();
  const tasks = state.tasks || [];
  const sweepActions = sweepStaleTaskStates({ tasks, repoState, now });

  const { completeQueuedAgentRuns } = await import('./agent-run-writeback.mjs');
  const agentRunCompletions = [];
  for (const task of tasks) {
    if (!task || !task.id) continue;
    if (!hasResultEvidence(task)) continue;
    const result = task.result || {};
    try {
      const r = await completeQueuedAgentRuns(store, {
        task_id: task.id,
        goal_id: task.goal_id || null,
        taskResult: result,
      });
      if (r.completed > 0) {
        agentRunCompletions.push({ task_id: task.id, completed: r.completed, reasons: r.reasons });
      }
    } catch { /* non-blocking */ }
  }

  let applied = 0;
  let errors = [];
  if (!dryRun && sweepActions.length > 0) {
    const applyResult = await applySweepActions(store, sweepActions);
    applied = applyResult.applied;
    errors = applyResult.errors || [];
  }

  return { sweepActions, agentRunCompletions, applied, errors };
}

// ---------------------------------------------------------------------------
// Sweep application
// ---------------------------------------------------------------------------

/**
 * Apply sweep actions to the store.
 *
 * @param {object} store - State store
 * @param {Array<object>} sweepActions - Array of sweep actions
 * @returns {Promise<{ applied: number, errors: Array }>}
 */
export async function applySweepActions(store, sweepActions = []) {
  let applied = 0;
  const errors = [];

  for (const action of sweepActions) {
    try {
      for (const step of action.actions) {
        if (step.type === "update_task_status" && typeof store.updateTask === "function") {
          await store.updateTask(action.taskId, (task) => {
            Object.assign(task, step.payload);
            task.updated_at = new Date().toISOString();
            task.swept_at = task.updated_at;
            if (!Array.isArray(task.logs)) task.logs = [];
            task.logs.push({
              time: task.updated_at,
              message: `[sweeper] ${action.reason}`,
            });
          });
          applied++;
        }
      }
    } catch (err) {
      errors.push({ taskId: action.taskId, error: err.message });
    }
  }

  return { applied, errors };
}
