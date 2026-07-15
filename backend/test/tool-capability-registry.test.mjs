import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCapabilityRegistry } from '../src/ephemeral-execution/tool-capability-registry.mjs';

test('tool-capability-registry: UNKNOWN defaults include all fields', () => {
  const registry = createToolCapabilityRegistry();
  const meta = registry.get('nonexistent_tool');
  assert.equal(meta.side_effect, 'unknown');
  assert.equal(meta.idempotency, 'unknown');
  assert.equal(meta.execution_class, 'durable_only');
  // authority, parallel_safe, requires_lock are null by default in UNKNOWN
  assert.equal(meta.authority, null);
  assert.equal(meta.parallel_safe, null);
  assert.equal(meta.requires_lock, null);
});

test('tool-capability-registry: register adds known capabilities', () => {
  const registry = createToolCapabilityRegistry();
  registry.register('test_tool', {
    side_effect: 'none',
    idempotency: 'idempotent',
    execution_class: 'ephemeral_eligible',
    authority: 'task',
    parallel_safe: true,
    requires_lock: false,
  });
  const meta = registry.get('test_tool');
  assert.equal(meta.side_effect, 'none');
  assert.equal(meta.idempotency, 'idempotent');
  assert.equal(meta.execution_class, 'ephemeral_eligible');
  assert.equal(meta.authority, 'task');
  assert.equal(meta.parallel_safe, true);
  assert.equal(meta.requires_lock, false);
});

test('tool-capability-registry: registerFromDescriptors imports normalized descriptors', () => {
  const registry = createToolCapabilityRegistry();
  const descriptors = [
    {
      name: 'handler_tool',
      metadata: {
        side_effect: 'mutates',
        idempotency: 'not_idempotent',
        execution_class: 'durable_only',
        authority: 'system',
        parallel_safe: false,
        requires_lock: true,
      },
    },
    {
      name: 'query_tool',
      metadata: {
        side_effect: 'none',
        idempotency: 'idempotent',
        execution_class: 'ephemeral_eligible',
        authority: 'task',
        parallel_safe: true,
        requires_lock: false,
      },
    },
    {
      name: 'minimal_tool',
      // No metadata - should fall back to defaults
    },
  ];

  registry.registerFromDescriptors(descriptors);

  const handler = registry.get('handler_tool');
  assert.equal(handler.side_effect, 'mutates');
  assert.equal(handler.requires_lock, true);

  const query = registry.get('query_tool');
  assert.equal(query.execution_class, 'ephemeral_eligible');
  assert.equal(query.parallel_safe, true);

  // Minimal tool from descriptor gets defaults
  const minimal = registry.get('minimal_tool');
  assert.equal(minimal.side_effect, 'unknown');
  assert.equal(minimal.execution_class, 'durable_only');
});

test('tool-capability-registry: registerFromDescriptors overwrites existing entries', () => {
  const registry = createToolCapabilityRegistry();
  registry.register('overwrite_me', {
    side_effect: 'none',
    idempotency: 'idempotent',
  });
  assert.equal(registry.get('overwrite_me').side_effect, 'none');

  registry.registerFromDescriptors([{
    name: 'overwrite_me',
    metadata: { side_effect: 'mutates', idempotency: 'not_idempotent' },
  }]);
  assert.equal(registry.get('overwrite_me').side_effect, 'mutates');
  assert.equal(registry.get('overwrite_me').idempotency, 'not_idempotent');
});

test('tool-capability-registry: classify returns execution_class', () => {
  const registry = createToolCapabilityRegistry();
  registry.register('my_tool', { execution_class: 'ephemeral_eligible' });
  assert.equal(registry.classify('my_tool'), 'ephemeral_eligible');
  assert.equal(registry.classify('unknown'), 'durable_only');
});

test('tool-capability-registry: revision increments on each registration', () => {
  const registry = createToolCapabilityRegistry();
  const r1 = registry.revision;
  registry.register('a', { side_effect: 'none' });
  const r2 = registry.revision;
  registry.register('b', { side_effect: 'none' });
  const r3 = registry.revision;
  assert.ok(r2 > r1);
  assert.ok(r3 > r2);
});

test('tool-capability-registry: registerFromDescriptors also increments revision', () => {
  const registry = createToolCapabilityRegistry();
  const r1 = registry.revision;
  registry.registerFromDescriptors([{ name: 'a', metadata: { side_effect: 'none' } }]);
  assert.ok(registry.revision > r1);
});

test('tool-capability-registry: READ_ONLY tools get ephemeral_eligible by default', () => {
  const registry = createToolCapabilityRegistry();
  for (const name of ['health_check', 'runtime_status', 'worker_status']) {
    const meta = registry.get(name);
    assert.equal(meta.side_effect, 'none');
    assert.equal(meta.idempotency, 'idempotent');
    assert.equal(meta.execution_class, 'ephemeral_eligible');
  }
});

test('tool-capability-registry: descriptor registration preserves READ_ONLY defaults when descriptor has no metadata', () => {
  const registry = createToolCapabilityRegistry();
  // registerFromDescriptors with descriptors that have only name (no metadata)
  // should not overwrite existing READ_ONLY entries
  registry.registerFromDescriptors([
    { name: 'health_check' },
    { name: 'runtime_status' },
  ]);
  for (const name of ['health_check', 'runtime_status']) {
    const meta = registry.get(name);
    assert.equal(meta.side_effect, 'none');
    assert.equal(meta.execution_class, 'ephemeral_eligible');
  }
});
