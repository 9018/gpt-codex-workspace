import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCodexTaskRun } from '../src/task-run-setup.mjs';

test('prepareCodexTaskRun writes prompt and initializes running heartbeat metadata', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-task-run-setup-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const task = { id: 'task_setup', title: 'Setup task', description: 'Prepare run', workspace_id: 'ws_1' };
  const result = await prepareCodexTaskRun({
    task,
    goal: null,
    workspaceFiles: null,
    workspaceRoot,
    config: {
      defaultWorkspaceRoot: workspaceRoot,
      defaultRepoPath: workspaceRoot,
      codexFirstOutputTimeout: 77,
    },
  });

  const prompt = await readFile(result.promptFile, 'utf8');
  assert.ok(prompt.includes('Setup task'));
  assert.ok(result.runFilePath.endsWith('/run.json'));
  assert.ok(result.runId);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const runData = JSON.parse(await readFile(result.runFilePath, 'utf8'));
  assert.equal(runData.phase, 'running_codex');
  assert.equal(runData.task_id, task.id);
  assert.equal(runData.workspace_id, task.workspace_id);
  assert.equal(runData.prompt_path, result.promptFile);
  assert.equal(runData.first_output_timeout_seconds, 77);
  assert.ok(runData.prompt_bytes > 0);
});

test('prepareCodexTaskRun writes run id back to repo lock immediately', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-task-run-lock-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const calls = [];
  const task = { id: 'task_lock_setup', title: 'Setup task', description: 'Prepare run', workspace_id: 'ws_1' };
  const result = await prepareCodexTaskRun({
    task,
    goal: null,
    workspaceFiles: null,
    workspaceRoot,
    repoLockPath: '/canonical/repo',
    updateRepoLockFn: async (root, repoPath, taskId, fields) => calls.push({ root, repoPath, taskId, fields }),
    config: {
      defaultWorkspaceRoot: workspaceRoot,
      defaultRepoPath: workspaceRoot,
      codexFirstOutputTimeout: 77,
    },
  });

  assert.ok(result.runId);
  assert.deepEqual(calls, [{
    root: workspaceRoot,
    repoPath: '/canonical/repo',
    taskId: 'task_lock_setup',
    fields: { run_id: result.runId },
  }]);
});

test('prepareCodexTaskRun records executionRepoPath in run metadata', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-task-run-worktree-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const task = { id: 'task_worktree_setup', title: 'Setup task', description: 'Prepare run', workspace_id: 'ws_1' };
  const executionRepoPath = join(workspaceRoot, 'worktrees', 'repo', 'task_worktree_setup');
  const result = await prepareCodexTaskRun({
    task,
    goal: null,
    workspaceFiles: null,
    workspaceRoot,
    executionRepoPath,
    config: {
      defaultWorkspaceRoot: workspaceRoot,
      defaultRepoPath: join(workspaceRoot, 'canonical'),
      codexFirstOutputTimeout: 77,
    },
  });

  const runData = JSON.parse(await readFile(result.runFilePath, 'utf8'));
  assert.equal(runData.repo_path, executionRepoPath);
});
