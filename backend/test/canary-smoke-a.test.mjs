import assert from 'node:assert/strict';
import test from 'node:test';

test('canary smoke A passes', () => {
  assert.equal('canary-smoke-a', 'canary-smoke-a');
});
