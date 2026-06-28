const LEGACY_REVIEW_STATUSES = new Set(["failed", "timed_out", "blocked", "waiting_for_review", "waiting_for_repair"]);
const COMPLETED_STATUSES = new Set(["completed"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "timed_out", "blocked", "cancelled"]);
const ACTIVE_OR_REVIEW_TASK_STATUSES = new Set(["queued", "assigned", "running", "waiting_for_lock", "waiting_for_review", "waiting_for_repair", "waiting_for_integration"]);
const FAILED_LEGACY_STATUSES = new Set(["failed", "timed_out", "cancelled", "blocked"]);

export function hasCompletionEvidence(taskResult = {}) {
  if (taskResult.reviewer_decision?.passed === true) return true;
  if (["accepted", "accepted_with_followups"].includes(taskResult.reviewer_decision?.status)) return true;
  if (taskResult.verification?.passed === true) return true;
  if (taskResult.integration?.status === "merged" || taskResult.integration?.status === "skipped" || taskResult.integration?.merged === true) return true;
  return false;
}

export function isResolvedLegacyReviewTask(task = {}) {
  if (task.status !== "waiting_for_review") return false;
  const result = task.result || {};
  return Boolean(result.resolved_by_task_id || result.superseded_by_task_id || result.auto_accepted || result.accepted_at);
}

/**
 * Check if a terminal-status task (failed/timed_out/cancelled/blocked) has
 * no meaningful result content. A no-result failure is one where:
 * - task.result is null, undefined, or absent
 * - task.result_id is not set or is "none"/"null" (serialization artifacts)
 *
 * These are historical failures that never produced any actionable evidence
 * and should be treated as legacy/resolved.
 */
function isNoResultFailure(task = {}) {
  if (!FAILED_LEGACY_STATUSES.has(task.status)) return false;
  const result = task.result;
  // True when result is a real object (empty or not), not null/undefined/missing
  const hasAnyResult = result !== null && result !== undefined && result !== '';
  // result_id = "none" means no result was written (Python None serialization artifact)
  const resultIdValue = task.result_id;
  const hasMeaningfulResultId = resultIdValue && resultIdValue !== 'none' && resultIdValue !== 'null';
  return !hasAnyResult && !hasMeaningfulResultId;
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function textIncludesAny(value, patterns = []) {
  if (!hasNonEmptyString(value)) return false;
  const lower = value.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function hasIntegrationFailureEvidence(result = {}) {
  const status = result.integration?.status || result.delivery?.status || null;
  return ["conflict", "check_failed", "push_failed", "pr_failed", "failed", "error"].includes(status);
}

function hasCodeFailureEvidence(result = {}) {
  if (hasNonEmptyArray(result.changed_files)) return true;
  if (hasNonEmptyString(result.tests)) return true;
  if (result.verification?.passed === false) return true;
  if (hasIntegrationFailureEvidence(result)) return true;
  return false;
}

/**
 * Terminal Codex/provider executions sometimes fail before producing any
 * actionable code evidence: no changed files, no tests, no commit, and a
 * result_missing/no-op/codex_failed diagnostic. These are operational history,
 * not current code blockers. Keep this narrower than isNoResultFailure so a
 * plain failed task with an empty result object still remains actionable.
 */
export function isHistoricalProviderNoResultFailure(task = {}) {
  if (!FAILED_LEGACY_STATUSES.has(task.status)) return false;
  const result = task.result || {};
  if (!result || typeof result !== "object") return false;
  if (hasCodeFailureEvidence(result)) return false;

  const providerShape =
    result.kind === "codex_failed" ||
    result.failure_class === "result_missing" ||
    result.noop === true;
  if (!providerShape) return false;

  if (hasNonEmptyString(result.commit) || hasNonEmptyString(result.local_head) || hasNonEmptyString(result.remote_head)) return false;

  const diagnosticText = [
    result.failure_class,
    result.summary,
    result.diagnostics?.detected_reason,
    result.diagnostics?.result_json_error,
  ].filter(Boolean).join("\n");

  return textIncludesAny(diagnosticText, [
    "result_missing",
    "no changed files",
    "no tests",
    "no commit",
    "no structured summary",
    "not found or invalid",
    "no-op",
  ]);
}

export function isResolvedLegacyTerminalTask(task = {}) {
  if (!FAILED_LEGACY_STATUSES.has(task.status)) return false;
  const result = task.result || {};
  const reconciliationStatus = result.legacy_reconciliation?.status || task.legacy_reconciliation?.status || null;

  // Historical no-result/no-op failure: failed/timed_out with no result content.
  // Tasks that failed before writing any result have no actionable evidence
  // and should not block current work when no active worker is running them.
  if (isNoResultFailure(task)) return true;
  if (isHistoricalProviderNoResultFailure(task)) return true;

  return Boolean(
    task.resolved_legacy === true ||
    result.resolved_legacy === true ||
    result.resolved_by_task_id ||
    result.superseded_by_task_id ||
    task.resolved_by_task_id ||
    task.superseded_by_task_id ||
    ["superseded", "resolved", "resolved_legacy", "resolved_by_successor"].includes(reconciliationStatus)
  );
}

export function legacyResolutionSummary(task = {}) {
  const result = task.result || {};
  const resolved = Boolean(result.resolved_by_task_id || result.superseded_by_task_id || task.resolved_by_task_id || task.superseded_by_task_id);
  return {
    resolved,
    resolved_by_task_id: result.resolved_by_task_id || task.resolved_by_task_id || null,
    superseded_by_task_id: result.superseded_by_task_id || task.superseded_by_task_id || null,
    reason: result.legacy_reconciliation?.reason || result.resolved_reason || null,
  };
}

export function taskRelationIds(task = {}) {
  const result = task.result || {};
  const repair = result.repair || result.repair_goal || {};
  return new Set([
    task.id,
    task.root_task_id,
    task.parent_task_id,
    task.repair_of_task_id,
    result.root_task_id,
    result.parent_task_id,
    result.repair_of_task_id,
    repair.root_task_id,
    repair.parent_task_id,
    repair.repair_of_task_id,
  ].filter(Boolean));
}

function goalRelationIds(goal = {}, task = {}) {
  const result = task.result || {};
  const repair = result.repair || result.repair_goal || {};
  return new Set([
    goal.id,
    task.goal_id,
    task.repair_of_goal_id,
    result.repair_of_goal_id,
    repair.repair_of_goal_id,
  ].filter(Boolean));
}

function successorExplicitlyReferencesLegacy({ legacyTask, legacyGoal, successorTask }) {
  if (!legacyTask || !successorTask || legacyTask.id === successorTask.id) return false;
  const legacyTaskIds = taskRelationIds(legacyTask);
  const successorTaskIds = taskRelationIds(successorTask);

  if (successorTask.parent_task_id && legacyTaskIds.has(successorTask.parent_task_id)) return true;
  if (successorTask.repair_of_task_id && legacyTaskIds.has(successorTask.repair_of_task_id)) return true;
  if (successorTask.root_task_id && successorTask.root_task_id === legacyTask.id) return true;
  if (legacyTask.root_task_id && successorTask.root_task_id === legacyTask.root_task_id) return true;
  if (successorTaskIds.has(legacyTask.id)) return true;

  const legacyGoalIds = goalRelationIds(legacyGoal, legacyTask);
  const successorGoalIds = goalRelationIds({}, successorTask);
  for (const id of successorGoalIds) {
    if (legacyGoalIds.has(id)) return true;
  }

  return false;
}

function taskUpdatedMs(task = {}) {
  const ts = Date.parse(task.updated_at || task.completed_at || task.created_at || "");
  return Number.isFinite(ts) ? ts : 0;
}

function completionEvidence(successorTask = {}, successorGoal = {}) {
  const result = successorTask.result || {};
  return {
    task_id: successorTask.id,
    goal_id: successorTask.goal_id || successorGoal?.id || null,
    commit: result.commit || result.remote_head || result.local_head || null,
    verification_passed: result.verification?.passed === true,
    reviewer_status: result.reviewer_decision?.status || null,
    integration_status: result.integration?.status || null,
    status: successorTask.status,
  };
}

export function findLegacySuccessor({ legacyTask, legacyGoal, tasks = [], goals = [] } = {}) {
  if (!legacyTask || !LEGACY_REVIEW_STATUSES.has(legacyTask.status)) return null;

  const candidates = tasks
    .filter((task) => task && task.id !== legacyTask.id && COMPLETED_STATUSES.has(task.status))
    .filter((task) => hasCompletionEvidence(task.result || {}))
    .filter((task) => successorExplicitlyReferencesLegacy({ legacyTask, legacyGoal, successorTask: task }))
    .sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a));

  const successorTask = candidates[0] || null;
  if (!successorTask) return null;
  const successorGoal = goals.find((goal) => goal.id === successorTask.goal_id) || null;
  return { task: successorTask, goal: successorGoal, evidence: completionEvidence(successorTask, successorGoal) };
}

function sameResolution(goal = {}, task = {}, successor = {}) {
  const result = task.result || {};
  return goal.status === "completed"
    && goal.resolved_by?.task_id === successor.id
    && goal.superseded_by?.task_id === successor.id
    && result.resolved_by_task_id === successor.id
    && result.superseded_by_task_id === successor.id;
}

export function applyLegacyResolution({ goal, task, successor, evidence, timestamp = new Date().toISOString() } = {}) {
  if (!goal || !task || !successor || sameResolution(goal, task, successor)) return false;
  const record = {
    task_id: successor.id,
    goal_id: successor.goal_id || evidence?.goal_id || null,
    commit: evidence?.commit || null,
    resolved_at: timestamp,
    reason: "completed_successor_with_verification_evidence",
    evidence: evidence || completionEvidence(successor),
  };

  goal.status = "completed";
  goal.updated_at = timestamp;
  goal.resolved_by = record;
  goal.superseded_by = record;
  goal.legacy_reconciliation = {
    status: "resolved_by_successor",
    reason: record.reason,
    source_task_id: task.id,
    successor_task_id: successor.id,
    resolved_at: timestamp,
  };

  task.result ||= {};
  task.result.resolved_by_task_id = successor.id;
  task.result.superseded_by_task_id = successor.id;
  task.result.resolved_reason = record.reason;
  task.result.legacy_reconciliation = {
    status: "superseded",
    reason: record.reason,
    successor_task_id: successor.id,
    successor_goal_id: successor.goal_id || evidence?.goal_id || null,
    commit: evidence?.commit || null,
    resolved_at: timestamp,
  };
  task.updated_at = timestamp;
  return true;
}

export function hasResolvedWorktreeEvidence(task = {}) {
  const result = task.result || {};
  if (result.resolved_by_task_id || result.superseded_by_task_id) return true;
  if (result.legacy_reconciliation?.status === "superseded") return true;
  if (result.integration?.status === "merged" || result.integration?.merged === true) return true;
  if (result.delivery?.status === "merged" || result.delivery?.merged === true) return true;
  return false;
}

export function retainedWorktreeDecision(task = {}) {
  if (!task || !task.id) return { action: "skip", reason: "missing_task" };
  if (ACTIVE_OR_REVIEW_TASK_STATUSES.has(task.status)) return { action: "skip", reason: "active_or_review" };
  if (!TERMINAL_TASK_STATUSES.has(task.status)) return { action: "skip", reason: "non_terminal" };
  if (!hasResolvedWorktreeEvidence(task)) return { action: "skip", reason: "needs_manual_review" };
  return { action: "remove", reason: "resolved_terminal" };
}
