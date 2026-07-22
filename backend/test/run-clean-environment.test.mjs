import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCleanTestEnvironment } from './helpers/run-clean-environment.mjs';

test('buildCleanTestEnvironment isolates HOME and temp directories under the run root', () => {
  const env = buildCleanTestEnvironment('/tmp/gptwork-test-run-abc', {
    HOME: '/home/real-user',
    CODEX_HOME: '/home/real-user/.codex',
    GPTWORK_CODEX_HOME: '/custom/codex',
    PATH: '/usr/bin',
  });

  assert.equal(env.HOME, join('/tmp/gptwork-test-run-abc', 'home'));
  assert.equal(env.TMPDIR, '/tmp/gptwork-test-run-abc');
  assert.equal(env.TEMP, '/tmp/gptwork-test-run-abc');
  assert.equal(env.TMP, '/tmp/gptwork-test-run-abc');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal('CODEX_HOME' in env, false);
  assert.equal('GPTWORK_CODEX_HOME' in env, false);
});
