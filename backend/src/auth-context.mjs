/**
 * auth-context.mjs — Token parsing, auth context normalization, access control
 *
 * Provides token parsing, token context normalization, default scopes,
 * MCP path token extraction, authorization assertion, and project/workspace
 * access checks used by gptwork-server.
 *
 * Designed to be stateless — all store/config references are injected.
 */

// ---------------------------------------------------------------------------
// Token / path extraction
// ---------------------------------------------------------------------------

export function headersWithPathToken(req) {
  if (req.headers.authorization) return req.headers;
  const token = tokenFromMcpPath(req.url || "");
  if (!token) return req.headers;
  return { ...req.headers, authorization: `Bearer ${token}` };
}

export function tokenFromMcpPath(url) {
  const path = url.split("?", 1)[0];
  const match = path.match(/^\/mcp\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Token parsing and context normalization
// ---------------------------------------------------------------------------

export function parseTokens(value) {
  return String(value).split(",").map((token) => token.trim()).filter(Boolean);
}

export function parseTokenContexts(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeTokenContexts(contexts, tokens) {
  const normalized = {};
  for (const token of tokens) normalized[token] = defaultTokenContext(token);
  for (const [token, context] of Object.entries(contexts || {})) {
    normalized[token] = {
      ...defaultTokenContext(token),
      ...context,
      user_name: context.user_name || context.name || defaultTokenContext(token).user_name,
      project_ids: normalizeList(context.project_ids, ["*"]),
      workspace_ids: normalizeList(context.workspace_ids, ["*"]),
      scopes: normalizeList(context.scopes, defaultScopes())
    };
  }
  return normalized;
}

export function defaultTokenContext(token) {
  return {
    token_label: token === "anonymous" ? "anonymous" : `token:${String(token).slice(0, 6)}`,
    user_id: "user_default",
    user_name: "Default User",
    team_id: "team_default",
    project_ids: ["*"],
    workspace_ids: ["*"],
    scopes: defaultScopes()
  };
}

export function defaultScopes() {
  return ["project:read", "project:admin", "task:create", "task:read", "task:update", "task:assign_codex", "workspace:read", "workspace:write", "files:upload", "files:download", "shell:exec", "ssh:use", "browser:use", "audit:read"];
}

export function normalizeList(value, fallback) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

// ---------------------------------------------------------------------------
// Runtime limits derived from config
// ---------------------------------------------------------------------------

export function limits(config) {
  return {
    max_read_bytes: config.maxReadBytes,
    max_shell_output_bytes: config.maxShellOutputBytes,
    shell_timeout: config.shellTimeout,
    codex_exec_timeout: config.codexExecTimeout
  };
}

// ---------------------------------------------------------------------------
// Authorization assertion
// ---------------------------------------------------------------------------

export function assertAuthorized(headers, config) {
  if (!config.requireAuth) return defaultTokenContext("anonymous");
  const auth = headers.authorization || headers.Authorization || "";
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  if (!token || !config.tokenContexts[token]) {
    const error = new Error("Missing or invalid bearer token");
    error.code = -32001;
    throw error;
  }
  return config.tokenContexts[token];
}

// ---------------------------------------------------------------------------
// Workspace / project selection and access checks
// ---------------------------------------------------------------------------

export async function selectWorkspace(store, workspace_id, context = defaultTokenContext("system")) {
  const state = await store.load();
  const workspace = workspace_id
    ? state.workspaces.find((item) => item.id === workspace_id)
    : state.workspaces.find((item) => item.default) || state.workspaces[0];
  if (!workspace) throw new Error(`workspace not found: ${workspace_id || "default"}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);
  return workspace;
}

export function findProject(state, project_id) {
  const project = state.projects.find((item) => item.id === project_id);
  if (!project) throw new Error(`project not found: ${project_id}`);
  return project;
}

export function canAccessProject(context, projectId) {
  return context.project_ids.includes("*") || context.project_ids.includes(projectId);
}

export function canAccessWorkspace(context, workspaceId) {
  return context.workspace_ids.includes("*") || context.workspace_ids.includes(workspaceId);
}

export function requireProjectAccess(context, projectId) {
  if (!canAccessProject(context, projectId)) throw new Error(`project access denied: ${projectId}`);
}

export function requireWorkspaceAccess(context, workspaceId) {
  if (!canAccessWorkspace(context, workspaceId)) throw new Error(`workspace access denied: ${workspaceId}`);
}

export function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) throw new Error(`missing required scope: ${scope}`);
}
