/**
 * workstream-tick.mjs — Bounded, idempotent tick controller for
 * workstream state advancement.
 *
 * Each tick processes up to MAX_STATE_TRANSITIONS state transitions:
 *   1. Detect drift (phase/scope/stale progress/queue mismatch)
 *   2. Detect stall (dead TUI/stale worker/stale lock)
 *   3. Run acceptance controller for recently completed tasks
 *   4. Advance workflow-eligible tasks
 *   5. Reconcile review backlog
 *
 * Idempotent: Repeated ticks with same state produce same result.
 * Max 5 state transitions per tick to bound re-entrant risk.
 *
 * Integration with workflow-advance and review backlog:
 *   - Calls workflow-advance compatible step for eligible tasks
 *   - Reads and reconciles review backlog state
 *   - Uses same store and config as existing orchestration
 */

import { detectDrift } from "./workstream-drift-detector.mjs";
import { detectStall } from "./workstream-stall-detector.mjs";
import { runAcceptanceController, executeControllerAction, CONTROLLER_ACTION } from "../acceptance/workstream-acceptance-controller.mjs";
import { evaluateAcceptance, VERDICT } from "../acceptance/workstream-acceptance-decision.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_STATE_TRANSITIONS = 5;

export const TRANSITION_KIND = Object.freeze({
  DRIFT_DETECTED: "drift_detected",
  STALL_DETECTED: "stall_detected",
  ACCEPTANCE_EVALUATED: "acceptance_evaluated",
  TASK_ADVANCED: "task_advanced",
  REVIEW_RECONCILED: "review_reconciled",
  REPAIR_CREATED: "repair_created",
  CONVERGENCE_CREATED: "convergence_created",
  ESCALATION_CREATED: "escalation_created",
  DIRECT_CORRECTION: "direct_correction",
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isoNow() {
  return new Date().toISOString();
}

function isTaskTerminal(task = {}) {
  return TERMINAL_STATUSES.has(task.status);
}

// ---------------------------------------------------------------------------
// Tick steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Detect drift for the workstream.
 *
 * @param {object} options
 * @param {object} options.workstream
 * @param {object[]} options.tasks
 * @param {object} options.progress
 * @returns {object} Transition result
 */
export function tickDriftDetection({ workstream = {}, tasks = [], progress = {} } = {}) {
  const findings = [];
  for (const task of asArray(tasks)) {
    if (!task.id) continue;
    const result = detectDrift({
      task,
      workstream,
      progress,
      expectedPhase: workstream.phase || "",
      expectedScopes: [workstream.workflow_id || ""].filter(Boolean),
    });
    if (result.drifted) findings.push(...result.findings);
  }

  return {
    kind: TRANSITION_KIND.DRIFT_DETECTED,
    count: findings.length,
    findings: findings.map((f) => ({ code: f.code, message: f.message, detail: f.detail })),
    summary: findings.length > 0 ? `${findings.length} drift(s) detected.` : "No drift.",
    idempotency_key: `tick:drift:${findings.map((f) => f.code).sort().join("|") || "none"}`,
  };
}

/**
 * Step 2: Detect stall for the workstream.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.tuiSession
 * @param {object} options.lock
 * @param {object} options.parentTask
 * @param {object[]} options.siblingTasks
 * @returns {object} Transition result
 */
export function tickStallDetection({ task = {}, tuiSession = {}, lock = {}, parentTask = {}, siblingTasks = [] } = {}) {
  const result = detectStall({
    task,
    tuiSession,
    lock,
    parentTask,
    siblingTasks,
  });

  return {
    kind: TRANSITION_KIND.STALL_DETECTED,
    count: result.stall_count,
    findings: result.findings.map((f) => ({ code: f.code, message: f.message, detail: f.detail })),
    summary: result.summary,
    stalled: result.stalled,
    idempotency_key: result.idempotency_key,
  };
}

/**
 * Step 3: Run acceptance controller for recently completed tasks.
 *
 * @param {object} options
 * @param {object[]} options.completedTasks - Tasks that recently completed
 * @param {object} options.goal - Goal for the task
 * @param {object} options.workstream
 * @param {object[]} options.corrections - Correction candidates per task
 * @param {object} options.state - State for repair records
 * @returns {Promise<object>} Transition result
 */
export async function tickAcceptanceEvaluation({
  completedTasks = [],
  goal = {},
  workstream = {},
  corrections = [],
  state = {},
} = {}) {
  const evaluations = [];
  const repairsCreated = [];

  for (const task of asArray(completedTasks)) {
    if (!task.id) continue;

    const controllerResult = await runAcceptanceController({
      task,
      goal,
      workstream,
      result: task.result || {},
      verification: task.result?.verification || {},
      contract: goal.acceptance_contract || {},
      gitState: { dirty: false, diff_empty: true },
      corrections: asArray(corrections).filter((c) => c.task_id === task.id),
      state,
    });

    evaluations.push({
      task_id: task.id,
      controller_verdict: controllerResult.controller_verdict,
      acceptance_verdict: controllerResult.decision?.verdict || null,
      action: controllerResult.action?.action || null,
    });

    if (controllerResult.controller_verdict === "repair_goal_required" ||
        controllerResult.controller_verdict === "convergence_goal_required" ||
        controllerResult.controller_verdict === "chatgpt_escalation_required") {
      repairsCreated.push(controllerResult);
    }
  }

  return {
    kind: TRANSITION_KIND.ACCEPTANCE_EVALUATED,
    count: evaluations.length,
    evaluations,
    repairs_created: repairsCreated.length,
    summary: `Evaluated ${evaluations.length} task(s). ${repairsCreated.length} repair/convergence/escalation(s) needed.`,
    idempotency_key: `tick:acceptance:${evaluations.map((e) => `${e.task_id}:${e.controller_verdict}`).sort().join("|") || "none"}`,
  };
}

/**
 * Step 4: Advance workflow-eligible tasks.
 *
 * @param {object} options
 * @param {object[]} options.tasks
 * @param {object} options.workstream
 * @returns {object} Transition result
 */
export function tickTaskAdvancement({ tasks = [], workstream = {} } = {}) {
  const advanced = [];
  const advancedStatuses = new Set(["assigned", "queued", "waiting_for_lock"]);

  for (const task of asArray(tasks)) {
    if (!task.id) continue;
    if (!advancedStatuses.has(task.status)) continue;

    // Check if there's an existing advance for this task
    if (task.tick_advanced) {
      advanced.push({ task_id: task.id, old_status: task.status, new_status: task.status, reason: "Already advanced this tick." });
      continue;
    }

    // Simulate advancement logic (caller handles actual store mutation)
    let newStatus = task.status;
    if (task.status === "assigned") newStatus = "queued";
    else if (task.status === "queued") newStatus = "running";
    else if (task.status === "waiting_for_lock") newStatus = "running";

    advanced.push({ task_id: task.id, old_status: task.status, new_status: newStatus, reason: `Status transition ${task.status} → ${newStatus}` });
  }

  return {
    kind: TRANSITION_KIND.TASK_ADVANCED,
    count: advanced.length,
    advancements: advanced,
    summary: `${advanced.length} task(s) advanced.`,
    idempotency_key: `tick:advance:${advanced.map((a) => `${a.task_id}:${a.old_status}->${a.new_status}`).sort().join("|") || "none"}`,
  };
}

/**
 * Step 5: Reconcile review backlog.
 *
 * @param {object} options
 * @param {object[]} options.reviewBacklog
 * @param {object} options.state
 * @returns {object} Transition result
 */
export function tickReviewReconciliation({ reviewBacklog = [], state = {} } = {}) {
  const reconciled = [];
  const reviewStates = new Set(["waiting_for_review", "waiting_for_repair", "waiting_for_integration"]);

  for (const item of asArray(reviewBacklog)) {
    if (!item.task_id && !item.id) continue;
    const status = item.status || item.task_status || "";
    if (!reviewStates.has(status)) continue;

    // Check if already resolved by successor
    if (item.resolved_by_task_id || item.superseded_by_task_id) {
      reconciled.push({
        task_id: item.task_id || item.id,
        status,
        reconciled: true,
        reason: "Already resolved by successor or superseded.",
      });
      continue;
    }

    // Caller checks actual reconciler
    reconciled.push({
      task_id: item.task_id || item.id,
      status,
      reconciled: false,
      reason: "Pending reconciliation via review-backlog-reconciler.",
    });
  }

  return {
    kind: TRANSITION_KIND.REVIEW_RECONCILED,
    count: reconciled.length,
    reconciled_items: reconciled,
    summary: `${reconciled.length} backlog item(s) evaluated.`,
    idempotency_key: `tick:review:${reconciled.map((r) => `${r.task_id}:${r.reconciled}`).sort().join("|") || "none"}`,
  };
}

// ---------------------------------------------------------------------------
// Main tick runner
// ---------------------------------------------------------------------------

/**
 * Run one tick of the workstream controller, processing up to
 * MAX_STATE_TRANSITIONS state transitions.
 *
 * @param {object} options
 * @param {object} options.workstream - Workstream record
 * @param {object[]} options.tasks - All tasks in the workstream
 * @param {object} options.goal - Goal record
 * @param {object} [options.progress={}] - Structured progress data
 * @param {object} [options.tuiSession={}] - TUI session data
 * @param {object} [options.lock={}] - Lock data
 * @param {object} [options.parentTask={}] - Parent task (if any)
 * @param {object[]} [options.reviewBacklog=[]] - Review backlog items
 * @param {object[]} [options.corrections=[]] - Correction candidates
 * @param {object} [options.state={}] - State for repair records
 * @param {number} [options.maxTransitions=5] - Max transitions for this tick
 * @returns {Promise<{
 *   tick_id: string,
 *   transitions: object[],
 *   transition_count: number,
 *   state_transitions: number,
 *   summary: string,
 *   idempotency_key: string,
 *   timestamp: string,
 *   errors: string[],
 * }>}
 */
export async function runTick({
  workstream = {},
  tasks = [],
  goal = {},
  progress = {},
  tuiSession = {},
  lock = {},
  parentTask = {},
  reviewBacklog = [],
  corrections = [],
  state = {},
  maxTransitions = MAX_STATE_TRANSITIONS,
} = {}) {
  const transitions = [];
  const errors = [];
  const tickId = `tick_${isoNow().replace(/[:-]/g, "").replace(/\..+/, "")}`;
  const budget = Math.max(1, Math.min(Number(maxTransitions) || MAX_STATE_TRANSITIONS, MAX_STATE_TRANSITIONS));

  try {
    // Step 1: Drift detection (always runs, count=0 if none)
    if (transitions.length < budget) {
      const driftResult = tickDriftDetection({ workstream, tasks, progress });
      transitions.push(driftResult);
    }

    // Step 2: Stall detection
    if (transitions.length < budget) {
      const stallResult = tickStallDetection({
        task: tasks[0] || {},
        tuiSession,
        lock,
        parentTask,
        siblingTasks: tasks.slice(1),
      });
      transitions.push(stallResult);
    }

    // Step 3: Acceptance evaluation for recently completed tasks
    if (transitions.length < budget) {
      const completedTasks = asArray(tasks).filter((t) => isTaskTerminal(t));
      if (completedTasks.length > 0) {
        try {
          const acceptanceResult = await tickAcceptanceEvaluation({
            completedTasks,
            goal,
            workstream,
            corrections,
            state,
          });
          transitions.push(acceptanceResult);
        } catch (err) {
          errors.push(`Acceptance evaluation error: ${err.message}`);
        }
      } else {
        transitions.push({
          kind: TRANSITION_KIND.ACCEPTANCE_EVALUATED,
          count: 0,
          evaluations: [],
          repairs_created: 0,
          summary: "No completed tasks to evaluate.",
          idempotency_key: "tick:acceptance:none",
        });
      }
    }

    // Step 4: Task advancement
    if (transitions.length < budget) {
      const advanceResult = tickTaskAdvancement({ tasks, workstream });
      transitions.push(advanceResult);
    }

    // Step 5: Review reconciliation
    if (transitions.length < budget) {
      const reviewResult = tickReviewReconciliation({ reviewBacklog, state });
      transitions.push(reviewResult);
    }

  } catch (err) {
    errors.push(`Tick error: ${err.message}`);
  }

  const transitionIds = transitions.map((t) => t.kind).join("|");
  const driftCodes = transitions.filter((t) => t.kind === TRANSITION_KIND.DRIFT_DETECTED)
    .flatMap((t) => t.findings || []).map((f) => f.code).sort().join("|");

  return {
    tick_id: tickId,
    transitions,
    transition_count: transitions.length,
    state_transitions: transitions.length,
    summary: transitions.length > 0
      ? `Tick completed: ${transitions.length} transition(s) [${transitions.map((t) => `${t.kind}:${t.count}`).join(", ")}].`
      : "Tick completed with no transitions.",
    idempotency_key: `tick:${transitionIds}:${driftCodes}`,
    timestamp: isoNow(),
    errors,
  };
}

export default {
  runTick,
  tickDriftDetection,
  tickStallDetection,
  tickAcceptanceEvaluation,
  tickTaskAdvancement,
  tickReviewReconciliation,
  MAX_STATE_TRANSITIONS,
  TRANSITION_KIND,
};
