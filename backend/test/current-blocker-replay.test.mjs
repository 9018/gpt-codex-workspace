import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { classifyCurrentBlockerTask } from '../src/current-blocker-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'current-blocker-replay.json');
const replayCases = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('current-blocker replay fixture is non-empty and names each case', () => {
  assert.equal(Array.isArray(replayCases), true);
  assert.equal(replayCases.length >= 10, true);
  for (const replayCase of replayCases) {
    assert.equal(typeof replayCase.name, 'string');
    assert.notEqual(replayCase.name.trim(), '');
    assert.equal(typeof replayCase.expected, 'object');
  }
});

test('current-blocker replay classifies representative task record shapes', () => {
  for (const replayCase of replayCases) {
    assert.deepEqual(
      classifyCurrentBlockerTask(replayCase.task),
      replayCase.expected,
      replayCase.name,
    );
  }
});
