import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleListPendingRestarts, handleScheduleServiceRestart } from '../src/restart-tools.mjs';

test('handleListPendingRestarts returns count and markers for an empty workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-restart-tools-'));
  const result = await handleListPendingRestarts({}, { config: { defaultWorkspaceRoot: root } });
  assert.equal(result.count, 0);
  assert.deepEqual(result.markers, []);
});

test('handleScheduleServiceRestart rejects invalid workspace root', async () => {
  const result = await handleScheduleServiceRestart(
    { task_id: 'task_test' },
    { config: { defaultWorkspaceRoot: null, defaultRepoPath: null }, store: null },
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

test('handleScheduleServiceRestart reparses runtime.env and bypasses stale repo workspace validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-restart-runtime-env-'));
  const repoPath = join(root, 'repo');
  const staleBackend = join(root, 'stale-backend');
  const freshBackend = join(repoPath, 'backend');
  await Promise.all([
    mkdir(join(repoPath, '.git'), { recursive: true }),
    mkdir(join(repoPath, '.gptwork'), { recursive: true }),
    mkdir(staleBackend, { recursive: true }),
    mkdir(freshBackend, { recursive: true }),
  ]);
  await writeFile(join(repoPath, '.gptwork', 'runtime.env'), [
    `GPTWORK_WORKSPACE_ROOT=${repoPath}`,
    `GPTWORK_DEFAULT_REPO_PATH=${repoPath}`,
    `GPTWORK_RESTART_CWD=${freshBackend}`,
    'GPTWORK_RESTART_MODE=none',
    '',
  ].join('\n'), 'utf8');

  const result = await handleScheduleServiceRestart(
    { task_id: 'task_runtime_env_restart' },
    {
      config: {
        defaultWorkspaceRoot: repoPath,
        defaultRepoPath: repoPath,
        restartCwd: staleBackend,
        restartMode: 'npm',
      },
      store: null,
    },
  );

  assert.notEqual(result.error, 'workspaceRoot points to a git repository path: ' + repoPath + '. Use the workspace root (e.g. parent of repo), not the repo itself.');
  assert.equal(result.task_id, 'task_runtime_env_restart');
  assert.equal(result.restart_mode, 'none');
  assert.equal(result.restart_cwd, freshBackend);
  assert.equal(result.runtime_env_path, join(repoPath, '.gptwork', 'runtime.env'));
  assert.match(result.workspace_root_validation_warning || '', /git repository path/);
});
