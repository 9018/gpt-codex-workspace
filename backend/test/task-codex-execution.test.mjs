import test from 'node:test';
import assert from 'node:assert/strict';

import { executeCodexTaskRun } from '../src/task-codex-execution.mjs';

test('executeCodexTaskRun runs codex command, streams logs, heartbeats, and returns parsed summary', async () => {
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
      calls.push({ type: 'run', cmd, cwd, timeout, maxBuffer, options });
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
  assert.equal(calls.find(c => c.type === 'run').cmd, 'codex exec --sandbox read-only --output-last-message /tmp/repo/.gptwork/tmp/codex-lastmsg-task_exec.txt < /tmp/prompt.txt');
  assert.equal(calls.find(c => c.type === 'run').cwd, '/tmp/repo');
  assert.equal(calls.find(c => c.type === 'parse').resultJsonPath, '/tmp/repo/.gptwork/goals/goal_exec/result.json');
  const runCall = calls.find(c => c.type === 'run');
  assert.equal(runCall.options.streamStdoutPath, '/tmp/repo/.gptwork/runs/task_exec/run_1/stdout.log');
  assert.equal(runCall.options.streamStderrPath, '/tmp/repo/.gptwork/runs/task_exec/run_1/stderr.log');
  assert.equal(calls.some(c => c.type === 'logs'), false, 'streamed logs must not be appended again after run completion');
  assert.ok(calls.some(c => c.type === 'fire' && c.phase === 'parsing_result'));
  assert.ok(calls.some(c => c.type === 'heartbeat' && c.fields.codex_child_pid === 1234));
});


test('executeCodexTaskRun writes buffered logs when streaming paths are unavailable', async () => {
  const calls = [];
  await executeCodexTaskRun({
    config: {
      codexExecArgs: '--sandbox read-only',
      codexExecTimeout: 120,
      codexFirstOutputTimeout: 33,
      defaultWorkspaceRoot: '/tmp/meta',
    },
    workspaceRoot: '',
    task: { id: 'task_exec' },
    goal: null,
    promptFile: '/tmp/prompt.txt',
    runId: 'run_1',
    runLocalShellFn: async () => ({ stdout: 'STATUS=completed\nSUMMARY=ok', stderr: 'warn', returncode: 0 }),
    parseCodexResultFn: async () => ({ status: 'completed', summary: 'ok', structured: true }),
    writeRunLogsFn: async (args) => calls.push({ type: 'logs', args }),
    updateRunHeartbeatFn: async () => {},
  });

  const logCall = calls.find(c => c.type === 'logs');
  assert.ok(logCall, 'buffered logs should be written when streaming paths are not available');
  assert.equal(logCall.args.runId, 'run_1');
  assert.equal(logCall.args.stdout, 'STATUS=completed\nSUMMARY=ok');
  assert.equal(logCall.args.stderr, 'warn');
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
