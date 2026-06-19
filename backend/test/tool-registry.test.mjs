import test from 'node:test';
import assert from 'node:assert/strict';
import { createTool } from '../src/tool-registry.mjs';

test('createTool preserves public tool descriptor shape and references', async () => {
  const inputSchema = { type: 'object', properties: { task_id: 'string' }, required: ['task_id'] };
  const handler = async () => ({ ok: true });
  const tool = createTool('Example tool', inputSchema, handler);

  assert.deepEqual(Object.keys(tool), ['description', 'inputSchema', 'handler']);
  assert.equal(tool.description, 'Example tool');
  assert.equal(tool.inputSchema, inputSchema);
  assert.equal(tool.handler, handler);
  assert.deepEqual(await tool.handler(), { ok: true });
});
