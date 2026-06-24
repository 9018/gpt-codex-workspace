import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTaskRepository } from '../src/task-repo-resolution.mjs';

async function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'initial\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

test('resolveTaskRepository uses explicit task repo_id and creates a real task worktree by default', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-repo-resolution-'));
  const canonical = join(workspaceRoot, 'target');
  await initGitRepo(canonical);
  const registry = {
    async load() {},
    get(repoId) {
      assert.equal(repoId, 'github.com/acme/target');
      return { repo_id: repoId, canonical_path: canonical, default_branch: 'HEAD' };
    },
  };

  const resolved = await resolveTaskRepository({
    task: { id: 'task_123', repo_id: 'github.com/acme/target' },
    goal: { repo_id: 'github.com/acme/other' },
    config: { defaultWorkspaceRoot: workspaceRoot, defaultRepoPath: '/repos/default' },
    registry,
  });

  assert.equal(resolved.repo_id, 'github.com/acme/target');
  assert.equal(resolved.canonical_repo_path, canonical);
  assert.equal(resolved.lock_repo_path, resolved.task_worktree_path);
  assert.equal(resolved.uses_default_fallback, false);
  assert.equal(resolved.worktree_lifecycle.mode, 'git_worktree');
  assert.equal(resolved.worktree_lifecycle.ok, true);
  assert.equal(resolved.worktree_lifecycle.git_worktree_created, true);
  assert.equal(resolved.worktree_lifecycle.cleanup_supported, true);
  assert.equal(resolved.task_worktree_path, join(workspaceRoot, 'worktrees/github.com-acme-target/task_123'));
});

test('resolveTaskRepository can explicitly disable worktrees for legacy metadata-only callers', async () => {
  const workspaceRoot = '/tmp/gptwork-ws';
  const canonical = '/repos/target';
  const registry = {
    async load() {},
    get(repoId) {
      return { repo_id: repoId, canonical_path: canonical };
    },
  };

  const resolved = await resolveTaskRepository({
    task: { id: 'task_legacy', repo_id: 'github.com/acme/target' },
    goal: {},
    config: { defaultWorkspaceRoot: workspaceRoot, defaultRepoPath: '/repos/default', enableTaskWorktrees: false },
    registry,
  });

  assert.equal(resolved.lock_repo_path, canonical);
  assert.equal(resolved.worktree_lifecycle.mode, 'metadata_only');
  assert.equal(resolved.worktree_lifecycle.git_worktree_created, false);
});

test('resolveTaskRepository falls back to default repo path for single-repo tasks', async () => {
  const resolved = await resolveTaskRepository({
    task: { id: 'task_default' },
    goal: {},
    config: { defaultWorkspaceRoot: '/tmp/ws', defaultRepoPath: '/repos/default' },
    registry: { async load() {}, getDefaultRepo: () => null },
  });

  assert.equal(resolved.repo_id, 'default');
  assert.equal(resolved.canonical_repo_path, '/repos/default');
  assert.equal(resolved.lock_repo_path, '/repos/default');
  assert.equal(resolved.uses_default_fallback, true);
});

test('resolveTaskRepository can use a single registered repo when repo_id is absent', async () => {
  const registry = {
    async load() {},
    getDefaultRepo: () => ({ repo_id: 'github.com/acme/single', canonical_path: '/repos/single' }),
  };

  const resolved = await resolveTaskRepository({
    task: { id: 'task_single' },
    goal: {},
    config: { defaultWorkspaceRoot: '/tmp/ws', defaultRepoPath: '/repos/default' },
    registry,
  });

  assert.equal(resolved.repo_id, 'github.com/acme/single');
  assert.equal(resolved.canonical_repo_path, '/repos/single');
  assert.equal(resolved.uses_default_fallback, false);
});
