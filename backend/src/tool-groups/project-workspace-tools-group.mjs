import { mkdir } from 'node:fs/promises';
import {
  selectWorkspace,
  requireProjectAccess,
  requireWorkspaceAccess,
  canAccessProject,
  canAccessWorkspace,
  findProject,
  limits,
} from '../auth-context.mjs';

/**
 * Factory for project/workspace MCP tool registration.
 * Handler functions (createWorkspace, updateWorkspace, deleteWorkspace,
 * testWorkspaceConnection) are passed as dependencies to avoid circular
 * imports from gptwork-server.mjs.
 */
export function createProjectWorkspaceToolsGroup({
  tool, schema, config, store,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  testWorkspaceConnection,
}) {
  return {
    list_projects: tool(
      'List your available projects. Each project has workspaces (hosted or SSH) and tasks. Start here to find which project to work on.',
      schema({}),
      async (_args, context) => {
        const state = await store.load();
        const projects = state.projects
          .filter((project) => canAccessProject(context, project.id))
          .map((project) => ({
            ...project,
            name: project.name || project.id || '未命名项目',
          }));
        return { projects };
      },
    ),
    get_project: tool(
      'Return project detail.',
      schema({ project_id: 'string' }, ['project_id']),
      async ({ project_id = 'default' }, context) => {
        const state = await store.load();
        requireProjectAccess(context, project_id);
        const project = findProject(state, project_id);
        if (project) {
          project.name = project.name || project.id || '未命名项目';
        }
        return { project };
      },
    ),
    list_workspaces: tool(
      'List project workspaces.',
      schema({ project_id: 'string' }),
      async ({ project_id = 'default' }, context) => {
        const state = await store.load();
        requireProjectAccess(context, project_id);
        const workspaces = state.workspaces
          .filter((workspace) => workspace.project_id === project_id && canAccessWorkspace(context, workspace.id))
          .map((workspace) => ({
            ...workspace,
            name: workspace.name
              || (workspace.type === 'ssh' && workspace.host ? `${workspace.host}远程工作区` : null)
              || workspace.id
              || '未命名工作区',
          }));
        return {
          project_id,
          workspaces,
        };
      },
    ),
    get_workspace_info: tool(
      'Return workspace configuration and capacity summary.',
      schema({ workspace_id: 'string' }),
      async (args, context) => {
        const workspace = await selectWorkspace(store, args.workspace_id, context);
        if (workspace.type === 'hosted') await mkdir(workspace.root, { recursive: true });
        if (workspace) {
          workspace.name = workspace.name
            || (workspace.type === 'ssh' && workspace.host ? `${workspace.host}远程工作区` : null)
            || workspace.id
            || '未命名工作区';
        }
        return { workspace, limits: limits(config) };
      },
    ),
    set_active_workspace: tool(
      'Return the selected workspace for caller-side state.',
      schema({ workspace_id: 'string' }, ['workspace_id']),
      async ({ workspace_id }, context) => {
        const active = await selectWorkspace(store, workspace_id, context);
        if (active) {
          active.name = active.name
            || (active.type === 'ssh' && active.host ? `${active.host}远程工作区` : null)
            || active.id
            || '未命名工作区';
        }
        return { active_workspace: active };
      },
    ),
    create_workspace: tool(
      'Create a hosted or SSH workspace for a project. SSH workspaces use key authentication first; pass identity_file to pin a key. Hosts outside 10.0.0.0/8 use the default SOCKS proxy 10.0.1.105:20177 unless socks_proxy is provided.',
      schema({
        project_id: 'string', id: 'string', name: 'string', type: 'string',
        root: 'string', host: 'string', user: 'string', port: 'integer',
        identity_file: 'string', socks_proxy: 'string', default: 'boolean',
      }, ['project_id', 'name', 'type', 'root']),
      async (args, context) => createWorkspace(store, config, args, context),
    ),
    update_workspace: tool(
      'Update workspace metadata or SSH connection settings, including identity_file and socks_proxy.',
      schema({
        workspace_id: 'string', name: 'string', root: 'string', host: 'string',
        user: 'string', port: 'integer', identity_file: 'string', socks_proxy: 'string', default: 'boolean',
      }, ['workspace_id']),
      async (args, context) => updateWorkspace(store, args, context),
    ),
    delete_workspace: tool(
      '移除工作区注册信息。不影响远程文件。',
      schema({ workspace_id: 'string' }, ['workspace_id']),
      async (args, context) => deleteWorkspace(store, args, context),
    ),
    test_workspace_connection: tool(
      'Test hosted or SSH workspace connectivity.',
      schema({ workspace_id: 'string', dry_run: 'boolean' }, ['workspace_id']),
      async (args, context) => testWorkspaceConnection(store, config, args, context),
    ),
  };
}
