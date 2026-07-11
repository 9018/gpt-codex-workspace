/**
 * workstream-acceptance-controller.mjs — Workstream acceptance
 * controller that orchestrates acceptance evaluation, repair,
 * convergence, and escalation.
 *
 * Flow:
 *   1. Receive task + goal + evidence
 *   2. Run evaluateAcceptance to get verdict
 *   3. Run scheduleRepairAction to determine action
 *   4. Execute action (repair goal, convergence, escalation, direct correction)
 *   5. Record repair record for idempotency
 *
 * Integration with workflow-advance and review backlog:
 *   - Exposes controllerResult that can be consumed by workflow-advance
 *   - Reads review backlog state when evaluating
 *   - Records actions in a way review backlog reconciler can read
 *
 * Idempotent: Repeated calls with same input produce same output
 * (or no side effects if already processed).
 */

import { evaluateAcceptance, VERDICT, quickAcceptanceCheck } from "./workstream-acceptance-decision.mjs";
import { scheduleRepairAction, findExistingRepairRecord, MAX_REPAIR_ATTEMPTS, REPAIR_KIND } from "./workstream-repair-task-factory.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTROLLER_ACTION = Object.freeze({
  NONE: "none",
  CREATE_REPAIR_GOAL: "create_repair_goal",
  CREATE_CONVERGENCE_GOAL: "create_convergence_goal",
  CHATGPT_ESCALATION: "chatgpt_escalation",
  DIRECT_CORRECTION: "direct_correction",
  DEDUPLICATED: "deduplicated",
  UNKNOWN: "unknown",
});

const DEFAULT_OPTIONS = Object.freeze({
  maxStateTransitionsPerTick: 5,
  requireCleanWorktree: true,
  requireCommit: true,
  requireTests: true,
  requireDocumentationUpdate: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Repair record helpers
// ---------------------------------------------------------------------------

function getRepairRecords(state) {
  return asArray(state.repair_records || state.workstream_repair_records || []);
}

function appendRepairRecord(state, record) {
  const records = getRepairRecords(state);
  records.push(record);
  if (!Array.isArray(state.workstream_repair_records)) {
    state.workstream_repair_records = records;
  }
}

// ---------------------------------------------------------------------------
// Controller execution
// ---------------------------------------------------------------------------

/**
 * Execute a full acceptance controller pass for a task.
 *
 * Steps:
 *   1. Evaluate acceptance
 *   2. Schedule repair action
 *   3. If direct_correction: return corrections for execution
 *   4. If goal/action: return payload for caller to create
 *   5. Record everything
 *
 * @param {object} options
 * @param {object} options.task - Task record
 * @param {object} options.goal - Goal record
 * @param {object} [options.workstream={}] - Workstream record
 * @param {object} [options.result={}] - Task result
 * @param {object} [options.verification={}] - Verification evidence
 * @param {object} [options.contract={}] - Acceptance contract
 * @param {object} [options.gitState={}] - Git state ({ dirty, diff_empty, commit })
 * @param {object} [options.acceptanceBundle={}] - Pre-built acceptance bundle
 * @param {object[]} [options.corrections=[]] - Direct correction candidates
 * @param {object} [options.state={}] - State to read/write repair records
 * @param {object} [options.options={}] - Controller options
 * @returns {{
 *   controller_verdict: string,
 *   decision: object,
 *   action: object,
 *   corrected: boolean,
 *   error: string|null,
 *   idempotency_key: string,
 *   timestamp: string,
 * }}
 */
export async function runAcceptanceController({
  task = {},
  goal = {},
  workstream = {},
  result = {},
  verification = {},
  contract = {},
  gitState = {},
  acceptanceBundle = {},
  corrections = [],
  state = {},
  options = {},
} = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const currentAttempt = Number(task?.repair_attempt || task?.attempt || 0);

  try {
    // Step 1: Evaluate acceptance
    const acceptanceDecision = evaluateAcceptance({
      task,
      goal,
      result,
      verification,
      contract,
      gitState,
      acceptanceBundle,
    });

    // If passed, return immediately
    if (acceptanceDecision.verdict === VERDICT.PASSED) {
      return {
        controller_verdict: "acceptance_passed",
        decision: acceptanceDecision,
        action: { action: CONTROLLER_ACTION.NONE, reason: "Acceptance passed.", payload: null },
        corrected: false,
        error: null,
        idempotency_key: acceptanceDecision.idempotency_key,
        timestamp: isoNow(),
      };
    }

    // Step 2: Schedule repair action (checks dedup internally)
    const repairRecords = getRepairRecords(state);
    const action = scheduleRepairAction({
      task,
      goal,
      acceptanceDecision,
      repairRecords,
      corrections,
      currentAttempt,
    });

    // Step 3: Assemble controller result
    if (action.action === "direct_correction") {
      return {
        controller_verdict: "direct_correction",
        decision: acceptanceDecision,
        action: {
          action: CONTROLLER_ACTION.DIRECT_CORRECTION,
          reason: action.reason,
          payload: action.payload,
          corrections: action.payload?.corrections || corrections,
        },
        corrected: true,
        error: null,
        idempotency_key: `acceptance:correction:${acceptanceDecision.idempotency_key}`,
        timestamp: isoNow(),
        repair_record: action.record,
      };
    }

    if (action.action === "create_repair_goal") {
      return {
        controller_verdict: "repair_goal_required",
        decision: acceptanceDecision,
        action: {
          action: CONTROLLER_ACTION.CREATE_REPAIR_GOAL,
          reason: action.reason,
          payload: action.payload,
          attempt: currentAttempt + 1,
        },
        corrected: false,
        error: null,
        idempotency_key: `acceptance:repair:${currentAttempt + 1}:${acceptanceDecision.idempotency_key}`,
        timestamp: isoNow(),
        repair_record: action.record,
        deduplicated: action.deduplicated,
        existing_record: action.existing_record,
      };
    }

    if (action.action === "create_convergence_goal") {
      return {
        controller_verdict: "convergence_goal_required",
        decision: acceptanceDecision,
        action: {
          action: CONTROLLER_ACTION.CREATE_CONVERGENCE_GOAL,
          reason: action.reason,
          payload: action.payload,
        },
        corrected: false,
        error: null,
        idempotency_key: `acceptance:convergence:${acceptanceDecision.idempotency_key}`,
        timestamp: isoNow(),
        repair_record: action.record,
        deduplicated: action.deduplicated,
        existing_record: action.existing_record,
      };
    }

    if (action.action === "chatgpt_escalation") {
      return {
        controller_verdict: "chatgpt_escalation_required",
        decision: acceptanceDecision,
        action: {
          action: CONTROLLER_ACTION.CHATGPT_ESCALATION,
          reason: action.reason,
          payload: action.payload,
        },
        corrected: false,
        error: null,
        idempotency_key: `acceptance:escalation:${acceptanceDecision.idempotency_key}`,
        timestamp: isoNow(),
        repair_record: action.record,
        deduplicated: action.deduplicated,
        existing_record: action.existing_record,
      };
    }

    // Deduplicated or unknown
    return {
      controller_verdict: action.deduplicated ? "already_processed" : "unknown_verdict",
      decision: acceptanceDecision,
      action: {
        action: action.deduplicated ? CONTROLLER_ACTION.DEDUPLICATED : CONTROLLER_ACTION.UNKNOWN,
        reason: action.reason,
        payload: null,
      },
      corrected: false,
      error: null,
      idempotency_key: `acceptance:${action.action}:${acceptanceDecision.idempotency_key}`,
      timestamp: isoNow(),
      repair_record: action.record,
      deduplicated: action.deduplicated,
      existing_record: action.existing_record,
    };
  } catch (err) {
    return {
      controller_verdict: "error",
      decision: null,
      action: { action: CONTROLLER_ACTION.UNKNOWN, reason: `Controller error: ${err.message}`, payload: null },
      corrected: false,
      error: err.message || String(err),
      idempotency_key: null,
      timestamp: isoNow(),
    };
  }
}

/**
 * Create the actual goal/task in the store using the controller's action payload.
 *
 * @param {object} options
 * @param {object} options.store - State store
 * @param {object} options.config - Server config
 * @param {object} options.controllerResult - Result from runAcceptanceController
 * @param {object} [options.context] - Auth context
 * @returns {Promise<object>}
 */
export async function executeControllerAction({
  store,
  config = {},
  controllerResult,
  context,
} = {}) {
  if (!controllerResult) {
    return { executed: false, error: "No controller result provided." };
  }

  const action = controllerResult.action;
  if (!action || !action.action || action.action === CONTROLLER_ACTION.NONE || action.action === CONTROLLER_ACTION.DEDUPLICATED || action.action === CONTROLLER_ACTION.UNKNOWN) {
    return { executed: true, skipped: true, reason: `No execution needed for action: ${action?.action || "none"}` };
  }

  if (action.action === CONTROLLER_ACTION.DIRECT_CORRECTION) {
    // Direct corrections are executed by the caller using the payload
    return {
      executed: false,
      requires_direct_execution: true,
      payload: action.payload,
      reason: "Direct correction payload ready for execution.",
    };
  }

  if (action.action === CONTROLLER_ACTION.CREATE_REPAIR_GOAL) {
    try {
      const { createGoal } = await import("../goal-task-goals.mjs");
      const created = await createGoal(store, config, action.payload, context);
      return { executed: true, created_goal: true, goal: created.goal, task: created.task, reason: "Repair goal created." };
    } catch (err) {
      return { executed: false, error: `Failed to create repair goal: ${err.message}` };
    }
  }

  if (action.action === CONTROLLER_ACTION.CREATE_CONVERGENCE_GOAL) {
    try {
      const { createGoal } = await import("../goal-task-goals.mjs");
      const created = await createGoal(store, config, action.payload, context);
      return { executed: true, created_goal: true, goal: created.goal, task: created.task, reason: "Convergence goal created." };
    } catch (err) {
      return { executed: false, error: `Failed to create convergence goal: ${err.message}` };
    }
  }

  if (action.action === CONTROLLER_ACTION.CHATGPT_ESCALATION) {
    try {
      const { createChatGptRequest } = await import("../tool-groups/chatgpt-request-tools-group.mjs");
      const request = await createChatGptRequest(store, action.payload);
      return { executed: true, created_escalation: true, request, reason: "ChatGPT escalation created." };
    } catch (err) {
      return { executed: false, error: `Failed to create ChatGPT escalation: ${err.message}` };
    }
  }

  return { executed: false, error: `Unknown action type: ${action.action}` };
}

export default {
  runAcceptanceController,
  executeControllerAction,
  CONTROLLER_ACTION,
  VERDICT,
  MAX_REPAIR_ATTEMPTS,
};
