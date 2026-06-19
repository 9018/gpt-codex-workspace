import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalToolsGroup } from '../src/tool-groups/goal-tools-group.mjs';

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('goal tool group exposes stable public tool names and schemas', () => {
  const tools = createGoalToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createGoal: async () => {},
    createEncodedGoal: async () => {},
    listGoals: async () => {},
    getGoalContext: async () => {},
    appendGoalMessage: async () => {},
  });

  assert.deepEqual(Object.keys(tools), [
    'create_goal',
    'create_encoded_goal',
    'list_goals',
    'get_goal_context',
    'append_goal_message',
  ]);

  // create_goal: required params
  assert.deepEqual(tools.create_goal.inputSchema.required, ['user_request', 'goal_prompt']);
  assert.equal(tools.create_goal.inputSchema.properties.user_request, 'string');
  assert.equal(tools.create_goal.inputSchema.properties.goal_prompt, 'string');
  assert.equal(tools.create_goal.inputSchema.properties.assign_to_codex, 'boolean');
  assert.equal(tools.create_goal.inputSchema.properties.messages, 'array');
  assert.equal(tools.create_goal.inputSchema.properties.memories, 'array');
  assert.equal(tools.create_goal.inputSchema.properties.payload, 'object');

  // create_encoded_goal: required params
  assert.deepEqual(tools.create_encoded_goal.inputSchema.required, ['preview_text', 'payload_base64']);
  assert.equal(tools.create_encoded_goal.inputSchema.properties.preview_text, 'string');
  assert.equal(tools.create_encoded_goal.inputSchema.properties.payload_base64, 'string');
  assert.equal(tools.create_encoded_goal.inputSchema.properties.wait_ms, 'integer');
  assert.equal(tools.create_encoded_goal.inputSchema.properties.assign_to_codex, 'boolean');

  // list_goals: all optional
  assert.deepEqual(tools.list_goals.inputSchema.required, []);
  assert.equal(tools.list_goals.inputSchema.properties.status, 'string');
  assert.equal(tools.list_goals.inputSchema.properties.assignee, 'string');
  assert.equal(tools.list_goals.inputSchema.properties.limit, 'integer');

  // get_goal_context: required is empty (uses []), both goal_id and task_id optional
  assert.deepEqual(tools.get_goal_context.inputSchema.required, []);
  assert.equal(tools.get_goal_context.inputSchema.properties.goal_id, 'string');
  assert.equal(tools.get_goal_context.inputSchema.properties.task_id, 'string');

  // append_goal_message: required = ['content']
  assert.deepEqual(tools.append_goal_message.inputSchema.required, ['content']);
  assert.equal(tools.append_goal_message.inputSchema.properties.goal_id, 'string');
  assert.equal(tools.append_goal_message.inputSchema.properties.task_id, 'string');
  assert.equal(tools.append_goal_message.inputSchema.properties.role, 'string');
  assert.equal(tools.append_goal_message.inputSchema.properties.content, 'string');
  assert.equal(tools.append_goal_message.inputSchema.properties.memory_key, 'string');
  assert.equal(tools.append_goal_message.inputSchema.properties.memory_value, 'string');
});

test('goal tool group handlers forward args and context to registered functions', async () => {
  const handlerCalls = [];

  const tools = createGoalToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { test: true },
    store: { test: true },
    createGoal: async (store, config, args, context) => {
      handlerCalls.push(['createGoal', { store, config, args, context }]);
      return { goal: { id: 'g1' } };
    },
    createEncodedGoal: async (store, config, args, context) => {
      handlerCalls.push(['createEncodedGoal', { store, config, args, context }]);
      return { goal: { id: 'g2' } };
    },
    listGoals: async (store, args, context) => {
      handlerCalls.push(['listGoals', { store, args, context }]);
      return { goals: [] };
    },
    getGoalContext: async (store, config, args, context) => {
      handlerCalls.push(['getGoalContext', { store, config, args, context }]);
      return { goal: { id: 'g3' } };
    },
    appendGoalMessage: async (store, config, args, context) => {
      handlerCalls.push(['appendGoalMessage', { store, config, args, context }]);
      return { ok: true };
    },
  });

  const context = { user_id: 'test-user' };

  // create_goal
  const goalResult = await tools.create_goal.handler({ user_request: 'req', goal_prompt: 'prompt', assign_to_codex: true }, context);
  assert.deepEqual(goalResult, { goal: { id: 'g1' } });

  // create_encoded_goal
  const encodedResult = await tools.create_encoded_goal.handler({ preview_text: 'preview', payload_base64: 'base64==' }, context);
  assert.deepEqual(encodedResult, { goal: { id: 'g2' } });

  // list_goals
  const listResult = await tools.list_goals.handler({ status: 'assigned' }, context);
  assert.deepEqual(listResult, { goals: [] });

  // get_goal_context
  const contextResult = await tools.get_goal_context.handler({ goal_id: 'g_1' }, context);
  assert.deepEqual(contextResult, { goal: { id: 'g3' } });

  // append_goal_message
  const appendResult = await tools.append_goal_message.handler({ goal_id: 'g_1', content: 'hello' }, context);
  assert.deepEqual(appendResult, { ok: true });

  // Verify the actual handler calls
  assert.equal(handlerCalls.length, 5);
  assert.equal(handlerCalls[0][0], 'createGoal');
  assert.equal(handlerCalls[1][0], 'createEncodedGoal');
  assert.equal(handlerCalls[2][0], 'listGoals');
  assert.equal(handlerCalls[3][0], 'getGoalContext');
  assert.equal(handlerCalls[4][0], 'appendGoalMessage');
});
