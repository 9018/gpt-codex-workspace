import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskWorktree, removeTaskWorktree } from '../src/worktree-service.mjs';

async function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'initial\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

test('worktree-service creates three ordinary task worktrees with distinct branches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-worktree-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRepoPath = join(root, 'canonical');
  await initGitRepo(canonicalRepoPath);

  const tasks = ['task_a', 'task_b', 'task_c'];
  const created = [];
  for (const taskId of tasks) {
    created.push(await createTaskWorktree({
      task_id: taskId,
      repo_id: 'github.com/acme/repo',
      workspaceRoot: root,
      canonicalRepoPath,
      baseRef: 'HEAD',
    }));
  }

  assert.equal(created.length, 3);
  assert.equal(new Set(created.map((entry) => entry.worktree.path)).size, 3);
  assert.equal(new Set(created.map((entry) => entry.worktree.branch)).size, 3);

  for (let i = 0; i < tasks.length; i++) {
    const entry = created[i];
    assert.equal(entry.ok, true);
    assert.equal(entry.worktree.enabled, true);
    assert.equal(entry.worktree.status, 'created');
    assert.equal(entry.worktree.branch, `gptwork/task/${tasks[i]}`);
    assert.ok(existsSync(join(entry.worktree.path, '.git')));
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: entry.worktree.path,
      encoding: 'utf8',
    }).trim();
    assert.equal(branch, `gptwork/task/${tasks[i]}`);
  }

  for (const taskId of tasks) {
    const removed = await removeTaskWorktree({
      task_id: taskId,
      repo_id: 'github.com/acme/repo',
      workspaceRoot: root,
      canonicalRepoPath,
    });
    assert.equal(removed.ok, true);
  }
});
