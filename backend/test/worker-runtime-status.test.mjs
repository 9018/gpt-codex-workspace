import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistWorkerRuntimeStatus, readWorkerRuntimeStatus, resolveEffectiveWorkerState } from '../src/worker-runtime-status.mjs';

test('durable worker runtime status overrides stale process-local state', () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-worker-status-'));
  try {
    const durable = { enabled: true, running: false, started_at: '2026-07-15T08:00:00Z', last_tick_started_at: '2026-07-15T08:01:00Z', last_tick_finished_at: '2026-07-15T08:01:01Z', interval_ms: 5000 };
    assert.equal(persistWorkerRuntimeStatus(durable, { workspaceRoot: root, pid: 123 }).ok, true);
    assert.equal(readWorkerRuntimeStatus(root).pid, 123);
    const effective = resolveEffectiveWorkerState({ enabled: true, running: false, started_at: null }, root);
    assert.equal(effective.source, 'durable_runtime');
    assert.equal(effective.last_tick_finished_at, durable.last_tick_finished_at);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
