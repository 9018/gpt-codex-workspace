import { randomUUID } from "node:crypto";

export const WORKSTREAM_IDENTITY_FIELDS = Object.freeze([
  "workstream_id",
  "root_goal_id",
  "parent_goal_id",
  "phase",
  "iteration",
  "shard_key",
  "workflow_id",
]);

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  max_parallel_tasks: 3,
  max_tui_sessions: 3,
  max_subagents_per_task: 4,
  max_subagent_depth: 1,
  max_repair_iterations: 2,
});

export const DEFAULT_ACCEPTANCE_POLICY = Object.freeze({
  require_clean_worktree: true,
  require_commit: true,
  require_tests: true,
  require_documentation_update: true,
});

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function identifier(value, prefix, field) {
  const normalized = requiredString(value, field);
  if (!normalized.startsWith(prefix)) throw new Error(`${field} must start with ${prefix}`);
  return normalized;
}

function iterationValue(value) {
  if (value === undefined || value === null || value === "") return 0;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error("iteration must be a non-negative integer");
  }
  return normalized;
}

function objectValue(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : { ...fallback };
}

export function createWorkstreamRecord(input = {}, now = new Date().toISOString()) {
  const id = input.id === undefined
    ? `ws_${randomUUID()}`
    : identifier(input.id, "ws_", "workstream id");
  return {
    id,
    title: requiredString(input.title, "title"),
    project_id: optionalString(input.project_id) || "default",
    workspace_id: optionalString(input.workspace_id) || "hosted-default",
    repo_id: optionalString(input.repo_id) || "default",
    root_goal_id: optionalString(input.root_goal_id),
    workflow_id: optionalString(input.workflow_id),
    status: optionalString(input.status) || "planned",
    summary: String(input.summary || ""),
    execution_policy: {
      ...DEFAULT_EXECUTION_POLICY,
      ...objectValue(input.execution_policy),
    },
    acceptance_policy: {
      ...DEFAULT_ACCEPTANCE_POLICY,
      ...objectValue(input.acceptance_policy),
    },
    created_by: optionalString(input.created_by) || "system",
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  };
}

export function normalizeWorkstreamRecord(record = {}) {
  return createWorkstreamRecord({
    ...record,
    id: record.id,
    title: record.title || record.id,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }, record.created_at || new Date().toISOString());
}

export function createWorkstreamContextLinkRecord(input = {}, now = new Date().toISOString()) {
  const id = input.id === undefined
    ? `link_${randomUUID()}`
    : identifier(input.id, "link_", "context link id");
  return {
    id,
    workstream_id: identifier(input.workstream_id, "ws_", "workstream_id"),
    kind: requiredString(input.kind, "kind"),
    external_id: requiredString(input.external_id, "external_id"),
    relation: optionalString(input.relation) || "related",
    goal_id: optionalString(input.goal_id),
    task_id: optionalString(input.task_id),
    metadata: objectValue(input.metadata),
    first_seen_at: input.first_seen_at || now,
    last_seen_at: input.last_seen_at || now,
  };
}

export function normalizeWorkstreamContextLink(record = {}) {
  return createWorkstreamContextLinkRecord({
    ...record,
    id: record.id,
    first_seen_at: record.first_seen_at,
    last_seen_at: record.last_seen_at,
  }, record.first_seen_at || new Date().toISOString());
}

export function workstreamIdentityFrom(record = {}, fallback = {}) {
  return {
    workstream_id: optionalString(record.workstream_id ?? fallback.workstream_id),
    root_goal_id: optionalString(record.root_goal_id ?? fallback.root_goal_id),
    parent_goal_id: optionalString(record.parent_goal_id ?? fallback.parent_goal_id),
    phase: optionalString(record.phase ?? fallback.phase),
    iteration: iterationValue(record.iteration ?? fallback.iteration),
    shard_key: optionalString(record.shard_key ?? fallback.shard_key),
    workflow_id: optionalString(record.workflow_id ?? fallback.workflow_id),
  };
}

export function normalizeLegacyGoalWorkstream(goal = {}) {
  return {
    ...goal,
    ...workstreamIdentityFrom(goal, { root_goal_id: goal.id, iteration: 0 }),
  };
}

export function normalizeLegacyTaskWorkstream(task = {}, goal = null) {
  return {
    ...task,
    ...workstreamIdentityFrom(task, {
      workstream_id: goal?.workstream_id,
      root_goal_id: goal?.root_goal_id || goal?.id || task.goal_id,
      parent_goal_id: goal?.parent_goal_id,
      phase: goal?.phase,
      iteration: goal?.iteration ?? 0,
      shard_key: goal?.shard_key,
      workflow_id: goal?.workflow_id,
    }),
  };
}
