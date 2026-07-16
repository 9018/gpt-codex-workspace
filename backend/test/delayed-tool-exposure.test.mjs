import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallableTools, createDiscoverableTools, listExposedTools } from '../src/server-tools.mjs';
import { resolveToolDiscoveryConfig } from '../src/tool-discovery/tool-discovery-config.mjs';

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

test('delayed discovery config accepts explicit strict boolean values and reports source', () => {
  assert.deepEqual(resolveToolDiscoveryConfig({ env: { GPTWORK_DELAYED_TOOL_DISCOVERY: 'true' } }), {
    enabled: true,
    mode: 'delayed',
    configured_value: 'true',
    source: 'process.env',
    valid: true,
    warning: null,
  });
  const invalid = resolveToolDiscoveryConfig({ env: { GPTWORK_DELAYED_TOOL_DISCOVERY: 'yes' } });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.valid, false);
  assert.match(invalid.warning, /true or false/);
});

test('listExposedTools is the single delayed tools/list policy and exposes exactly five bootstrap tools', () => {
  const tools = {
    health_check: tool(['minimal']),
    runtime_status: tool(['minimal']),
    open_project_context: tool(['minimal']),
    tool_search: tool(['minimal']),
    tool_describe: tool(['minimal']),
    read_text_file: tool(['minimal']),
  };
  const listed = listExposedTools({
    tools,
    mode: 'minimal',
    discoveryConfig: { enabled: true },
  });
  assert.deepEqual(Object.keys(listed), [
    'health_check',
    'runtime_status',
    'open_project_context',
    'tool_search',
    'tool_describe',
  ]);
});
