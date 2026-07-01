import test from 'node:test';
import assert from 'node:assert/strict';

import { executeCodexTaskRun, isCodexContentfulOutput } from '../src/task-codex-execution.mjs';

test('isCodexContentfulOutput ignores Codex banner and prompt echo but accepts activity', () => {
  assert.equal(isCodexContentfulOutput({ streamName: 'stderr', chunk: 'Reading prompt from stdin...\nOpenAI Codex v0.142.0\nmodel: x\nuser\n# Task: Demo\n' }), false);
  assert.equal(isCodexContentfulOutput({ streamName: 'stderr', chunk: 'assistant\nI will inspect the code\n' }), true);
  assert.equal(isCodexContentfulOutput({ streamName: 'stderr', chunk: 'exec sed -n 1,20p file.js\n' }), true);
  assert.equal(isCodexContentfulOutput({ streamName: 'stdout', chunk: 'STATUS=completed\n' }), true);
});

test('executeCodexTaskRun runs codex command, streams logs, heartbeats, and returns parsed summary', async () => {
  // P0: Isolate from process.env so resolveCodexExecArgs uses config values
  const _origCodexArgs = process.env.GPTWORK_CODEX_EXEC_ARGS;
  delete process.env.GPTWORK_CODEX_EXEC_ARGS;
  const calls = [];
  const result = await executeCodexTaskRun({
    config: {
      codexExecArgs: '--sandbox read-only',
      codexExecTimeout: 120,
      codexFirstOutputTimeout: 33,
      codexContentFirstOutputTimeout: 44,
      codexNoProgressTimeout: 55,
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
      options.onOutput({ stdout_bytes: 4, stderr_bytes: 0, first_stdout_at: 'now', content_first_output_at: 'content-now', content_first_output_delay_ms: 10, last_content_progress_at: 'content-now' });
      return { stdout: 'STATUS=completed\nSUMMARY=ok', stderr: '', returncode: 0, stdout_bytes: 27, stderr_bytes: 0, content_first_output_at: 'content-now', content_first_output_delay_ms: 10, last_content_progress_at: 'content-now' };
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
  assert.equal(runCall.options.contentFirstOutputTimeoutSeconds, 44);
  assert.equal(runCall.options.noProgressTimeoutSeconds, 55);
  assert.equal(typeof runCall.options.isContentfulOutput, 'function');
  assert.equal(calls.some(c => c.type === 'logs'), false, 'streamed logs must not be appended again after run completion');
  assert.ok(calls.some(c => c.type === 'fire' && c.phase === 'parsing_result' && c.fields.content_first_output_at === 'content-now'));
  assert.ok(calls.some(c => c.type === 'heartbeat' && c.fields.codex_child_pid === 1234));
  // Restore process.env
  if (_origCodexArgs !== undefined) process.env.GPTWORK_CODEX_EXEC_ARGS = _origCodexArgs;
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

test('executeCodexTaskRun uses task worktree cwd and writes child pid to repo lock', async () => {
  const calls = [];
  const result = await executeCodexTaskRun({
    config: { defaultWorkspaceRoot: '/workspace', codexExecArgs: '', codexExecTimeout: 5 },
    workspaceRoot: '/workspace',
    executionCwd: '/workspace/.gptwork/worktrees/repo/task_1',
    task: { id: 'task_1' },
    goal: { id: 'goal_1' },
    promptFile: '/tmp/prompt.txt',
    runFilePath: '/runs/run.json',
    runId: 'run_1',
    repoLockPath: '/canonical/repo',
    updateRepoLockFn: async (workspaceRoot, repoPath, taskId, fields) => {
      calls.push({ type: 'lock', workspaceRoot, repoPath, taskId, fields });
    },
    runLocalShellFn: async (cmd, cwd, timeout, maxBuffer, onPid) => {
      calls.push({ type: 'shell', cmd, cwd, timeout, maxBuffer });
      onPid(4321);
      return { stdout: 'STATUS=completed\nSUMMARY=ok', stderr: '', returncode: 0 };
    },
    parseCodexResultFn: async () => ({ status: 'completed', summary: 'ok', structured: true }),
    writeRunLogsFn: async () => {},
    fireHeartbeatFn: () => {},
    updateRunHeartbeatFn: async () => {},
  });

  assert.equal(result.summary, 'ok');
  assert.equal(calls.find((call) => call.type === 'shell').cwd, '/workspace/.gptwork/worktrees/repo/task_1');
  assert.deepEqual(calls.find((call) => call.type === 'lock'), {
    type: 'lock',
    workspaceRoot: '/workspace',
    repoPath: '/canonical/repo',
    taskId: 'task_1',
    fields: { child_pid: 4321 },
  });
});
