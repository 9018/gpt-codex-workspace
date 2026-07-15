/**
 * schema-migrations.mjs
 *
 * Schema migrations framework for GPTWork state.
 *
 * Exports:
 *   MigrationRegistry   — register migrations with version, description, up/down
 *   runMigrations(registry, state) — apply pending migrations
 *   rollbackMigration(registry, state, version) — revert a migration
 *   backupState(state)  — create serializable snapshot
 *   restoreState(state, backup) — restore from backup
 */

// ---------------------------------------------------------------------------
// MigrationRegistry
// ---------------------------------------------------------------------------

export class MigrationRegistry {
  constructor() {
    this.migrations = [];
  }

  /**
   * Register a migration.
   *
   * @param {object} migration
   * @param {number} migration.version - unique version number
   * @param {string} migration.description - human-readable description
   * @param {Function} migration.up - (state) => state  (apply migration)
   * @param {Function} migration.down - (state) => state  (revert migration)
   */
  register(migration) {
    if (this.migrations.some(m => m.version === migration.version)) {
      throw new Error(`Migration version ${migration.version} already registered`);
    }
    this.migrations.push({
      version: migration.version,
      description: migration.description,
      up: migration.up,
      down: migration.down,
    });
    this.migrations.sort((a, b) => a.version - b.version);
  }
}

// ---------------------------------------------------------------------------
// runMigrations
// ---------------------------------------------------------------------------

/**
 * Apply pending migrations to state.
 * Migrations are tracked in state._migrations array.
 *
 * @param {MigrationRegistry} registry
 * @param {object} state
 * @returns {Promise<{applied: boolean, state: object, appliedVersions: number[]}>}
 */
export async function runMigrations(registry, state) {
  const appliedVersions = new Set(state._migrations || []);
  const newState = { ...state };
  const newlyApplied = [];

  for (const migration of registry.migrations) {
    if (appliedVersions.has(migration.version)) continue;
    newState._migrations = newState._migrations || [];
    const migrated = migration.up(newState);
    Object.assign(newState, migrated);
    newState._migrations.push(migration.version);
    newlyApplied.push(migration.version);
  }

  return {
    applied: newlyApplied.length > 0,
    state: newState,
    appliedVersions: newlyApplied,
  };
}

// ---------------------------------------------------------------------------
// rollbackMigration
// ---------------------------------------------------------------------------

/**
 * Rollback a specific migration by version.
 *
 * @param {MigrationRegistry} registry
 * @param {object} state
 * @param {number} version - version to rollback
 * @returns {Promise<{rolled_back: boolean, state: object}>}
 */
export async function rollbackMigration(registry, state, version) {
  const migration = registry.migrations.find(m => m.version === version);
  if (!migration) {
    throw new Error(`Migration version ${version} not found`);
  }

  const appliedVersions = new Set(state._migrations || []);
  if (!appliedVersions.has(version)) {
    return { rolled_back: false, state };
  }

  const newState = migration.down({ ...state });
  newState._migrations = (newState._migrations || []).filter(v => v !== version);

  return {
    rolled_back: true,
    state: newState,
  };
}

// ---------------------------------------------------------------------------
// backupState
// ---------------------------------------------------------------------------

/**
 * Create a serializable snapshot of state for backup/restore.
 *
 * @param {object} state
 * @returns {Promise<{created_at: string, state: object}>}
 */
export async function backupState(state) {
  return {
    created_at: new Date().toISOString(),
    state: JSON.parse(JSON.stringify(state)),
  };
}

// ---------------------------------------------------------------------------
// restoreState
// ---------------------------------------------------------------------------

/**
 * Restore state from a backup snapshot.
 *
 * @param {object} _current — ignored (replaced by backup)
 * @param {object} backup — backup from backupState
 * @returns {Promise<object>} restored state
 */
export async function restoreState(_current, backup) {
  if (!backup || !backup.state) {
    throw new Error('Invalid backup: missing state');
  }
  return JSON.parse(JSON.stringify(backup.state));
}
