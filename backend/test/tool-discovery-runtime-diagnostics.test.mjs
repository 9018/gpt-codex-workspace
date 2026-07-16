import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCatalog } from '../src/tool-discovery/tool-catalog.mjs';
import { buildToolDiscoveryDiagnostics } from '../src/tool-discovery/tool-discovery-diagnostics.mjs';

function descriptor(name, description = name) {
  return {
    description,
    inputSchema: { type: 'object', properties: {} },
    handler() {},
    metadata: {
      name,
      modes: ['minimal', 'standard'],
      audience: ['chatgpt'],
      tags: ['test'],
    },
  };
}

test('tool catalog exposes a deterministic revision and lightweight index entries', () => {
  const first = createToolCatalog({ beta: descriptor('beta'), alpha: descriptor('alpha') });
  const second = createToolCatalog({ alpha: descriptor('alpha'), beta: descriptor('beta') });
  assert.equal(first.revision, second.revision);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.index().map((entry) => entry.name), ['alpha', 'beta']);
  assert.ok(first.index().every((entry) => entry.schema_digest && entry.inputSchema === undefined));
});

test('tool discovery diagnostics report configured mode and actual listed/callable counts', () => {
  const catalog = createToolCatalog({
    health_check: descriptor('health_check'),
    runtime_status: descriptor('runtime_status'),
    open_project_context: descriptor('open_project_context'),
    tool_search: descriptor('tool_search'),
    tool_describe: descriptor('tool_describe'),
    read_text_file: descriptor('read_text_file'),
  });
  const diagnostics = buildToolDiscoveryDiagnostics({
    catalog,
    discoveryConfig: {
      enabled: true,
      mode: 'delayed',
      configured_value: 'true',
      source: 'process.env',
      valid: true,
      warning: null,
    },
    callableToolCount: 6,
    exposedToolCount: 5,
  });
  assert.deepEqual(diagnostics, {
    mode: 'delayed',
    enabled: true,
    configured_value: 'true',
    source: 'process.env',
    valid: true,
    warning: null,
    initial_tool_count: 5,
    callable_tool_count: 6,
    catalog_revision: catalog.revision,
  });
});
