import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleListPendingRestarts, handleScheduleServiceRestart } from '../src/restart-tools.mjs';

test('handleListPendingRestarts returns count and markers for an empty workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-restart-tools-'));
  const result = await handleListPendingRestarts({}, { config: { defaultWorkspaceRoot: root } });
  assert.equal(result.count, 0);
  assert.deepEqual(result.markers, []);
});

test('handleScheduleServiceRestart rejects invalid workspace root', async () => {
  const result = await handleScheduleServiceRestart(
    { task_id: 'task_test' },
    { config: { defaultWorkspaceRoot: null, defaultRepoPath: null }, store: null },
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});
