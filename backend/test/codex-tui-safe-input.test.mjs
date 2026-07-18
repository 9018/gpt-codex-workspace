import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTuiText } from '../src/codex-tui/tui-safe-input.mjs';

test('submitTuiText clears stale content, writes ordered chunks, then submits', async () => {
  const writes = [];
  await submitTuiText({ write: (text) => writes.push(text) }, '/goal goal_id=goal_1\ntask=demo', {
    sleep_fn: async () => {}, chunk_size: 10,
  });
  assert.equal(writes[0], '\u0015');
  assert.equal(writes.at(-1), '\r');
  assert.equal(writes.slice(1, -1).join(''), '/goal goal_id=goal_1\ntask=demo');
});
