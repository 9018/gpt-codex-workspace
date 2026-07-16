import { ProgressionCommandError, PROGRESSION_ERROR_CODES } from "./progression-errors.mjs";

export const PROGRESSION_ACTIONS = Object.freeze([
  "complete_task",
  "propagate_goal",
  "advance_queue",
  "create_repair_task",
  "queue_repair_task",
  "inherit_repair_result",
  "integrate_change",
  "restart_runtime",
  "create_successor_task",
  "reconcile_workstream",
  "cleanup_worktree",
]);

export const PROGRESSION_COMMAND_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "applied",
  "failed",
  "superseded",
]);

const ACTION_SCHEMAS = Object.freeze({
  complete_task: ["task_id", "unified_decision"],
  propagate_goal: ["task_id", "goal_id"],
  advance_queue: ["task_id"],
  create_repair_task: ["parent_task_id", "blockers", "repair_budget_revision"],
  queue_repair_task: ["repair_task_id"],
  inherit_repair_result: ["parent_task_id", "repair_task_id"],
  integrate_change: ["task_id", "source_commit", "target_branch"],
  restart_runtime: ["task_id", "restart_marker"],
  create_successor_task: ["parent_task_id", "successor_spec"],
  reconcile_workstream: ["workstream_id"],
  cleanup_worktree: ["task_id", "worktree_path"],
});

function invalid(message, details) {
  throw new ProgressionCommandError(PROGRESSION_ERROR_CODES.INVALID_COMMAND, message, details);
}

export function validateProgressionPayload(action, payload) {
  if (!PROGRESSION_ACTIONS.includes(action)) invalid(`Unknown progression action: ${action}`, { action });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    invalid("payload must be an object", { action });
  }
  for (const field of ACTION_SCHEMAS[action]) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === "") {
      invalid(`payload.${field} is required for ${action}`, { action, field });
    }
  }
  try {
    JSON.stringify(payload);
  } catch {
    invalid("payload must be JSON-serializable", { action });
  }
  return { ...payload };
}

export function normalizeProgressionCommand(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("command must be an object");
  if (!input.task_id || typeof input.task_id !== "string") invalid("task_id is required");
  if (input.decision_revision === undefined || input.decision_revision === null || input.decision_revision === "") {
    invalid("decision_revision is required");
  }
  const action = String(input.action || "");
  const payload = validateProgressionPayload(action, input.payload);
  return {
    task_id: input.task_id,
    goal_id: input.goal_id || null,
    decision_revision: input.decision_revision,
    action,
    payload,
    preconditions: input.preconditions && typeof input.preconditions === "object"
      ? { ...input.preconditions }
      : {},
    idempotency_key: input.idempotency_key || null,
    max_attempts: Math.max(1, Number(input.max_attempts) || 3),
  };
}
