import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { verifyTaskCompletion } from '../src/task-verifier.mjs';

async function makeResultDir(t, resultJson = null) {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-task-verifier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resultJsonPath = join(dir, 'result.json');
  if (resultJson !== null) {
    await writeFile(resultJsonPath, typeof resultJson === 'string' ? resultJson : JSON.stringify(resultJson), 'utf8');
  }
  return { dir, resultJsonPath };
}

function commandRunner(failures = {}) {
  const calls = [];
  const runCommand = async (command, opts) => {
    calls.push({ command, cwd: opts.cwd });
    const failure = failures[command];
    return {
      cmd: command,
      exit_code: failure ? 1 : 0,
      stdout_tail: failure ? '' : `${command} ok`,
      stderr_tail: failure || '',
    };
  };
  return { calls, runCommand };
}

test('verifyTaskCompletion passes, writes verification.json, and records discovered checks', async (t) => {
  const { dir, resultJsonPath } = await makeResultDir(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }), 'utf8');
  const { calls, runCommand } = commandRunner();
  const resultJson = {
    status: 'completed',
    summary: 'done',
    changed_files: ['backend/src/example.mjs'],
    verification: { passed: true },
  };

  const verification = await verifyTaskCompletion({
    task: { id: 'task_ok' },
    goal: { id: 'goal_ok' },
    repoPath: dir,
    resultJson,
    resultJsonPath,
    workspaceFiles: [],
    config: {
      runCommand,
      now: () => '2026-06-29T01:02:03.000Z',
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.timestamp, '2026-06-29T01:02:03.000Z');
  assert.deepEqual(verification.changed_files, ['backend/src/example.mjs']);
  assert.equal(verification.reason_no_tests, null);
  assert.deepEqual(calls.map((call) => call.command), ['git diff --check', 'npm run test']);
  assert.ok(calls.every((call) => call.cwd === dir));

  const written = JSON.parse(await readFile(join(dir, 'verification.json'), 'utf8'));
  assert.deepEqual(written, verification);
});

test('verifyTaskCompletion fails and writes verification.json when result data is missing', async (t) => {
  const { dir, resultJsonPath } = await makeResultDir(t);
  const { runCommand } = commandRunner();

  const verification = await verifyTaskCompletion({
    repoPath: dir,
    resultJsonPath,
    config: { runCommand, verificationCommands: [], now: () => '2026-06-29T01:02:03.000Z' },
  });

  assert.equal(verification.passed, false);
  assert.equal(verification.reason_no_tests, 'No project verification commands were available.');
  assert.ok(verification.findings.some((finding) => finding.code === 'result_json_missing'));

  const written = JSON.parse(await readFile(join(dir, 'verification.json'), 'utf8'));
  assert.equal(written.passed, false);
});

test('verifyTaskCompletion fails invalid result data without running project checks', async (t) => {
  const { dir, resultJsonPath } = await makeResultDir(t, '{ invalid json');
  const { calls, runCommand } = commandRunner();

  const verification = await verifyTaskCompletion({
    repoPath: dir,
    resultJsonPath,
    config: { runCommand, verificationCommands: ['npm test'] },
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'result_json_invalid'));
  assert.deepEqual(calls.map((call) => call.command), ['git diff --check']);
});

test('verifyTaskCompletion fails when a command check errors', async (t) => {
  const { dir, resultJsonPath } = await makeResultDir(t);
  const { runCommand } = commandRunner({ 'git diff --check': 'trailing whitespace' });

  const verification = await verifyTaskCompletion({
    repoPath: dir,
    resultJson: { status: 'completed', summary: 'done', changed_files: ['bad.mjs'], verification: { passed: true } },
    resultJsonPath,
    config: { runCommand, verificationCommands: ['npm test'] },
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.commands.some((command) => command.cmd === 'git diff --check' && command.exit_code === 1));
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_command_failed'));
});

test('verifyTaskCompletion passes with git diff fallback when no project checks exist', async (t) => {
  const { dir, resultJsonPath } = await makeResultDir(t);
  const { calls, runCommand } = commandRunner();

  const verification = await verifyTaskCompletion({
    repoPath: dir,
    resultJson: { status: 'completed', summary: 'docs done', changed_files: [], verification: { passed: true } },
    resultJsonPath,
    config: { runCommand, verificationCommands: [] },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.reason_no_tests, 'No project verification commands were available.');
  assert.deepEqual(calls.map((call) => call.command), ['git diff --check']);
});
