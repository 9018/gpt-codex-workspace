import assert from 'node:assert/strict';
import { it } from 'node:test';
import { launchTaskInBackground, getActiveBackgroundTaskIds } from '../src/codex-worker-runner.mjs';

it('background task launch returns immediately and deduplicates task id', async () => {
  let resolveRun;
  let calls = 0;
  const run = () => { calls++; return new Promise((resolve) => { resolveRun = resolve; }); };
  const first = launchTaskInBackground('task_bg', run);
  const second = launchTaskInBackground('task_bg', run);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(calls, 1);
  assert.deepEqual(getActiveBackgroundTaskIds(), ['task_bg']);
  resolveRun({ status: 'completed' });
  await first.promise;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(getActiveBackgroundTaskIds(), []);
});
