import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectWorkspaceToolsGroup } from '../src/tool-groups/project-workspace-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('project workspace tool group exposes stable public tool names and schemas', () => {
  const tools = createProjectWorkspaceToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork' },
    store: {},
    createWorkspace: async () => ({ workspace: {} }),
    updateWorkspace: async () => ({ workspace: {} }),
    deleteWorkspace: async () => ({ ok: true }),
    testWorkspaceConnection: async () => ({ ok: true }),
  });

  const expectedNames = [
    'list_projects',
    'get_project',
    'list_workspaces',
    'get_workspace_info',
    'set_active_workspace',
    'create_workspace',
    'update_workspace',
    'delete_workspace',
    'test_workspace_connection',
  ];

  assert.deepEqual(Object.keys(tools).sort(), expectedNames.sort());

  // Verify required params for key tools
  assert.deepEqual(tools.get_project.inputSchema.required, ['project_id']);
  assert.deepEqual(tools.set_active_workspace.inputSchema.required, ['workspace_id']);
  assert.deepEqual(tools.create_workspace.inputSchema.required, ['project_id', 'name', 'type', 'root']);
  assert.deepEqual(tools.update_workspace.inputSchema.required, ['workspace_id']);
  assert.deepEqual(tools.delete_workspace.inputSchema.required, ['workspace_id']);
  assert.deepEqual(tools.test_workspace_connection.inputSchema.required, ['workspace_id']);

  // Basic descriptions check
  assert.equal(typeof tools.list_projects.description, 'string');
  assert.equal(typeof tools.create_workspace.description, 'string');
  assert.deepEqual(tools.list_projects.inputSchema.properties, {});
});
