import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestartToolsGroup } from '../src/tool-groups/restart-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('restart tool group exposes stable public tool names and schemas', () => {
  const tools = createRestartToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork', defaultRepoPath: '/tmp/gptwork/repo' },
    store: {},
  });

  assert.deepEqual(Object.keys(tools), ['schedule_service_restart', 'list_pending_restarts']);
  assert.deepEqual(tools.schedule_service_restart.inputSchema.required, ['task_id']);
  assert.equal(tools.schedule_service_restart.inputSchema.properties.task_id, 'string');
  assert.equal(tools.schedule_service_restart.inputSchema.properties.expected_commit, 'string');
  assert.equal(tools.schedule_service_restart.inputSchema.properties.expected_remote_head, 'string');
  assert.deepEqual(tools.list_pending_restarts.inputSchema.required, []);
});
