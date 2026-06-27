import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyTaskCompletion } from '../src/task-acceptance.mjs';

test('verifyTaskCompletion runs discovered npm scripts as npm run <script> commands', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-npm-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    scripts: { test: 'node --version' },
  }), 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });

  const commands = [];
  const verification = await verifyTaskCompletion({
    task: { id: 'task_acceptance_npm', title: 'Acceptance' },
    goal: { id: 'goal_acceptance_npm', title: 'Goal' },
    repoPath,
    resultJson: {
      status: 'completed',
      summary: 'done',
      changed_files: [],
      verification: { passed: true, commands: ['npm run test'] },
    },
    runCommandFn: async (command, opts) => {
      commands.push({ command, cwd: opts.cwd });
      return { cmd: Array.isArray(command) ? command.join(' ') : command, exit_code: 0, stdout_tail: '', stderr_tail: '' };
    },
  });

  assert.equal(verification.passed, true);
  assert.deepEqual(commands.map((entry) => entry.command), ['git diff --check', 'npm run test']);
  assert.ok(commands.every((entry) => entry.cwd === repoPath));
});

test('verifyTaskCompletion fail-closes when completed result lacks verification.passed true', async () => {
  const verification = await verifyTaskCompletion({
    resultJson: {
      status: 'completed',
      summary: 'done',
      changed_files: [],
      verification: { passed: false, commands: [] },
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.equal(verification.status, 'waiting_for_review');
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_failed'));
});

test('verifyTaskCompletion fails when result.json is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const verification = await verifyTaskCompletion({
    resultJsonPath: join(dir, 'result.json'),
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'result_json_invalid'));
});

test('verifyTaskCompletion fails when result.json contains invalid JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resultJsonPath = join(dir, 'result.json');
  await writeFile(resultJsonPath, '{ invalid', 'utf8');

  const verification = await verifyTaskCompletion({
    resultJsonPath,
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'result_json_invalid'));
});

test('verifyTaskCompletion fails when completed result lacks summary', async () => {
  const verification = await verifyTaskCompletion({
    resultJson: { status: 'completed', changed_files: [], verification: { passed: true, commands: [] } },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'summary_missing'));
});

test('verifyTaskCompletion fails when completed result lacks verification object', async () => {
  const verification = await verifyTaskCompletion({
    resultJson: { status: 'completed', summary: 'done', changed_files: ['src/index.js'] },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_missing'));
});

test('verifyTaskCompletion fails when git diff --check fails', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-diffcheck-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  const verification = await verifyTaskCompletion({
    repoPath,
    resultJson: { status: 'completed', summary: 'done', changed_files: ['bad.js'], verification: { passed: true, commands: [] } },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: command === 'git diff --check' ? 1 : 0, stdout_tail: '', stderr_tail: 'trailing whitespace' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.commands.some((command) => command.cmd === 'git diff --check' && command.exit_code === 1));
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_command_failed'));
});

test('verifyTaskCompletion fails when a discovered command fails', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-command-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'node fail.mjs' } }), 'utf8');

  const verification = await verifyTaskCompletion({
    repoPath,
    resultJson: { status: 'completed', summary: 'done', changed_files: ['src/app.mjs'], verification: { passed: true, commands: ['npm run test'] } },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: command === 'npm run test' ? 1 : 0, stdout_tail: '', stderr_tail: 'test failed' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.commands.some((command) => command.cmd === 'npm run test' && command.exit_code === 1));
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_command_failed'));
});

test('verifyTaskCompletion writes verification.json next to result.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resultJsonPath = join(dir, 'result.json');
  await writeFile(resultJsonPath, JSON.stringify({ status: 'completed', summary: 'done', changed_files: [], verification: { passed: true, commands: [] } }), 'utf8');

  const verification = await verifyTaskCompletion({
    resultJsonPath,
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  const written = JSON.parse(await readFile(join(dir, 'verification.json'), 'utf8'));
  assert.equal(written.passed, verification.passed);
  assert.equal(written.status, verification.status);
});

test('verifyTaskCompletion does not fabricate clean git status or commit evidence', async () => {
  const verification = await verifyTaskCompletion({
    resultJson: {
      status: 'completed',
      summary: 'code changed',
      changed_files: ['src/app.mjs'],
      verification: { passed: true, commands: ['npm test'] },
      tests: 'npm test: passed',
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.equal(verification.evidence.git_status, 'unknown');
  assert.equal(verification.evidence.commit_exists, 'unknown');
  assert.ok(verification.findings.some((finding) => finding.code === 'commit_or_patch_missing'));
});

test('verifyTaskCompletion blocks explicit code-change completion without changed_files evidence', async () => {
  const verification = await verifyTaskCompletion({
    task: { id: 'task_code_change_missing_files', mode: 'code_change', changed_files: [] },
    resultJson: {
      status: 'completed',
      summary: 'claims code work',
      changed_files: [],
      tests: 'npm test: passed',
      verification: { passed: true, commands: ['npm test'] },
      commit: 'abc123',
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'changed_files_missing'));
});

test('verifyTaskCompletion blocks admin no-change completion without evidence', async () => {
  const verification = await verifyTaskCompletion({
    task: { id: 'task_admin_no_evidence', mode: 'admin', changed_files: [] },
    resultJson: {
      status: 'completed',
      summary: 'admin done',
      changed_files: [],
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'verification_missing'));
  assert.ok(verification.findings.some((finding) => finding.code === 'profile_evidence_missing'));
});

test('verifyTaskCompletion completes admin no-change task with explicit evidence', async () => {
  const verification = await verifyTaskCompletion({
    task: { id: 'task_admin_evidence', mode: 'admin', changed_files: [] },
    resultJson: {
      status: 'completed',
      summary: 'admin audit completed',
      changed_files: [],
      admin_action: 'retention_status',
      audit_id: 'audit_1',
      tests: 'admin audit evidence recorded',
      verification: { passed: true, commands: [{ cmd: 'retention_status', exit_code: 0 }] },
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, true);
});

test('verifyTaskCompletion blocks restart completion without verified restart evidence', async () => {
  const verification = await verifyTaskCompletion({
    task: { id: 'task_restart_missing_evidence', mode: 'restart', changed_files: [] },
    resultJson: {
      status: 'completed',
      summary: 'restart scheduled',
      changed_files: [],
      verification: { passed: true, commands: [{ cmd: 'schedule_service_restart', exit_code: 0 }] },
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, false);
  assert.ok(verification.findings.some((finding) => finding.code === 'profile_evidence_missing'));
});

test('verifyTaskCompletion completes restart task with verified restart evidence', async () => {
  const verification = await verifyTaskCompletion({
    task: { id: 'task_restart_evidence', mode: 'restart', changed_files: [] },
    resultJson: {
      status: 'completed',
      summary: 'restart verified',
      changed_files: [],
      restart_state: 'verified',
      restart_verified_at: '2026-06-28T00:00:00.000Z',
      post_restart_verified: true,
      verification: { passed: true, commands: [{ cmd: 'safe_restart_phase_c_verify', exit_code: 0 }] },
    },
    config: { discoverVerificationCommands: false },
    runCommandFn: async (command) => ({ cmd: String(command), exit_code: 0, stdout_tail: '', stderr_tail: '' }),
  });

  assert.equal(verification.passed, true);
});
