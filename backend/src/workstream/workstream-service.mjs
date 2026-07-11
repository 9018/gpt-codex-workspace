import {
  canAccessProject,
  canAccessWorkspace,
  defaultTokenContext,
  requireProjectAccess,
  requireScope,
  requireWorkspaceAccess,
} from "../auth-context.mjs";
import { createWorkstreamRecord, normalizeWorkstreamRecord } from "./workstream-model.mjs";
import { ensureWorkstreamState, findWorkstreamInState, workstreamsFromState } from "./workstream-store.mjs";

const IMMUTABLE_FIELDS = new Set(["id", "created_at", "created_by"]);
const MUTABLE_FIELDS = new Set([
  "title",
  "project_id",
  "workspace_id",
  "repo_id",
  "root_goal_id",
  "workflow_id",
  "status",
  "summary",
  "execution_policy",
  "acceptance_policy",
]);

function requireWorkstreamAccess(context, workstream) {
  requireProjectAccess(context, workstream.project_id);
  requireWorkspaceAccess(context, workstream.workspace_id);
}

export async function createWorkstream(store, input = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  const record = createWorkstreamRecord({ ...input, created_by: input.created_by || context.user_id });
  requireWorkstreamAccess(context, record);

  return store.mutate((state) => {
    ensureWorkstreamState(state);
    if (findWorkstreamInState(state, record.id)) {
      throw new Error(`workstream already exists: ${record.id}`);
    }
    state.workstreams.push(record);
    state.activities ||= [];
    state.activities.push({
      time: record.created_at,
      type: "workstream.created",
      workstream_id: record.id,
      title: record.title,
    });
    return { ...record };
  });
}

export async function getWorkstream(store, id, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  const record = typeof store.findWorkstreamById === "function"
    ? await store.findWorkstreamById(id)
    : findWorkstreamInState(state, id);
  if (!record) throw new Error(`workstream not found: ${id}`);
  requireWorkstreamAccess(context, record);
  return normalizeWorkstreamRecord(record);
}

export async function listWorkstreams(store, filters = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  let records = workstreamsFromState(state).filter((item) =>
    canAccessProject(context, item.project_id) && canAccessWorkspace(context, item.workspace_id));
  for (const field of ["status", "project_id", "workspace_id", "repo_id", "root_goal_id", "workflow_id"]) {
    if (filters[field]) records = records.filter((item) => item[field] === filters[field]);
  }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  return records
    .slice()
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))
    .slice(0, limit)
    .map(normalizeWorkstreamRecord);
}

export async function updateWorkstream(store, id, patch = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE_FIELDS.has(field) || !MUTABLE_FIELDS.has(field)) {
      throw new Error(`cannot update workstream field: ${field}`);
    }
  }

  return store.mutate((state) => {
    ensureWorkstreamState(state);
    const current = findWorkstreamInState(state, id);
    if (!current) throw new Error(`workstream not found: ${id}`);
    requireWorkstreamAccess(context, current);
    const mergedPatch = {
      ...patch,
      ...(patch.execution_policy
        ? { execution_policy: { ...(current.execution_policy || {}), ...patch.execution_policy } }
        : {}),
      ...(patch.acceptance_policy
        ? { acceptance_policy: { ...(current.acceptance_policy || {}), ...patch.acceptance_policy } }
        : {}),
    };
    const normalized = createWorkstreamRecord({
      ...current,
      ...mergedPatch,
      id: current.id,
      created_at: current.created_at,
      created_by: current.created_by,
      updated_at: new Date().toISOString(),
    });
    requireWorkstreamAccess(context, normalized);
    Object.assign(current, normalized);
    state.activities ||= [];
    state.activities.push({
      time: current.updated_at,
      type: "workstream.updated",
      workstream_id: current.id,
      title: current.title,
    });
    return { ...current };
  });
}
