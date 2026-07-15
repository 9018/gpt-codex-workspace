import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Effective Runtime Manifest', () => {
  let getEffectiveManifest;

  before(async () => {
    // Save original env
    const mod = await import('../src/effective-manifest.mjs');
    getEffectiveManifest = mod.getEffectiveManifest;
  });

  it('returns all expected top-level keys', () => {
    const manifest = getEffectiveManifest();
    const expectedKeys = [
      'version', 'toolMode', 'host', 'port',
      'workspaceRoot', 'statePath', 'envSource',
      'agentBackends', 'system',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in manifest, `Expected key "${key}" in manifest`);
    }
  });

  it('reports the tool mode from config', () => {
    const manifest = getEffectiveManifest();
    assert.ok(typeof manifest.toolMode === 'string');
    assert.ok(manifest.toolMode.length > 0);
  });

  it('reports agent backends as an object', () => {
    const manifest = getEffectiveManifest();
    assert.ok(typeof manifest.agentBackends === 'object');
    assert.ok(!Array.isArray(manifest.agentBackends));
  });

  it('reports system info', () => {
    const manifest = getEffectiveManifest();
    assert.ok(manifest.system);
    assert.ok(typeof manifest.system.nodeVersion === 'string');
    assert.ok(typeof manifest.system.platform === 'string');
    assert.ok(typeof manifest.system.cwd === 'string');
  });

  it('manifest is serializable (JSON roundtrips)', () => {
    const manifest = getEffectiveManifest();
    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, manifest);
  });

  it('reports envSource correctly', () => {
    const manifest = getEffectiveManifest();
    assert.ok(manifest.envSource);
    assert.ok(['process.env', 'runtime.env', 'default'].includes(manifest.envSource) ||
              typeof manifest.envSource === 'object');
  });
});
