import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCompletionToolsGroup } from '../src/tool-groups/task-completion-tools-group.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('task completion tool group exposes stable public tool names and schemas', () => {
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    github: { syncTask: async () => {} },
  });

  assert.deepEqual(Object.keys(tools), [
    'complete_task',
    'request_human_review',
  ]);

  // complete_task: required = ['task_id'], optional = ['summary', 'admin_override']
  assert.deepEqual(tools.complete_task.inputSchema.required, ['task_id']);
  assert.equal(tools.complete_task.inputSchema.properties.task_id, 'string');
  assert.equal(tools.complete_task.inputSchema.properties.summary, 'string');
  assert.equal(tools.complete_task.inputSchema.properties.admin_override, 'boolean');

  // request_human_review: required = ['task_id'], optional = ['message']
  assert.deepEqual(tools.request_human_review.inputSchema.required, ['task_id']);
  assert.equal(tools.request_human_review.inputSchema.properties.task_id, 'string');
  assert.equal(tools.request_human_review.inputSchema.properties.message, 'string');
});

test('complete_task handler description matches expected text', () => {
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    github: { syncTask: async () => {} },
  });

  assert.match(tools.complete_task.description, /Mark a task completed/);
  assert.match(tools.request_human_review.description, /Mark a task as waiting for human review/);
});
