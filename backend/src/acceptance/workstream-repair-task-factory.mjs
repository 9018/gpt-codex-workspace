/**
 * workstream-repair-task-factory.mjs — Idempotent repair, convergence,
 * escalation task/goal creation from acceptance verdicts.
 *
 * Budget:
 *   failed  → ≤ 2 repair attempts, then escalation (ChatGPT request)
 *   partial → convergence goal (no budget limit, but unique by key)
 *   passed  → no action
 *   blocked → escalation (ChatGPT request)
 *
 * Idempotency:
 *   Repeated inputs with same root_task_id + attempt + failure_class
 *   must not duplicate repair/convergence/escalation records.
 *   Uses a deduplication store (repair_records) keyed by
 *   { root_task_id, kind, attempt? }.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_REPAIR_ATTEMPTS = 2;

export const REPAIR_KIND = Object.freeze({
  REPAIR_TASK: "repair_task",
  CONVERGENCE_GOAL: "convergence_goal",
  CHATGPT_ESCALATION: "chatgpt_escalation",
  DIRECT_CORRECTION: "direct_correction",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function optional(value) {
  return value != null ? value : null;
}

function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Deduplication check
// ---------------------------------------------------------------------------

/**
 * Check if a repair/convergence/escalation record already exists for the given key.
 *
 * @param {object} options
 * @param {object[]} options.repairRecords - Existing repair records array
 * @param {string} options.rootTaskId - Root task ID
 * @param {string} options.kind - REPAIR_KIND value
 * @param {number} [options.attempt] - Attempt number (for repair_task)
 * @param {string} [options.failureClass] - Failure class hash
 * @returns {{ exists: boolean, existing: object|null }}
 */
export function findExistingRepairRecord({ repairRecords = [], rootTaskId, kind, attempt, failureClass } = {}) {
  if (!rootTaskId) return { exists: false, existing: null };
  const record = asArray(repairRecords).find((r) => {
    if (r.root_task_id !== rootTaskId) return false;
    if (r.kind !== kind) return false;
    if (kind === REPAIR_KIND.REPAIR_TASK && attempt != null && r.attempt != null) {
      return r.attempt === attempt;
    }
    if (kind === REPAIR_KIND.CONVERGENCE_GOAL && r.failure_class && failureClass) {
      return r.failure_class === failureClass;
    }
    // For escalation, any existing escalation for this root_task_id is a duplicate
    if (kind === REPAIR_KIND.CHATGPT_ESCALATION) return true;
    if (kind === REPAIR_KIND.DIRECT_CORRECTION && r.failure_class && failureClass) {
      return r.failure_class === failureClass;
    }
    return false;
  });
  return { exists: record != null, existing: record || null };
}

// ---------------------------------------------------------------------------
// Repair record creation
// ---------------------------------------------------------------------------

function createRepairRecord({ rootTaskId, kind, attempt, failureClass, reason, goalId, taskId, correctionSummary } = {}) {
  const record = {
    id: `repair_${randomUUID()}`,
    root_task_id: rootTaskId,
    kind,
    created_at: isoNow(),
    reason: reason || kind,
  };
  if (attempt != null) record.attempt = attempt;
  if (failureClass) record.failure_class = failureClass;
  if (goalId) record.goal_id = goalId;
  if (taskId) record.task_id = taskId;
  if (correctionSummary) record.correction_summary = correctionSummary;
  return record;
}

// ---------------------------------------------------------------------------
// Repair payload builders
// ---------------------------------------------------------------------------

/**
 * Build a repair goal payload for a failed acceptance.
 *
 * @param {object} options
 * @param {object} options.task - Original task
 * @param {object} options.goal - Original goal
 * @param {object} options.acceptanceDecision - Decision from evaluateAcceptance
 * @param {number} options.attempt - Current repair attempt number (1-indexed)
 * @returns {object} Goal creation payload
 */
export function buildRepairGoalPayload({ task = {}, goal = {}, acceptanceDecision = {}, attempt = 1 } = {}) {
  const findings = asArray(acceptanceDecision.findings);
  const findingsText = findings.length > 0
    ? findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.code}: ${f.message}`).join("\n")
    : "(no specific findings)";

  const goalPrompt = [
    `# Repair: ${task.title || task.id || "Unknown task"} (attempt ${attempt})`,
    "",
    `This is repair attempt ${attempt} for task ${task.id}.`,
    task.root_task_id ? `Root task: ${task.root_task_id}` : "",
    "",
    "## Acceptance Findings",
    findingsText,
    "",
    "## Original Goal",
    goal.goal_prompt || goal.user_request || task.description || "(not available)",
    "",
    "## Constraints",
    "- Do NOT expand scope beyond the original goal",
    "- Fix ONLY the acceptance findings listed above",
    "- Re-run all verification commands after making changes",
    "- Write result.json with the standard contract",
    "- Max repair attempts: ${MAX_REPAIR_ATTEMPTS}",
    "",
  ].filter(Boolean).join("\n");

  return {
    user_request: `Repair: ${task.title || task.id} (attempt ${attempt})`,
    goal_prompt: goalPrompt,
    title: `Repair: ${task.title || task.id} (attempt ${attempt})`,
    project_id: task.project_id || goal.project_id || "default",
    workspace_id: task.workspace_id || goal.workspace_id || "hosted-default",
    mode: task.mode || "builder",
    assign_to_codex: true,
    root_task_id: task.root_task_id || task.id,
    parent_task_id: task.id,
    attempt,
    repair_attempt: attempt,
    max_attempts: MAX_REPAIR_ATTEMPTS,
    repair_of_goal_id: goal.id || task.goal_id || null,
    repair_of_task_id: task.id || null,
    failure_class: acceptanceDecision.verdict || "acceptance_failed",
    acceptance_findings: findings,
  };
}

/**
 * Build a convergence goal payload for partial acceptance.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.goal
 * @param {object} options.acceptanceDecision
 * @param {string} options.convergenceKey - Idempotency key
 * @returns {object} Goal creation payload
 */
export function buildConvergenceGoalPayload({ task = {}, goal = {}, acceptanceDecision = {}, convergenceKey } = {}) {
  const findings = asArray(acceptanceDecision.findings);
  const blockerText = findings.filter((f) => f.severity === "blocker").map((f, i) => `${i + 1}. ${f.code}: ${f.message}`).join("\n");
  const nonBlockerText = findings.filter((f) => f.severity !== "blocker").map((f, i) => `${i + 1}. ${f.code}: ${f.message}`).join("\n");

  const goalPrompt = [
    `# Convergence: ${task.title || task.id || "Unknown task"}`,
    "",
    "Partial acceptance requires convergence. The following issues were found:",
    "",
    blockerText ? "## Blocking Issues\n" + blockerText : "",
    nonBlockerText ? "## Non-Blocking Issues\n" + nonBlockerText : "",
    "",
    "## Original Goal",
    goal.goal_prompt || goal.user_request || task.description || "(not available)",
    "",
    "## Constraints",
    "- Resolve ALL blocking issues listed above",
    "- Address non-blocking issues if time permits",
    "- Re-run verification after changes",
    "",
  ].filter(Boolean).join("\n");

  return {
    user_request: `Convergence: ${task.title || task.id}`,
    goal_prompt: goalPrompt,
    title: `Convergence: ${task.title || task.id}`,
    project_id: task.project_id || goal.project_id || "default",
    workspace_id: task.workspace_id || goal.workspace_id || "hosted-default",
    mode: "builder",
    assign_to_codex: true,
    root_task_id: task.root_task_id || task.id,
    parent_task_id: task.id,
    attempt: 0,
    repair_attempt: 0,
    convergence_key: convergenceKey || `convergence_${task.root_task_id || task.id}`,
    repair_of_goal_id: goal.id || task.goal_id || null,
    repair_of_task_id: task.id || null,
    failure_class: "partial_acceptance",
    acceptance_findings: findings,
  };
}

/**
 * Build a ChatGPT escalation request for budget-exhausted or blocked acceptance.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.goal
 * @param {object} options.acceptanceDecision
 * @param {number} [options.attempt]
 * @returns {object} ChatGPT request payload
 */
export function buildChatGptEscalationPayload({ task = {}, goal = {}, acceptanceDecision = {}, attempt } = {}) {
  const findings = asArray(acceptanceDecision.findings);
  const findingsText = findings.length > 0
    ? findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.code}: ${f.message}`).join("\n")
    : "(no specific findings)";

  const prompt = [
    `# Acceptance Escalation: ${task.title || task.id}`,
    "",
    `Attempt ${attempt != null ? attempt : "N/A"} failed or blocked. Repair budget may be exhausted.`,
    task.root_task_id ? `Root task: ${task.root_task_id}` : "",
    "",
    "## Acceptance Findings",
    findingsText,
    "",
    "## Original Goal",
    goal.goal_prompt || goal.user_request || task.description || "(not available)",
    "",
    "## Previous Attempt Summary",
    task.result?.summary || "(not available)",
    "",
    "## Required Decision",
    "This task could not be automatically repaired. Please review and decide:",
    "- Approve a new repair attempt with adjusted scope",
    "- Mark the task as needs human intervention",
    "- Close the task as intentionally incomplete",
    "",
  ].filter(Boolean).join("\n");

  return {
    title: `Acceptance Escalation: ${task.title || task.id}`,
    prompt,
    source: "workstream_acceptance_controller",
    task_id: task.id,
    goal_id: goal.id || task.goal_id || null,
    workspace_id: task.workspace_id || goal.workspace_id || "hosted-default",
    escalation_category: "acceptance_escalation",
    why_subagents_cannot_decide: "Repair budget exhausted or blocked acceptance requiring human judgment.",
    default_if_no_response: "waiting_for_human_review",
  };
}

/**
 * Build a direct correction payload for small deterministic fixes.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.goal
 * @param {object} options.acceptanceDecision
 * @param {object[]} options.corrections - Array of { file, patch, description }
 * @returns {object} Direct correction descriptor
 */
export function buildDirectCorrectionPayload({ task = {}, goal = {}, acceptanceDecision = {}, corrections = [] } = {}) {
  const findings = asArray(acceptanceDecision.findings);

  return {
    kind: REPAIR_KIND.DIRECT_CORRECTION,
    root_task_id: task.root_task_id || task.id,
    task_id: task.id,
    goal_id: goal.id || task.goal_id || null,
    corrections: corrections.map((c, i) => ({
      id: `correction_${i + 1}`,
      file: c.file,
      patch: c.patch,
      description: c.description || `Correction ${i + 1}`,
    })),
    acceptance_findings: findings,
    created_at: isoNow(),
  };
}

// ---------------------------------------------------------------------------
// Public factory: schedule repair based on verdict
// ---------------------------------------------------------------------------

/**
 * Schedule the appropriate action based on acceptance verdict.
 * Returns a normalized descriptor without mutating store.
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object} options.goal
 * @param {object} options.acceptanceDecision
 * @param {object[]} options.repairRecords - Existing repair records (dedup)
 * @param {object[]} [options.corrections=[]] - Direct corrections (if applicable)
 * @param {number} [options.currentAttempt=0] - How many repair attempts already made
 * @returns {{
 *   action: string,
 *   payload: object|null,
 *   reason: string,
 *   deduplicated: boolean,
 *   existing_record: object|null,
 *   record: object|null,
 * }}
 */
export function scheduleRepairAction({
  task = {},
  goal = {},
  acceptanceDecision = {},
  repairRecords = [],
  corrections = [],
  currentAttempt = 0,
} = {}) {
  const verdict = acceptanceDecision.verdict;
  const rootTaskId = task.root_task_id || task.id;
  const nextAttempt = currentAttempt + 1;

  // Check dedup first
  let dedupCheck;

  switch (verdict) {
    case "passed":
      return { action: "none", payload: null, reason: "Acceptance passed. No action needed.", deduplicated: false, existing_record: null, record: null };

    case "failed": {
      if (currentAttempt >= MAX_REPAIR_ATTEMPTS) {
        dedupCheck = findExistingRepairRecord({
          repairRecords,
          rootTaskId,
          kind: REPAIR_KIND.CHATGPT_ESCALATION,
        });
        if (dedupCheck.exists) {
          return { action: "deduplicated", payload: null, reason: "Escalation already exists for this root task.", deduplicated: true, existing_record: dedupCheck.existing, record: null };
        }
        const payload = buildChatGptEscalationPayload({ task, goal, acceptanceDecision, attempt: currentAttempt });
        const record = createRepairRecord({ rootTaskId, kind: REPAIR_KIND.CHATGPT_ESCALATION, attempt: currentAttempt, failureClass: verdict, reason: "Repair budget exhausted", goalId: payload.goal_id, taskId: payload.task_id });
        return { action: "chatgpt_escalation", payload, reason: `Repair budget exhausted after ${currentAttempt} attempt(s). Escalating to ChatGPT.`, deduplicated: false, existing_record: null, record };
      }

      // Check for existing repair task for this attempt
      dedupCheck = findExistingRepairRecord({
        repairRecords,
        rootTaskId,
        kind: REPAIR_KIND.REPAIR_TASK,
        attempt: nextAttempt,
      });
      if (dedupCheck.exists) {
        return { action: "deduplicated", payload: null, reason: `Repair task for attempt ${nextAttempt} already exists.`, deduplicated: true, existing_record: dedupCheck.existing, record: null };
      }

      // Attempt direct correction if we have small deterministic fixes
      if (corrections.length > 0) {
        dedupCheck = findExistingRepairRecord({
          repairRecords,
          rootTaskId,
          kind: REPAIR_KIND.DIRECT_CORRECTION,
          failureClass: verdict,
        });
        if (!dedupCheck.exists) {
          const payload = buildDirectCorrectionPayload({ task, goal, acceptanceDecision, corrections });
          const record = createRepairRecord({ rootTaskId, kind: REPAIR_KIND.DIRECT_CORRECTION, attempt: 0, failureClass: verdict, reason: "Direct correction", correctionSummary: `${corrections.length} correction(s)` });
          return { action: "direct_correction", payload, reason: `Applying ${corrections.length} direct correction(s) for attempt ${nextAttempt}.`, deduplicated: false, existing_record: null, record };
        }
      }

      // Create repair goal
      const payload = buildRepairGoalPayload({ task, goal, acceptanceDecision, attempt: nextAttempt });
      const record = createRepairRecord({ rootTaskId, kind: REPAIR_KIND.REPAIR_TASK, attempt: nextAttempt, failureClass: verdict, reason: `Repair attempt ${nextAttempt}`, goalId: payload.repair_of_goal_id, taskId: payload.parent_task_id });
      return { action: "create_repair_goal", payload, reason: `Creating repair goal for attempt ${nextAttempt}/${MAX_REPAIR_ATTEMPTS}.`, deduplicated: false, existing_record: null, record };
    }

    case "partial": {
      dedupCheck = findExistingRepairRecord({
        repairRecords,
        rootTaskId,
        kind: REPAIR_KIND.CONVERGENCE_GOAL,
        failureClass: verdict,
      });
      if (dedupCheck.exists) {
          return { action: "deduplicated", payload: null, reason: "Convergence goal already exists for this root task.", deduplicated: true, existing_record: dedupCheck.existing, record: null };
      }
      const convergenceKey = `convergence_${rootTaskId}`;
      const payload = buildConvergenceGoalPayload({ task, goal, acceptanceDecision, convergenceKey });
      const record = createRepairRecord({ rootTaskId, kind: REPAIR_KIND.CONVERGENCE_GOAL, failureClass: verdict, reason: "Partial acceptance convergence", goalId: payload.repair_of_goal_id, taskId: payload.parent_task_id });
      return { action: "create_convergence_goal", payload, reason: "Creating convergence goal for partial acceptance.", deduplicated: false, existing_record: null, record };
    }

    case "blocked": {
      dedupCheck = findExistingRepairRecord({
        repairRecords,
        rootTaskId,
        kind: REPAIR_KIND.CHATGPT_ESCALATION,
      });
      if (dedupCheck.exists) {
        return { action: "deduplicated", payload: null, reason: "Escalation already exists for this blocked acceptance.", deduplicated: true, existing_record: dedupCheck.existing, record: null };
      }
      const payload = buildChatGptEscalationPayload({ task, goal, acceptanceDecision, attempt: currentAttempt });
      const record = createRepairRecord({ rootTaskId, kind: REPAIR_KIND.CHATGPT_ESCALATION, attempt: currentAttempt, failureClass: verdict, reason: "Blocked acceptance escalation", goalId: payload.goal_id, taskId: payload.task_id });
      return { action: "chatgpt_escalation", payload, reason: "Blocked acceptance. Escalating to ChatGPT.", deduplicated: false, existing_record: null, record };
    }

    default:
      return { action: "unknown", payload: null, reason: `Unknown verdict: ${verdict}`, deduplicated: false, existing_record: null, record: null };
  }
}

export default {
  scheduleRepairAction,
  findExistingRepairRecord,
  buildRepairGoalPayload,
  buildConvergenceGoalPayload,
  buildChatGptEscalationPayload,
  buildDirectCorrectionPayload,
  MAX_REPAIR_ATTEMPTS,
  REPAIR_KIND,
};
