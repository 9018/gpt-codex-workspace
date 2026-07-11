import {
  canAccessProject,
  canAccessWorkspace,
  defaultTokenContext,
  requireProjectAccess,
  requireScope,
  requireWorkspaceAccess,
} from "../auth-context.mjs";
import {
  createWorkstreamContextLinkRecord,
  normalizeWorkstreamContextLink,
  normalizeWorkstreamRecord,
} from "./workstream-model.mjs";
import {
  ensureWorkstreamState,
  findWorkstreamInState,
  workstreamLinksFromState,
} from "./workstream-store.mjs";

function requireWorkstreamAccess(context, workstream) {
  requireProjectAccess(context, workstream.project_id);
  requireWorkspaceAccess(context, workstream.workspace_id);
}

function sameLink(left, right) {
  return left.workstream_id === right.workstream_id
    && left.kind === right.kind
    && left.external_id === right.external_id
    && (left.goal_id || null) === (right.goal_id || null)
    && (left.task_id || null) === (right.task_id || null);
}

export async function linkWorkstreamContext(store, input = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  const candidate = createWorkstreamContextLinkRecord(input);

  return store.mutate((state) => {
    ensureWorkstreamState(state);
    const workstream = findWorkstreamInState(state, candidate.workstream_id);
    if (!workstream) throw new Error(`workstream not found: ${candidate.workstream_id}`);
    requireWorkstreamAccess(context, workstream);

    const existing = state.context_links.find((item) => sameLink(item, candidate));
    if (existing) {
      existing.relation = candidate.relation;
      existing.metadata = { ...(existing.metadata || {}), ...candidate.metadata };
      existing.last_seen_at = candidate.last_seen_at;
      return normalizeWorkstreamContextLink(existing);
    }

    state.context_links.push(candidate);
    state.activities ||= [];
    state.activities.push({
      time: candidate.first_seen_at,
      type: "workstream.context_linked",
      workstream_id: candidate.workstream_id,
      context_kind: candidate.kind,
      external_id: candidate.external_id,
    });
    return { ...candidate };
  });
}

export async function listWorkstreamLinks(store, filters = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  const accessibleIds = new Set((state.workstreams || [])
    .filter((item) => canAccessProject(context, item.project_id) && canAccessWorkspace(context, item.workspace_id))
    .map((item) => item.id));
  let links = workstreamLinksFromState(state).filter((item) => accessibleIds.has(item.workstream_id));
  for (const field of ["workstream_id", "kind", "external_id", "relation", "goal_id", "task_id"]) {
    if (filters[field]) links = links.filter((item) => item[field] === filters[field]);
  }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
  return links
    .slice()
    .sort((a, b) => String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")))
    .slice(0, limit)
    .map(normalizeWorkstreamContextLink);
}

export async function resolveWorkstreamsByContext(store, kind, externalId, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  const links = workstreamLinksFromState(state)
    .filter((item) => item.kind === kind && item.external_id === externalId);
  const workstreams = [];
  const visibleLinks = [];
  const seen = new Set();
  for (const link of links) {
    const workstream = findWorkstreamInState(state, link.workstream_id);
    if (!workstream) continue;
    if (!canAccessProject(context, workstream.project_id) || !canAccessWorkspace(context, workstream.workspace_id)) continue;
    visibleLinks.push(normalizeWorkstreamContextLink(link));
    if (!seen.has(workstream.id)) {
      seen.add(workstream.id);
      workstreams.push(normalizeWorkstreamRecord(workstream));
    }
  }
  return { kind, external_id: externalId, links: visibleLinks, workstreams };
}
