import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const backendRoot = resolve(import.meta.dirname, '..');
const gateScript = join(backendRoot, 'scripts', 'state-boundary-release-gate.mjs');

test('state boundary release gate reports GO and writes machine-readable report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'state-boundary-gate-'));
  const report = join(dir, 'gate.json');
  const output = execFileSync(process.execPath, [gateScript, '--json-report', report, '--skip-tests'], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  assert.match(output, /STATE_BOUNDARY_GATE: GO/);
  const parsed = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(parsed.verdict, 'GO');
  assert.equal(parsed.checks.every((check) => check.passed), true);
});
