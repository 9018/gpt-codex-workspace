import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallableTools, createDiscoverableTools } from '../src/server-tools.mjs';

const tool=(modes=['standard'])=>({description:'x',inputSchema:{type:'object'},handler:()=>null,metadata:{modes}});

test('delayed discovery exposes only bootstrap descriptors while callable tools remain mode-authorized', () => {
  const tools={health_check:tool(),tool_search:tool(),tool_describe:tool(),read_text_file:tool(),admin_only:tool(['operator'])};
  const listed=createDiscoverableTools(tools,'standard',{delayed:true});
  assert.deepEqual(Object.keys(listed).sort(),['health_check','tool_describe','tool_search']);
  const callable=createCallableTools(tools,'standard');
  assert.ok(callable.read_text_file);
  assert.equal(callable.admin_only,undefined);
});

test('default discovery remains backward compatible', () => {
  const tools={health_check:tool(),read_text_file:tool()};
  assert.deepEqual(Object.keys(createDiscoverableTools(tools,'standard')).sort(),['health_check','read_text_file']);
});
