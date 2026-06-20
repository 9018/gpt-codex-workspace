import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildSshExecCommand, runSshExec } from "./ssh-adapter.mjs";
import { findProject, requireProjectAccess, requireScope, requireWorkspaceAccess, selectWorkspace } from "./auth-context.mjs";

export async function createWorkspace(store, config, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  requireProjectAccess(context, args.project_id);
  if (args.type === "ssh") requireScope(context, "ssh:use");
  if (!["hosted", "ssh"].includes(args.type)) throw new Error(`unsupported workspace type: ${args.type}`);
  if (args.type === "ssh" && !args.host) throw new Error("SSH workspace requires host");

  const state = await store.load();
  findProject(state, args.project_id);
  const now = new Date().toISOString();
  const id = args.id || `workspace_${randomUUID()}`;
  if (state.workspaces.some((workspace) => workspace.id === id)) throw new Error(`workspace already exists: ${id}`);

  const workspace = {
    id,
    project_id: args.project_id,
    name: args.name,
    type: args.type,
    root: args.root || join(config.defaultWorkspaceRoot, id),
    default: Boolean(args.default),
    created_at: now,
    updated_at: now
  };

  if (args.type === "ssh") {
    workspace.host = args.host;
    workspace.user = args.user || "";
    workspace.port = args.port || 22;
    if (args.identity_file) workspace.identity_file = args.identity_file;
    if (args.socks_proxy) workspace.socks_proxy = args.socks_proxy;
  }

  state.workspaces.push(workspace);
  if (workspace.default) setDefaultWorkspace(state, workspace);
  state.activities.push({ time: now, type: "workspace.created", workspace_id: workspace.id, project_id: workspace.project_id });
  await store.save();
  return { workspace };
}

export async function updateWorkspace(store, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const workspace = state.workspaces.find((item) => item.id === args.workspace_id);
  if (!workspace) throw new Error(`workspace not found: ${args.workspace_id}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);

  for (const field of ["name", "root", "host", "user", "port", "identity_file", "socks_proxy"]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) workspace[field] = args[field];
  }
  if (Object.prototype.hasOwnProperty.call(args, "default")) {
    workspace.default = Boolean(args.default);
    if (workspace.default) setDefaultWorkspace(state, workspace);
  }
  workspace.updated_at = new Date().toISOString();
  state.activities.push({ time: workspace.updated_at, type: "workspace.updated", workspace_id: workspace.id });
  await store.save();
  return { workspace };
}

export async function deleteWorkspace(store, { workspace_id }, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspace_id);
  if (index === -1) throw new Error(`workspace not found: ${workspace_id}`);
  const [removed] = state.workspaces.splice(index, 1);
  requireProjectAccess(context, removed.project_id);
  requireWorkspaceAccess(context, removed.id);

  if (removed.default) {
    const fallback = state.workspaces.find((workspace) => workspace.project_id === removed.project_id);
    if (fallback) setDefaultWorkspace(state, fallback);
  }
  const now = new Date().toISOString();
  state.activities.push({ time: now, type: "workspace.deleted", workspace_id: removed.id });
  await store.save();
  return { ok: true, removed };
}

export async function testWorkspaceConnection(store, config, { workspace_id, dry_run = false }, context) {
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "hosted") {
    await mkdir(workspace.root, { recursive: true });
    return { ok: true, workspace_id: workspace.id, type: "hosted", root: workspace.root };
  }

  requireScope(context, "ssh:use");
  const built = buildSshExecCommand(workspace, "printf gptwork-ssh-ok", ".");
  if (dry_run) return { ok: true, dry_run: true, workspace_id: workspace.id, command: `${built.file} ${built.args.join(" ")}` };

  const result = await runSshExec(workspace, "printf gptwork-ssh-ok", ".", Math.min(config.shellTimeout, 15), config.maxShellOutputBytes);
  return { ok: result.returncode === 0 && result.stdout.includes("gptwork-ssh-ok"), workspace_id: workspace.id, result };
}

export function setDefaultWorkspace(state, workspace) {
  for (const item of state.workspaces) {
    if (item.project_id === workspace.project_id) item.default = item.id === workspace.id;
  }
  const project = state.projects.find((item) => item.id === workspace.project_id);
  if (project) {
    project.default_workspace_id = workspace.id;
    project.updated_at = new Date().toISOString();
  }
}
