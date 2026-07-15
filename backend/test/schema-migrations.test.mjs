import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Schema Migrations Framework', () => {
  let MigrationRegistry, runMigrations, rollbackMigration, backupState, restoreState;

  before(async () => {
    const mod = await import('../src/schema-migrations.mjs');
    MigrationRegistry = mod.MigrationRegistry;
    runMigrations = mod.runMigrations;
    rollbackMigration = mod.rollbackMigration;
    backupState = mod.backupState;
    restoreState = mod.restoreState;
  });

  it('MigrationRegistry allows registering migrations', () => {
    const registry = new MigrationRegistry();
    registry.register({
      version: 1,
      description: 'Add task status index',
      up: (state) => ({ ...state, _indexed: true }),
      down: (state) => ({ ...state, _indexed: false }),
    });
    assert.equal(registry.migrations.length, 1);
    assert.equal(registry.migrations[0].version, 1);
  });

  it('runMigrations applies pending migrations', async () => {
    const registry = new MigrationRegistry();
    registry.register({
      version: 1,
      description: 'Add version field',
      up: (state) => ({ ...state, version: 1 }),
      down: (state) => { const { version, ...rest } = state; return rest; },
    });

    let state = { tasks: [] };
    const result = await runMigrations(registry, state);
    assert.ok(result.applied);
    assert.equal(result.state.version, 1);
    assert.deepEqual(result.state.tasks, []);
  });

  it('runMigrations is idempotent', async () => {
    const registry = new MigrationRegistry();
    registry.register({
      version: 1,
      description: 'Add meta field',
      up: (state) => ({ ...state, meta: {} }),
      down: (state) => { const { meta, ...rest } = state; return rest; },
    });

    let state = { tasks: [] };
    const r1 = await runMigrations(registry, state);
    assert.ok(r1.applied);
    const r2 = await runMigrations(registry, r1.state);
    assert.equal(r2.applied, false); // Already applied
    assert.equal(r2.state.meta !== undefined, true);
  });

  it('rollbackMigration reverts a migration', async () => {
    const registry = new MigrationRegistry();
    registry.register({
      version: 1,
      description: 'Add version field',
      up: (state) => ({ ...state, version: 1 }),
      down: (state) => { const { version, ...rest } = state; return rest; },
    });

    let state = { tasks: [] };
    const applied = await runMigrations(registry, state);
    assert.equal(applied.state.version, 1);

    const rolled = await rollbackMigration(registry, applied.state, 1);
    assert.ok(rolled.rolled_back);
    assert.equal(rolled.state.version, undefined);
  });

  it('backupState creates a serializable snapshot', async () => {
    const state = { tasks: [{ id: 1 }], goals: [{ id: 'g1' }] };
    const backup = await backupState(state);
    assert.ok(backup);
    assert.ok(backup.created_at);
    assert.deepEqual(backup.state, state);
    assert.ok(JSON.stringify(backup));
  });

  it('restoreState recovers from backup', async () => {
    const original = { tasks: [{ id: 1 }] };
    const backup = await backupState(original);

    const corrupted = { tasks: [], goals: [] };
    const restored = await restoreState(corrupted, backup);
    assert.deepEqual(restored, original);
  });
});
