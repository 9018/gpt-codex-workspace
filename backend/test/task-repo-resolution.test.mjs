import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { resolveTaskRepository } from '../src/task-repo-resolution.mjs';

test('resolveTaskRepository uses explicit task repo_id and returns worktree metadata', async () => {
  const workspaceRoot = '/tmp/gptwork-ws';
  const canonical = '/repos/target';
  const registry = {
    async load() {},
    get(repoId) {
      assert.equal(repoId, 'github.com/acme/target');
      return { repo_id: repoId, canonical_path: canonical };
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
  assert.equal(resolved.lock_repo_path, canonical);
  assert.equal(resolved.uses_default_fallback, false);
  assert.equal(resolved.worktree_lifecycle.mode, 'metadata_only');
  assert.equal(resolved.worktree_lifecycle.git_worktree_created, false);
  assert.equal(resolved.task_worktree_path, join(workspaceRoot, 'worktrees/github.com/acme/target/task_123'));
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

