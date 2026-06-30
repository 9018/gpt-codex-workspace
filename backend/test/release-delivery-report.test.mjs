import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function tempReportPath(t, name = 'release-check.json') {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-release-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'nested', name);
}

test('release-delivery-check --json-report writes passed fast report', { timeout: 60_000 }, async (t) => {
  const reportPath = await tempReportPath(t);
  const result = await execFileAsync(process.execPath, [
    'scripts/release-delivery-check.mjs',
    '--profile', 'changed',
    '--base', 'HEAD',
    '--json-report', reportPath,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 55_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  assert.match(result.stdout, /json report:/);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.schema_version, 1);
  assert.equal(report.passed, true);
  assert.equal(report.mode, 'changed');
  assert.equal(report.profile, 'docs');
  assert.ok(report.started_at);
  assert.ok(report.completed_at);
  assert.equal(typeof report.duration_ms, 'number');
  assert.equal(typeof report.repo.head, 'string');
  assert.equal(typeof report.repo.dirty, 'boolean');
  assert.ok(report.steps.length >= 1);
  assert.equal(report.failures.length, 0);
});

test('release-delivery-check writes failed report when a step fails', { timeout: 20_000 }, async (t) => {
  const reportPath = await tempReportPath(t, 'failed.json');
  const binDir = await mkdtemp(join(tmpdir(), 'gptwork-release-report-bin-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const npmPath = join(binDir, 'npm');
  await writeFile(npmPath, '#!/bin/sh\necho forced npm failure >&2\nexit 7\n', 'utf8');
  await chmod(npmPath, 0o755);

  await assert.rejects(
    execFileAsync(process.execPath, [
      'scripts/release-delivery-check.mjs',
      '--profile', 'changed',
      '--base', 'HEAD',
      '--json-report', reportPath,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.steps.some((step) => step.name === 'check:imports' && step.passed === false), true);
  assert.equal(typeof report.repo.head, 'string');
  assert.equal(typeof report.duration_ms, 'number');
});
