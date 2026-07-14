import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionIntent } from '../../src/ephemeral-execution/execution-intent.mjs';
import { createToolCapabilityRegistry } from '../../src/ephemeral-execution/tool-capability-registry.mjs';
import { classifyExecutionIntent } from '../../src/ephemeral-execution/ephemeral-classifier.mjs';
import { runEphemeralBatch } from '../../src/ephemeral-execution/ephemeral-batch-runner.mjs';

test('execution intent rejects duplicate call ids and unknown dependencies', () => {
  assert.throws(() => createExecutionIntent({ calls: [{ call_id:'a',tool_name:'x' },{ call_id:'a',tool_name:'y' }] }), /duplicate_call_id/);
  assert.throws(() => createExecutionIntent({ calls: [{ call_id:'a',tool_name:'x',depends_on:['missing'] }] }), /unknown_dependency/);
});

test('classifier defaults unknown and write-capable tools to durable', () => {
  const registry = createToolCapabilityRegistry();
  const unknown = createExecutionIntent({ calls:[{call_id:'a',tool_name:'unknown'}] });
  assert.equal(classifyExecutionIntent(unknown, registry, {enabled:true}).selected_mode, 'durable');
  registry.register('writer', { side_effect:'workspace_write', execution_class:'durable_only' });
  const writer = createExecutionIntent({ calls:[{call_id:'a',tool_name:'writer'}] });
  assert.equal(classifyExecutionIntent(writer, registry, {enabled:true}).selected_mode, 'durable');
});

test('batch runner respects dependencies and returns stable partial results', async () => {
  const active = { value:0, max:0 };
  const result = await runEphemeralBatch({
    batch: createExecutionIntent({ max_concurrency:2, calls:[
      {call_id:'a',tool_name:'ok'},
      {call_id:'b',tool_name:'fail'},
      {call_id:'c',tool_name:'ok',depends_on:['b']},
    ]}),
    maxConcurrency:2,
    invokeTool: async (name) => {
      active.value++; active.max=Math.max(active.max,active.value);
      await new Promise(r=>setTimeout(r,5)); active.value--;
      if (name === 'fail') throw new Error('boom');
      return { name };
    }
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map(r=>r.call_id), ['a','b','c']);
  assert.equal(result.results[2].status, 'skipped_dependency_failed');
  assert.ok(active.max <= 2);
});
