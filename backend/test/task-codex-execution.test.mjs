import test from 'node:test';
import assert from 'node:assert/strict';

import { executeCodexTaskRun } from '../src/task-codex-execution.mjs';

test('executeCodexTaskRun runs codex command, writes logs, heartbeats, and returns parsed summary', async () => {
  const calls = [];
  const result = await executeCodexTaskRun({
    config: {
      codexExecArgs: '--sandbox read-only',
      codexExecTimeout: 120,
      codexFirstOutputTimeout: 33,
      defaultWorkspaceRoot: '/tmp/meta',
    },
    workspaceRoot: '/tmp/repo',
    task: { id: 'task_exec' },
    goal: { id: 'goal_exec' },
    promptFile: '/tmp/prompt.txt',
    runFilePath: '/tmp/run.json',
    runId: 'run_1',
    runLocalShellFn: async (cmd, cwd, timeout, maxBuffer, onPid, options) => {
      calls.push({ type: 'run', cmd, cwd, timeout, maxBuffer });
      onPid(1234);
      options.onOutput({ stdout_bytes: 4, stderr_bytes: 0, first_stdout_at: 'now' });
      return { stdout: 'STATUS=completed\nSUMMARY=ok', stderr: '', returncode: 0, stdout_bytes: 27, stderr_bytes: 0 };
    },
    parseCodexResultFn: async ({ resultJsonPath, stdout }) => {
      calls.push({ type: 'parse', resultJsonPath, stdout });
      return { status: 'completed', summary: 'ok', structured: true };
    },
    writeRunLogsFn: async (args) => calls.push({ type: 'logs', args }),
    fireHeartbeatFn: (path, phase, fields) => calls.push({ type: 'fire', path, phase, fields }),
    updateRunHeartbeatFn: async (path, phase, fields) => calls.push({ type: 'heartbeat', path, phase, fields }),
  });

  assert.equal(result.summary, 'ok');
  assert.equal(result.parsedResult.status, 'completed');
  assert.equal(result.cr.returncode, 0);
  assert.equal(calls.find(c => c.type === 'run').cmd, 'codex exec --sandbox read-only < /tmp/prompt.txt');
  assert.equal(calls.find(c => c.type === 'run').cwd, '/tmp/repo');
  assert.equal(calls.find(c => c.type === 'parse').resultJsonPath, '/tmp/repo/.gptwork/goals/goal_exec/result.json');
  assert.equal(calls.find(c => c.type === 'logs').args.runId, 'run_1');
  assert.ok(calls.some(c => c.type === 'fire' && c.phase === 'parsing_result'));
  assert.ok(calls.some(c => c.type === 'heartbeat' && c.fields.codex_child_pid === 1234));
});

test('executeCodexTaskRun falls back to stdout after separator when parsed summary is empty', async () => {
  const stdout = 'intro\n' + '='.repeat(60) + '\nfinal summary';
  const result = await executeCodexTaskRun({
    config: { codexExecArgs: '', codexExecTimeout: 120, defaultWorkspaceRoot: '/tmp/meta' },
    workspaceRoot: '/tmp/repo',
    task: { id: 'task_exec' },
    goal: null,
    promptFile: '/tmp/prompt.txt',
    runLocalShellFn: async () => ({ stdout, stderr: '', returncode: 0 }),
    parseCodexResultFn: async () => ({}),
  });

  assert.equal(result.summary, '='.repeat(60) + '\nfinal summary');
});
