import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyTaskCompletion } from '../src/task-acceptance.mjs';

test('verifyTaskCompletion runs discovered npm scripts as npm run <script> commands', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-npm-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    scripts: { test: 'node --version' },
  }), 'utf8');

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
